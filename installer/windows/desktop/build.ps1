param(
    [Parameter(Mandatory)] [string] $Sdk,
    [Parameter(Mandatory)] [string] $Output
)
$ErrorActionPreference = 'Stop'
$Compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$Output = [IO.Path]::GetFullPath($Output)
$Sdk = (Resolve-Path -LiteralPath $Sdk).Path
$Icon = Join-Path $PSScriptRoot '..\..\..\anyswitch.ico'
$Bootstrap = Join-Path $PSScriptRoot 'Bootstrap.cs'
$Desktop = Join-Path $PSScriptRoot 'Desktop.cs'
$Assemblies = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll')
$Lib = Join-Path $Sdk 'lib\net462'
New-Item -ItemType Directory -Force -Path (Join-Path $Output 'desktop') | Out-Null

& $Compiler /nologo /target:winexe /platform:x64 /optimize+ /main:Bootstrap "/out:$Output\Anyswitch.exe" "/win32icon:$Icon" /r:System.Web.Extensions.dll $Bootstrap
if ($LASTEXITCODE -ne 0) { throw 'Anyswitch launcher build failed.' }
$References = $Assemblies | ForEach-Object { '/r:' + (Join-Path $Lib $_) }
& $Compiler /nologo /target:winexe /platform:x64 /optimize+ /main:Desktop "/out:$Output\desktop\Anyswitch.Desktop.exe" "/win32icon:$Icon" /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll @References $Bootstrap $Desktop
if ($LASTEXITCODE -ne 0) { throw 'Anyswitch desktop build failed.' }
foreach ($Name in $Assemblies) {
    Copy-Item -LiteralPath (Join-Path $Lib $Name) -Destination (Join-Path $Output 'desktop')
}
Copy-Item -LiteralPath (Join-Path $Sdk 'runtimes\win-x64\native\WebView2Loader.dll') -Destination (Join-Path $Output 'desktop')
Copy-Item -LiteralPath (Join-Path $Sdk 'LICENSE.txt') -Destination (Join-Path $Output 'desktop\WebView2-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $Sdk 'NOTICE.txt') -Destination (Join-Path $Output 'desktop\WebView2-NOTICE.txt')
