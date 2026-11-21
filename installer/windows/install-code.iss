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
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Root, Pending, ExistingInstallRoot: String;
begin
  if CurStep = ssPostInstall then begin
    Root := ExpandConstant('{app}');
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

procedure DeinitializeSetup;
var
  Root, Pending: String;
begin
  if SetupComplete or not PointerChanged then Exit;
  Root := ExpandConstant('{app}');
  Pending := Root + '\current.json.rollback';
  if HadCurrent then begin
    if SaveStringToFile(Pending, PreviousCurrent, False) then
      MoveFileEx(Pending, Root + '\current.json', MoveReplaceExisting or MoveWriteThrough);
  end else DeleteFile(Root + '\current.json');
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

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Root, DataRoot: String;
begin
  if CurUninstallStep <> usUninstall then Exit;
  Root := ExpandConstant('{app}');
  if not HasReparseAncestor(Root + '\current.json') then DeleteFile(Root + '\current.json');
  RestoreOwnedRegistry(Root);
  // versions 树是安装器自有产物（全部位于安装根，远离数据根与 Git 对象库）：
  // Inno 卸载日志只记本次 [Files]，升级换代后旧版本目录会整树残留并阻断该
  // 版本重装；运行时日志已按 2026-11-20 裁决迁至数据根 logs\，删树无日志顾虑。
  DeleteOwnedTree(Root + '\versions');
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
    DeleteOwnedTree(DataRoot + '\credentials');
    DeleteOwnedTree(DataRoot + '\logs');
  end;
end;
