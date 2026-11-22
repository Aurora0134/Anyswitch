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

function ValidateInstallRoot(Path: String): String;
var
  Root, DataRoot, GitRoot, PriorRoot: String;
begin
  Result := 'Choose a dedicated installation folder on a local fixed drive.';
  if (Length(Path) < 4) or (Copy(Path, 2, 2) <> ':\') or (Pos(':', Copy(Path, 3, Length(Path))) > 0) then Exit;
  Root := NormalPath(Path);
  if (Length(Root) <= 3) or (GetDriveType(ExtractFileDrive(Root) + '\') <> DriveFixed) or HasReparseAncestor(Root) then Exit;
  DataRoot := NormalPath(ExpandConstant('{localappdata}\Anyswitch'));
  GitRoot := NormalPath(ExpandConstant('{localappdata}\Anyswitch-git'));
  if IsWithin(Root, DataRoot) or IsWithin(DataRoot, Root) or IsWithin(Root, GitRoot) or IsWithin(GitRoot, Root) then Exit;
  if RegQueryStringValue(HKCU, PackageKey, 'InstallRoot', PriorRoot) then begin
    Result := 'Use the existing Anyswitch installation folder.';
    if CompareText(Root, NormalPath(PriorRoot)) <> 0 then Exit;
  end else if DirExists(Root) and not IsEmptyFolder(Root) then begin
    Result := 'Choose an empty folder for Anyswitch.';
    Exit;
  end;
  Result := 'Anyswitch cannot use this installation folder.';
  if HasReparseAncestor(Root + '\versions') or HasReparseAncestor(Root + '\current.json') or
     (GetFileAttributes(Root + '\current.json.setup') <> InvalidAttributes) then Exit;
  if GetFileAttributes(Root + '\versions\{#ReleaseVersion}') <> InvalidAttributes then begin
    Result := 'This version is already present in the installation folder.';
    Exit;
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
begin
  Result := ValidateInstallRoot(WizardDirValue);
  if (Result = '') and FileExists(ExpandConstant('{localappdata}\Anyswitch\app\package.json')) then
    Log('Existing source installation detected. Source and data are retained.');
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
  Root, Pending, ExistingInstallRoot: String;
begin
  if CurStep = ssPostInstall then begin
    Root := ExpandConstant('{app}');
    FilesInstalled := True;
    if not CheckCandidate then RaiseException('Anyswitch did not pass its installation check. The previous version remains active.');
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
    SetupComplete := True;
  end;
end;

function InitializeUninstall: Boolean;
begin
  RemoveSettings := False;
  if not UninstallSilent then
    RemoveSettings := MsgBox('Also delete Anyswitch settings and stored credentials? The source installation and its Git history will be kept.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
  Result := True;
end;

procedure DeleteOwnedTree(Path: String);
var
  Entry: TFindRec;
  Child: String;
begin
  if HasReparseAncestor(Path) then Exit;
  if FindFirst(AddBackslash(Path) + '*', Entry) then begin
    try
      repeat
        if (Entry.Name <> '.') and (Entry.Name <> '..') then begin
          Child := AddBackslash(Path) + Entry.Name;
          if (Entry.Attributes and AttrDirectory) <> 0 then DeleteOwnedTree(Child)
          else if not HasReparseAncestor(Child) then DeleteFile(Child);
        end;
      until not FindNext(Entry);
    finally
      FindClose(Entry);
    end;
  end;
  RemoveDir(Path);
end;

procedure DeleteOwnedFile(Root, Name: String);
var
  Path: String;
begin
  Path := Root + '\' + Name;
  if not HasReparseAncestor(Path) then DeleteFile(Path);
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
  // Actions[0].Arguments 含本安装根的任务，其余保留。失败静默——卸载不可因
  // 清理失败而失败。
  Params := '-NoProfile -ExecutionPolicy Bypass -Command "$r=$args[0].ToLower();' +
    'foreach($n in @(''AnyswitchRelay'',''AnyswitchWatchdog'',''AnyswitchPanel'',''ApiCredRelay'',''ApiCredWatchdog'')){' +
    'try{$t=Get-ScheduledTask -TaskName $n -ErrorAction Stop;$a=$t.Actions[0].Arguments;' +
    'if($a -and $a.ToLower().Contains($r)){Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction Stop}}catch{}}" "' + Root + '"';
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure DeleteOwnedDesktopShortcut(Root: String);
var
  LinkPath, Target, Arguments, LowerRoot: String;
  Shell, Shortcut: Variant;
begin
  LinkPath := ExpandConstant('{userdesktop}\Anyswitch.lnk');
  if not FileExists(LinkPath) then Exit;
  // 读回校验：target/arguments 至少一处指本安装根才删——源码安装的同名快捷
  // 方式指源码树 silent-start.vbs，不符不删。任何读回失败都静默保留。
  try
    Shell := CreateOleObject('WScript.Shell');
    Shortcut := Shell.CreateShortcut(LinkPath);
    Target := Shortcut.TargetPath;
    Arguments := Shortcut.Arguments;
  except
    Exit;
  end;
  LowerRoot := Lowercase(NormalPath(Root));
  if (Pos(LowerRoot, Lowercase(Target)) = 0) and (Pos(LowerRoot, Lowercase(Arguments)) = 0) then Exit;
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
  if not HasReparseAncestor(Root + '\current.json') then DeleteFile(Root + '\current.json');
  RestoreOwnedRegistry(Root);
  // 自启任务与桌面快捷方式都指 {app}\anyswitch-silent.vbs（[Files] 装入项，
  // 卸载必删），不带走就是死入口；两处都按安装根比对，失败一律静默。
  UnregisterOwnedTasks(Root);
  DeleteOwnedDesktopShortcut(Root);
  // versions 树是安装器自有产物（全部位于安装根，远离数据根与 Git 对象库）：
  // Inno 卸载日志只记本次 [Files]，升级换代后旧版本目录会整树残留并阻断该
  // 版本重装；运行时日志已按 2026-11-20 裁决迁至数据根 logs\，删树无日志顾虑。
  DeleteOwnedTree(Root + '\versions');
  // staging 是自更新落盘暂存（安装根下），同样不在卸载日志内。
  DeleteOwnedTree(Root + '\staging');
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
    // 自选备份根：按弹窗承诺备份不保留。默认根 backups\ 由下方 DeleteOwnedTree
    // 覆盖，这里只处理非默认且存在的根，复用 DeleteOwnedTree 的 reparse 防护。
    BackupRoot := ExtractBackupRoot(DataRoot);
    if (BackupRoot <> '') and DirExists(BackupRoot) and
       (CompareText(NormalPath(BackupRoot), NormalPath(DataRoot + '\backups')) <> 0) then
      DeleteOwnedTree(BackupRoot);
    DeleteOwnedFile(DataRoot, 'backup-root.json');
    DeleteOwnedTree(DataRoot + '\credentials');
    DeleteOwnedTree(DataRoot + '\logs');
    DeleteOwnedTree(DataRoot + '\backups');
    DeleteOwnedTree(DataRoot + '\client-updates');
    DeleteOwnedTree(DataRoot + '\usage');
    DeleteOwnedTree(DataRoot + '\bin');
  end;
end;
