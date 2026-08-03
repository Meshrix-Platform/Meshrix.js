param(
  [string]$Target = "openclaw,codex,claude-code,antigravity,opencode,pi,kimi",
  [switch]$Json,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"
$Installer = Join-Path $PSScriptRoot "meshrix-mcp-install.ps1"

if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
  [Console]::Error.WriteLine("The verified installer entrypoint is required for uninstall.")
  exit 1
}

& $Installer -Command uninstall -Target $Target -Json:$Json @RemainingArgs
if ($null -ne $LASTEXITCODE) {
  exit $LASTEXITCODE
}
exit 0
