const
  PackageKey = 'Software\Anyswitch\WindowsPackage';
  DriveFixed = 3;
  AttrReparsePoint = $400;
  AttrDirectory = $10;
  InvalidAttributes = $FFFFFFFF;
  MoveReplaceExisting = 1;
  MoveWriteThrough = 8;

var
  RemoveSettings: Boolean;
  // LoadStringFromFile 的 var 形参是 AnsiString（引擎类型检查按精确匹配），这里必须同型。
  PreviousCurrent: AnsiString;
  HadCurrent: Boolean;
  PointerChanged: Boolean;
  FilesInstalled: Boolean;
  RegistryWritten: Boolean;
  SetupComplete: Boolean;
  InstallRootValue: String;
  EnvRootValue: String;
  HadInstallRoot: Boolean;
  UninstallResidueRoot: String;

function GetDriveType(RootPath: String): LongWord;
  external 'GetDriveTypeW@kernel32.dll stdcall';
function GetFileAttributes(FileName: String): LongWord;
  external 'GetFileAttributesW@kernel32.dll stdcall';
function MoveFileEx(OldPath, NewPath: String; Flags: LongWord): Boolean;
  external 'MoveFileExW@kernel32.dll stdcall';

// Inno 的脚本引擎不暴露 SysUtils 的 BoolToStr，布尔基线按读侧口径写 'True'/'False'。
function BoolText(Value: Boolean): String;
begin
  if Value then Result := 'True' else Result := 'False';
end;

function NormalPath(Path: String): String;
begin
  Result := RemoveBackslashUnlessRoot(ExpandFileName(Path));
end;

function IsWithin(Path, Parent: String): Boolean;
var
  Prefix: String;
begin
  Prefix := AddBackslash(Parent);
  Result := (CompareText(Path, Parent) = 0) or
    (CompareText(Copy(Path, 1, Length(Prefix)), Prefix) = 0);
end;

function HasReparseAncestor(Path: String): Boolean;
var
  Attr: LongWord;
  Parent: String;
begin
  Result := True;
  while Path <> '' do begin
    Attr := GetFileAttributes(Path);
    if (Attr <> InvalidAttributes) and ((Attr and AttrReparsePoint) <> 0) then Exit;
    Parent := ExtractFileDir(Path);
    if Parent = Path then Break;
    Path := Parent;
  end;
  Result := False;
end;

function IsEmptyFolder(Path: String): Boolean;
var
  Entry: TFindRec;
begin
  Result := True;
  if FindFirst(AddBackslash(Path) + '*', Entry) then begin
    try
      repeat
        if (Entry.Name <> '.') and (Entry.Name <> '..') then begin
          Result := False;
          Exit;
        end;
      until not FindNext(Entry);
    finally
      FindClose(Entry);
    end;
  end;
end;

// 返回是否删净：目标本就不在视为已净（RemoveDir 对不存在路径报失败，不能据此误判）；
// 任何一项删不掉（占用等）返回 False。reparse 防护性跳过不算失败——那是刻意保留。
// 定义须在 ValidateInstallRoot 之前：Inno Pascal 不支持前置声明。
function DeleteOwnedTree(Path: String): Boolean;
var
  Entry: TFindRec;
  Child: String;
begin
  Result := True;
  if HasReparseAncestor(Path) then Exit;
  if FindFirst(AddBackslash(Path) + '*', Entry) then begin
    try
      repeat
        if (Entry.Name <> '.') and (Entry.Name <> '..') then begin
          Child := AddBackslash(Path) + Entry.Name;
          if (Entry.Attributes and AttrDirectory) <> 0 then begin
            if not DeleteOwnedTree(Child) then Result := False;
          end else if not HasReparseAncestor(Child) then begin
            if not DeleteFile(Child) then Result := False;
          end;
        end;
      until not FindNext(Entry);
    finally
      FindClose(Entry);
    end;
  end;
  if DirExists(Path) and not RemoveDir(Path) then Result := False;
end;

// 卸载末尾的占用残留指引只报一个根：先记先赢，调用顺序即优先级（安装根残留
// 阻断重装，排在数据根之前）。
procedure NoteUninstallResidue(Path: String);
begin
  if UninstallResidueRoot = '' then UninstallResidueRoot := Path;
end;

// 卸载专用的整树删除：删不净时记一笔残留，供末尾统一指引。安装期调用方
// （ValidateInstallRoot / DeinitializeSetup）直接用 DeleteOwnedTree 的返回值。
procedure UninstallDeleteOwnedTree(Path: String);
begin
  if not DeleteOwnedTree(Path) then NoteUninstallResidue(Path);
end;

function ValidateInstallRoot(Path: String): String;
var
  Root, DataRoot, GitRoot, PriorRoot, VersionTree, ActiveText: String;
  HadPriorRoot: Boolean;
  // LoadStringFromFile 的 var 形参是 AnsiString（同上方 PreviousCurrent 的口径）。
  ActiveCurrent: AnsiString;
begin
  Result := 'Choose a dedicated installation folder on a local fixed drive.';
  if (Length(Path) < 4) or (Copy(Path, 2, 2) <> ':\') or (Pos(':', Copy(Path, 3, Length(Path))) > 0) then Exit;
  Root := NormalPath(Path);
  if (Length(Root) <= 3) or (GetDriveType(ExtractFileDrive(Root) + '\') <> DriveFixed) or HasReparseAncestor(Root) then Exit;
  DataRoot := NormalPath(ExpandConstant('{localappdata}\Anyswitch'));
  GitRoot := NormalPath(ExpandConstant('{localappdata}\Anyswitch-git'));
  if IsWithin(Root, DataRoot) or IsWithin(DataRoot, Root) or IsWithin(Root, GitRoot) or IsWithin(GitRoot, Root) then Exit;
  HadPriorRoot := RegQueryStringValue(HKCU, PackageKey, 'InstallRoot', PriorRoot);
  if HadPriorRoot then begin
    Result := 'Use the existing Anyswitch installation folder.';
    if CompareText(Root, NormalPath(PriorRoot)) <> 0 then Exit;
  end;
  Result := 'Anyswitch cannot use this installation folder.';
  if HasReparseAncestor(Root + '\versions') or HasReparseAncestor(Root + '\current.json') or
     (GetFileAttributes(Root + '\current.json.setup') <> InvalidAttributes) then Exit;
  // 同版本目录在＝上次安装或卸载留了残，给一次确认清理的机会；但指针仍指向本版本
  // 时那是在用的活动版本而非残留，维持硬拒（清理会删活版本）。清理失败（占用等）
  // 或防护性跳过后目录仍在，同样维持拒绝。清理后顺手收掉空的 versions 壳目录，
  // 否则下方空目录闸仍会被它拦住。
  VersionTree := Root + '\versions\{#ReleaseVersion}';
  if GetFileAttributes(VersionTree) <> InvalidAttributes then begin
    Result := 'This version is already present in the installation folder.';
    ActiveText := '';
    if LoadStringFromFile(Root + '\current.json', ActiveCurrent) then ActiveText := ActiveCurrent;
    if Pos('"version":"{#ReleaseVersion}"', ActiveText) > 0 then Exit;
    if MsgBox('A leftover from a previous incomplete installation of this version was found. Remove it and continue?', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) <> IDYES then Exit;
    if not DeleteOwnedTree(VersionTree) then Exit;
    if GetFileAttributes(VersionTree) <> InvalidAttributes then Exit;
    RemoveDir(Root + '\versions');
  end;
  if not HadPriorRoot then begin
    Result := 'Choose an empty folder for Anyswitch.';
    if DirExists(Root) and not IsEmptyFolder(Root) then Exit;
  end;
  Result := '';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Problem: String;
begin
  Result := True;
  if CurPageID <> wpSelectDir then Exit;
  Problem := ValidateInstallRoot(WizardDirValue);
  if Problem <> '' then begin
    MsgBox(Problem, mbError, MB_OK);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Exe: String;
  Code: Integer;
begin
  Result := ValidateInstallRoot(WizardDirValue);
  if (Result = '') and FileExists(ExpandConstant('{localappdata}\Anyswitch\app\package.json')) then
    Log('Existing source installation detected. Source and data are retained.');
  Exe := AddBackslash(WizardDirValue) + 'Anyswitch.exe';
  if (Result = '') and FileExists(Exe) then begin
    if not Exec(Exe, '--shutdown', WizardDirValue, SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
      Result := 'Anyswitch cannot use this installation folder.';
  end;
end;

function HasWebView2: Boolean;
var
  Version: String;
  Key: String;
begin
  Key := 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  Result := (RegQueryStringValue(HKLM32, Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0')) or
            (RegQueryStringValue(HKCU, Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0'));
end;

procedure PrepareWebView2;
var
  Code: Integer;
begin
  if HasWebView2 then Exit;
  ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
  if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
    Log('WebView2 is unavailable; the panel can still open in the browser.');
end;

function CheckCandidate: Boolean;
var
  VersionRoot, AppDir, Node: String;
  Code: Integer;
begin
  VersionRoot := ExpandConstant('{app}\versions\{#ReleaseVersion}');
  AppDir := VersionRoot + '\app';
  Node := VersionRoot + '\runtime\node.exe';
  Result := Exec(Node, '"' + AppDir + '\package-health.mjs" "{#ReleaseVersion}"', AppDir, SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

function PrepareRegistryOwnership(Root: String): Boolean;
var
  OwnerRoot, BaselineInstallRoot, BaselineEnvRoot: String;
  HadBaselineInstallRoot, HadBaselineEnvRoot: Boolean;
begin
  Result := False;
  if RegQueryStringValue(HKCU, PackageKey, 'ManagedInstallRoot', OwnerRoot) then begin
    if CompareText(NormalPath(OwnerRoot), NormalPath(Root)) <> 0 then Exit;
    Result := True;
    Exit;
  end;
  if RegQueryStringValue(HKCU, PackageKey, 'InstallRoot', BaselineInstallRoot) and
     (CompareText(NormalPath(BaselineInstallRoot), NormalPath(Root)) <> 0) then Exit;
  HadBaselineInstallRoot := RegQueryStringValue(HKCU, PackageKey, 'InstallRoot', BaselineInstallRoot);
  HadBaselineEnvRoot := RegQueryStringValue(HKCU, 'Environment', 'ANYSWITCH_INSTALL_ROOT', BaselineEnvRoot);
  RegWriteStringValue(HKCU, PackageKey, 'PreviousInstallRoot', BaselineInstallRoot);
  RegWriteStringValue(HKCU, PackageKey, 'PreviousEnvRoot', BaselineEnvRoot);
  RegWriteStringValue(HKCU, PackageKey, 'HadPreviousInstallRoot', BoolText(HadBaselineInstallRoot));
  RegWriteStringValue(HKCU, PackageKey, 'HadPreviousEnvRoot', BoolText(HadBaselineEnvRoot));
  RegWriteStringValue(HKCU, PackageKey, 'ManagedInstallRoot', Root);
  // 仅实际写盘分支置位：上方的早退分支（同名托管锁直通、异根基线拒绝）未动注册表，
  // 置位会让 DeinitializeSetup 误回滚别人持有的托管锁。
  RegistryWritten := True;
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Root, Pending, VersionRoot: String;
  Code: Integer;
begin
  if CurStep = ssPostInstall then begin
    Root := ExpandConstant('{app}');
    FilesInstalled := True;
    if not CheckCandidate then RaiseException('Anyswitch did not pass its installation check. The previous version remains active.');
    PrepareWebView2;
    if not PrepareRegistryOwnership(Root) then RaiseException('Anyswitch cannot replace a different registered installation.');
    HadCurrent := LoadStringFromFile(Root + '\current.json', PreviousCurrent);
    Pending := Root + '\current.json.setup';
    if not SaveStringToFile(Pending, '{"schema":1,"version":"{#ReleaseVersion}"}', False) or
       not MoveFileEx(Pending, Root + '\current.json', MoveReplaceExisting or MoveWriteThrough) then begin
      DeleteFile(Pending);
      RaiseException('Anyswitch could not activate this version. The previous version remains active.');
    end;
    PointerChanged := True;
    RegWriteStringValue(HKCU, PackageKey, 'InstallRoot', Root);
    RegWriteStringValue(HKCU, 'Environment', 'ANYSWITCH_INSTALL_ROOT', Root);
    VersionRoot := Root + '\versions\{#ReleaseVersion}';
    if not Exec(VersionRoot + '\runtime\node.exe', '"' + VersionRoot + '\app\src\ops\desktop-lifecycle.mjs" migrate', VersionRoot + '\app', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
      RaiseException('Anyswitch did not pass its installation check. The previous version remains active.');
    SetupComplete := True;
  end;
end;

function InitializeUninstall: Boolean;
var
  Root: String;
  Code: Integer;
begin
  Root := ExpandConstant('{app}');
  if FileExists(Root + '\Anyswitch.exe') then begin
    if not Exec(Root + '\Anyswitch.exe', '--shutdown', Root, SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then begin
      Result := False;
      Exit;
    end;
  end;
  RemoveSettings := False;
  if not UninstallSilent then
    RemoveSettings := MsgBox('Also delete Anyswitch settings, stored credentials and backups? The source installation and its Git history will be kept.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
  Result := True;
end;

procedure DeleteOwnedFile(Root, Name: String);
var
  Path: String;
begin
  Path := Root + '\' + Name;
  if HasReparseAncestor(Path) then Exit;
  // 目标本就不在不算失败（DeleteFile 对缺失文件报失败，不能据此误报残留）；
  // 占用等删不掉时记残留根，供卸载末尾统一指引。
  if FileExists(Path) and not DeleteFile(Path) then NoteUninstallResidue(Root);
end;

procedure RestoreOwnedRegistry(Root: String);
var
  Current, HadPrevious: String;
begin
  if not RegQueryStringValue(HKCU, PackageKey, 'ManagedInstallRoot', HadPrevious) or
     (CompareText(NormalPath(HadPrevious), NormalPath(Root)) <> 0) then Exit;
  if RegQueryStringValue(HKCU, PackageKey, 'InstallRoot', Current) and
     (CompareText(NormalPath(Current), NormalPath(Root)) = 0) then begin
    if RegQueryStringValue(HKCU, PackageKey, 'HadPreviousInstallRoot', HadPrevious) and (HadPrevious = 'True') then begin
      if RegQueryStringValue(HKCU, PackageKey, 'PreviousInstallRoot', InstallRootValue) then RegWriteStringValue(HKCU, PackageKey, 'InstallRoot', InstallRootValue);
    end else RegDeleteValue(HKCU, PackageKey, 'InstallRoot');
  end;
  if RegQueryStringValue(HKCU, 'Environment', 'ANYSWITCH_INSTALL_ROOT', Current) and
     (CompareText(NormalPath(Current), NormalPath(Root)) = 0) then begin
    if RegQueryStringValue(HKCU, PackageKey, 'HadPreviousEnvRoot', HadPrevious) and (HadPrevious = 'True') then begin
      if RegQueryStringValue(HKCU, PackageKey, 'PreviousEnvRoot', EnvRootValue) then RegWriteStringValue(HKCU, 'Environment', 'ANYSWITCH_INSTALL_ROOT', EnvRootValue);
    end else RegDeleteValue(HKCU, 'Environment', 'ANYSWITCH_INSTALL_ROOT');
  end;
  RegDeleteValue(HKCU, PackageKey, 'ManagedInstallRoot');
  RegDeleteValue(HKCU, PackageKey, 'PreviousInstallRoot');
  RegDeleteValue(HKCU, PackageKey, 'PreviousEnvRoot');
  RegDeleteValue(HKCU, PackageKey, 'HadPreviousInstallRoot');
  RegDeleteValue(HKCU, PackageKey, 'HadPreviousEnvRoot');
end;

procedure DeinitializeSetup;
var
  Root, Pending: String;
  NowCurrent: AnsiString;
  NowText: String;
begin
  if SetupComplete then Exit;
  Root := ExpandConstant('{app}');
  // 补偿回滚按「指针 → 注册表 → 版本树」收：指针先回旧版本（或删除），注册表
  // 基线再还原，最后只在 current.json 未指向本次版本时清掉已装的版本树——
  // 指针回滚失败时版本树仍是活动版本，不能删。
  if PointerChanged then begin
    Pending := Root + '\current.json.rollback';
    if HadCurrent then begin
      if SaveStringToFile(Pending, PreviousCurrent, False) then
        MoveFileEx(Pending, Root + '\current.json', MoveReplaceExisting or MoveWriteThrough);
    end else DeleteFile(Root + '\current.json');
  end;
  if RegistryWritten then RestoreOwnedRegistry(Root);
  if FilesInstalled then begin
    NowText := '';
    if LoadStringFromFile(Root + '\current.json', NowCurrent) then NowText := NowCurrent;
    if Pos('"version":"{#ReleaseVersion}"', NowText) = 0 then
      DeleteOwnedTree(Root + '\versions\{#ReleaseVersion}');
  end;
end;

procedure UnregisterOwnedTasks(Root: String);
var
  Params: String;
  Code: Integer;
begin
  // 同机源码安装也注册同名任务（Exec 指源码树 silent-start.vbs）：只注销
  // Actions[0].Arguments 含本安装根的任务，其余保留。子串命中后还须过前缀边界
  // （命中点之后是路径分隔符或串尾才算），防 C:\Anyswitch 误伤 C:\Anyswitch-src。
  // 失败静默——卸载不可因清理失败而失败。
  Params := '-NoProfile -NonInteractive -Command "$r=(Get-Location).ProviderPath.ToLowerInvariant();' +
    'foreach($n in @(''AnyswitchRelay'',''AnyswitchWatchdog'',''AnyswitchPanel'',''ApiCredRelay'',''ApiCredWatchdog'')){' +
    'try{$t=Get-ScheduledTask -TaskName $n -ErrorAction Stop;$a=$t.Actions[0].Arguments;' +
    'if($t.Actions[0].Execute -ieq ($r+''\Anyswitch.exe'') -and $a -eq ''--tray''){' +
    'Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction Stop;continue};' +
    'if($a){$al=$a.ToLower();$i=$al.IndexOf($r);' +
    'if($i -ge 0 -and ($i+$r.Length -eq $al.Length -or $al[$i+$r.Length] -eq ''\'')){' +
    'Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction Stop}}}catch{}}"';
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, Root, SW_HIDE, ewWaitUntilTerminated, Code);
end;

// 前缀边界：命中点之后必须是路径分隔符或串尾，防 C:\Anyswitch 误伤
// C:\Anyswitch-src。只验首个命中——病态的多根参数宁肯不删（读回校验整体保守）。
function PathMentionsRoot(Haystack, LowerRoot: String): Boolean;
var
  Hit: Integer;
  Lower: String;
begin
  Result := False;
  Lower := Lowercase(Haystack);
  Hit := Pos(LowerRoot, Lower);
  if Hit = 0 then Exit;
  Hit := Hit + Length(LowerRoot);
  if Hit > Length(Lower) then begin Result := True; Exit; end;
  Result := (Lower[Hit] = '\') or (Lower[Hit] = '/');
end;

procedure DeleteOwnedDesktopShortcut(Root: String);
var
  LinkPath, Target, Arguments, LowerRoot: String;
  Shell, Shortcut: Variant;
begin
  LinkPath := ExpandConstant('{userdesktop}\Anyswitch.lnk');
  if not FileExists(LinkPath) then Exit;
  // 读回校验：target/arguments 至少一处指本安装根（带前缀边界）才删——源码安装
  // 的同名快捷方式指源码树 silent-start.vbs，不符不删。任何读回失败都静默保留。
  try
    Shell := CreateOleObject('WScript.Shell');
    Shortcut := Shell.CreateShortcut(LinkPath);
    Target := Shortcut.TargetPath;
    Arguments := Shortcut.Arguments;
  except
    Exit;
  end;
  LowerRoot := Lowercase(NormalPath(Root));
  if not PathMentionsRoot(Target, LowerRoot) and not PathMentionsRoot(Arguments, LowerRoot) then Exit;
  if HasReparseAncestor(LinkPath) then Exit;
  DeleteFile(LinkPath);
end;

// backup-root.json 形状 {"root":"<abs>"}（JSON.stringify 落盘）：字符串提取
// 即可，反斜杠按 JSON 转义还原。读不出或形状不符一律视为没有自选备份根。
function ExtractBackupRoot(DataRoot: String): String;
var
  Raw: AnsiString;
  S: String;
  P, I: Integer;
begin
  Result := '';
  if not LoadStringFromFile(DataRoot + '\backup-root.json', Raw) then Exit;
  S := Raw;
  P := Pos('"root"', S);
  if P = 0 then Exit;
  S := Copy(S, P + 6, Length(S));
  P := Pos('"', S);
  if P = 0 then Exit;
  S := Copy(S, P + 1, Length(S));
  I := 1;
  while I <= Length(S) do begin
    if S[I] = '\' then begin
      if I < Length(S) then Result := Result + S[I + 1];
      I := I + 2;
    end else if S[I] = '"' then begin
      Exit;
    end else begin
      Result := Result + S[I];
      I := I + 1;
    end;
  end;
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Root, DataRoot, BackupRoot: String;
begin
  if CurUninstallStep <> usUninstall then Exit;
  Root := ExpandConstant('{app}');
  UninstallResidueRoot := '';
  if not HasReparseAncestor(Root + '\current.json') then DeleteFile(Root + '\current.json');
  RestoreOwnedRegistry(Root);
  // 只清理指向本安装根的自启任务与桌面快捷方式。
  UnregisterOwnedTasks(Root);
  DeleteOwnedDesktopShortcut(Root);
  // versions 树是安装器自有产物（全部位于安装根，远离数据根与 Git 对象库）：
  // Inno 卸载日志只记本次 [Files]，升级换代后旧版本目录会整树残留并阻断该
  // 版本重装；运行时日志已按 2026-11-20 裁决迁至数据根 logs\，删树无日志顾虑。
  UninstallDeleteOwnedTree(Root + '\versions');
  // staging 是自更新落盘暂存（安装根下），同样不在卸载日志内。
  UninstallDeleteOwnedTree(Root + '\staging');
  if RemoveSettings then begin
    DataRoot := ExpandConstant('{localappdata}\Anyswitch');
    DeleteOwnedFile(DataRoot, 'store.json');
    DeleteOwnedFile(DataRoot, 'settings.json');
    DeleteOwnedFile(DataRoot, 'prompts.json');
    DeleteOwnedFile(DataRoot, 'skills.json');
    DeleteOwnedFile(DataRoot, 'pi-relay-token');
    DeleteOwnedFile(DataRoot, 'pi-relay-token-chain.json');
    DeleteOwnedFile(DataRoot, 'pi-relay-token-usage.json');
    DeleteOwnedFile(DataRoot, 'terminal-sessions.json');
    DeleteOwnedFile(DataRoot, 'terminal-rail.json');
    DeleteOwnedFile(DataRoot, 'terminal-conversation-bindings.json');
    DeleteOwnedFile(DataRoot, 'thinking-efforts.db.json');
    DeleteOwnedFile(DataRoot, 'sync-status.json');
    DeleteOwnedFile(DataRoot, 'terminal-switch.log');
    DeleteOwnedFile(DataRoot, 'delete-journal.json');
    DeleteOwnedFile(DataRoot, 'relay.pid');
    DeleteOwnedFile(DataRoot, 'watchdog.pid');
    DeleteOwnedFile(DataRoot, 'terminal-host.pid');
    DeleteOwnedFile(DataRoot, 'agent-metrics-snapshot.json');
    DeleteOwnedFile(DataRoot, 'model-stability.json');
    // 各端点 sidecar（渠道托管记忆）：家族全量以 src/launchers/*merge-config*.mjs
    // 的 SIDECAR_FILENAME 常量为准，契约测试双向钉住防漂移。
    DeleteOwnedFile(DataRoot, 'codex-sidecar.json');
    DeleteOwnedFile(DataRoot, 'dsh-sidecar.json');
    DeleteOwnedFile(DataRoot, 'grok-sidecar.json');
    DeleteOwnedFile(DataRoot, 'kimi-sidecar.json');
    DeleteOwnedFile(DataRoot, 'opencode-sidecar.json');
    DeleteOwnedFile(DataRoot, 'pi-sidecar.json');
    DeleteOwnedFile(DataRoot, 'qoder-sidecar.json');
    DeleteOwnedFile(DataRoot, 'workbuddy-sidecar.json');
    DeleteOwnedFile(DataRoot, 'zcode-sidecar.json');
    DeleteOwnedFile(DataRoot, 'zcode-cli-sidecar.json');
    // 自选备份根：按弹窗承诺备份不保留。默认根 backups\ 由下方 DeleteOwnedTree
    // 覆盖，这里只处理非默认且存在的根，复用 DeleteOwnedTree 的 reparse 防护。
    BackupRoot := ExtractBackupRoot(DataRoot);
    if (BackupRoot <> '') and DirExists(BackupRoot) and
       (CompareText(NormalPath(BackupRoot), NormalPath(DataRoot + '\backups')) <> 0) then
      UninstallDeleteOwnedTree(BackupRoot);
    DeleteOwnedFile(DataRoot, 'backup-root.json');
    UninstallDeleteOwnedTree(DataRoot + '\credentials');
    UninstallDeleteOwnedTree(DataRoot + '\logs');
    UninstallDeleteOwnedTree(DataRoot + '\webview');
    UninstallDeleteOwnedTree(DataRoot + '\backups');
    UninstallDeleteOwnedTree(DataRoot + '\client-updates');
    UninstallDeleteOwnedTree(DataRoot + '\usage');
    UninstallDeleteOwnedTree(DataRoot + '\bin');
    // zcode-cli 槽位目录：Anyswitch 自有的 CLI 槽位（provider_config.json），
    // 与用户桌面版 ~/.zcode 完全隔离（zcode-cli-launcher.mjs），整树清。
    UninstallDeleteOwnedTree(DataRoot + '\zcode-cli');
  end;
  // 占用残留（文件在用删不掉）在末尾指引一次，静默卸载不弹；全删净时不弹。
  if (UninstallResidueRoot <> '') and not UninstallSilent then
    MsgBox('Some files could not be removed because they are in use. After closing Anyswitch, delete them manually from: ' + UninstallResidueRoot, mbInformation, MB_OK);
end;
