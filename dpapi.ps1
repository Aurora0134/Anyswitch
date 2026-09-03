[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('protect', 'unprotect')][string]$Operation,
  [Parameter(Mandatory = $true)][ValidateSet('v1', 'v2')][string]$Generation,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')][string]$ProviderId
)

# Global Anyswitch DPAPI helper.
#
# Two entropy generations, deliberately NOT interchangeable:
#   v1 -> OpenCodeApiCred|DPAPI|v1|<ProviderId>   legacy OpenCode-scoped store
#   v2 -> ApiCred|DPAPI|v2|<ProviderId>           global store
# A v1 ciphertext therefore cannot be decrypted as v2 or vice versa; a mixed-up
# generation fails closed instead of silently producing garbage.
#
# Scope is CurrentUser: ciphertext is bound to this Windows user account.
# Every byte buffer is zeroed in the finally block. stderr never echoes payload.

$ErrorActionPreference = 'Stop'
$null = Add-Type -AssemblyName System.Security
$requestBytes = $null
$payload = $null
$entropy = $null
$result = $null

function Clear-Bytes {
  param([byte[]]$Bytes)
  if ($null -ne $Bytes) { [Array]::Clear($Bytes, 0, $Bytes.Length) }
}

try {
  $requestText = [Console]::In.ReadToEnd()
  $request = $requestText | ConvertFrom-Json
  $requestBytes = [Text.Encoding]::UTF8.GetBytes($requestText)
  $payload = [Convert]::FromBase64String([string]$request.payloadBase64)

  if ($Generation -eq 'v1') {
    $label = "OpenCodeApiCred|DPAPI|v1|$ProviderId"
  } else {
# v2 entropy prefix is the pre-rename literal "ApiCred" — changing it would orphan every sealed credential.
    $label = "ApiCred|DPAPI|v2|$ProviderId"
  }
  $entropy = [Text.Encoding]::UTF8.GetBytes($label)

  if ($Operation -eq 'protect') {
    $result = [Security.Cryptography.ProtectedData]::Protect($payload, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  } else {
    $result = [Security.Cryptography.ProtectedData]::Unprotect($payload, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  }

  [Console]::Out.Write((@{ ok = $true; payloadBase64 = [Convert]::ToBase64String($result) } | ConvertTo-Json -Compress))
} catch {
  [Console]::Error.Write('DPAPI operation failed.')
  exit 1
} finally {
  Clear-Bytes $requestBytes
  Clear-Bytes $payload
  Clear-Bytes $entropy
  Clear-Bytes $result
}
