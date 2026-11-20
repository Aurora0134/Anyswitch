#ifndef PayloadDir
  #error PayloadDir is required
#endif
#ifndef ReleaseVersion
  #error ReleaseVersion is required
#endif
#ifndef OutputDir
  #error OutputDir is required
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
UninstallDisplayIcon={app}\anyswitch.ico
Compression=lzma2
SolidCompression=yes
ChangesEnvironment=yes
CloseApplications=no
RestartApplications=no

[Files]
Source: "{#PayloadDir}\*"; Excludes: "\app\package-health.mjs"; DestDir: "{app}\versions\{#ReleaseVersion}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadDir}\app\package-health.mjs"; DestDir: "{app}\versions\{#ReleaseVersion}\app"; Flags: ignoreversion
Source: "{#PayloadDir}\app\anyswitch.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\tools\windows-package\anyswitch.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\tools\windows-package\anyswitch-panel.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\tools\windows-package\dispatch.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\tools\windows-package\anyswitch-silent.vbs"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\Anyswitch (Installed)"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\anyswitch-silent.vbs"" src\panel\panel-launcher.mjs"; WorkingDir: "{app}"; IconFilename: "{app}\anyswitch.ico"

[Registry]

[Code]
#include "install-code.iss"
