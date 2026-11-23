#ifndef PayloadDir
  #error PayloadDir is required
#endif
#ifndef ReleaseVersion
  #error ReleaseVersion is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif
#ifndef WebViewSetup
  #error WebViewSetup is required
#endif

[Setup]
AppId=Anyswitch.Windows.Package
AppName=Anyswitch
AppVersion={#ReleaseVersion}
DefaultDirName={localappdata}\Programs\Anyswitch
DisableDirPage=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.17763
OutputDir={#OutputDir}
OutputBaseFilename=anyswitch-v{#ReleaseVersion}-win-x64-setup
SetupIconFile={#PayloadDir}\app\anyswitch.ico
UninstallDisplayIcon={app}\Anyswitch.exe
Compression=lzma2
SolidCompression=yes
ChangesEnvironment=yes
CloseApplications=no
RestartApplications=no

[Files]
Source: "{#PayloadDir}\*"; Excludes: "\app\package-health.mjs,\Anyswitch.exe"; DestDir: "{app}\versions\{#ReleaseVersion}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadDir}\app\package-health.mjs"; DestDir: "{app}\versions\{#ReleaseVersion}\app"; Flags: ignoreversion
Source: "{#PayloadDir}\Anyswitch.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#WebViewSetup}"; Flags: dontcopy
Source: "{#PayloadDir}\app\anyswitch.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\tools\windows-package\anyswitch.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\tools\windows-package\anyswitch-panel.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\tools\windows-package\dispatch.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\tools\windows-package\anyswitch-silent.vbs"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\Anyswitch (Installed)"; Filename: "{app}\Anyswitch.exe"; WorkingDir: "{app}"

[Run]
Filename: "{app}\Anyswitch.exe"; Description: "{cm:LaunchProgram,Anyswitch}"; Flags: nowait postinstall skipifsilent

[Registry]

[Code]
#include "install-code.iss"
