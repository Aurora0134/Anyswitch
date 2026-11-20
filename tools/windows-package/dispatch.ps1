param(
  [switch]$VersionOnly,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)
$ErrorActionPreference = 'Stop'
$installRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$currentPath = Join-Path $installRoot 'current.json'
if (-not (Test-Path -LiteralPath $currentPath -PathType Leaf)) { throw 'Anyswitch is not installed at this location.' }
$current = Get-Content -LiteralPath $currentPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$current.version
if ($current.schema -ne 1 -or $version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$') { throw 'The active Anyswitch version is invalid.' }
if ($VersionOnly) { [Console]::Out.Write($version); exit 0 }
if ($Arguments.Count -lt 1) { throw 'An app-relative launcher path is required.' }
$launcher = $Arguments[0]
if ([IO.Path]::IsPathRooted($launcher) -or $launcher -notmatch '^src([/\\][A-Za-z0-9_.-]+)+\.mjs$' -or $launcher -match '(^|[/\\])\.\.([/\\]|$)') { throw 'The app-relative launcher path is invalid.' }
$versionRoot = Join-Path (Join-Path $installRoot 'versions') $version
$runtime = Join-Path (Join-Path $versionRoot 'runtime') 'node.exe'
$app = Join-Path $versionRoot 'app'
$script = [IO.Path]::GetFullPath((Join-Path $app ($launcher -replace '/', '\')))
$appPrefix = [IO.Path]::GetFullPath($app).TrimEnd('\') + '\'
if (-not $script.StartsWith($appPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The app-relative launcher path escapes the active version.' }
if (-not (Test-Path -LiteralPath $runtime -PathType Leaf) -or -not (Test-Path -LiteralPath $script -PathType Leaf)) { throw 'The active Anyswitch version is incomplete.' }
$env:ANYSWITCH_INSTALL_ROOT = $installRoot
$env:ANYSWITCH_APP_ROOT = $app
$env:ANYSWITCH_APP_DIR = $app
$env:ANYSWITCH_VERSION = $version
$remaining = @()
if ($Arguments.Count -gt 1) { $remaining = $Arguments[1..($Arguments.Count - 1)] }
Push-Location -LiteralPath $app
try { & $runtime $script @remaining; exit $LASTEXITCODE }
finally { Pop-Location }
