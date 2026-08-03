param(
  [Parameter(Position = 0)]
  [string]$Command = "install",
  [string]$Target = "",
  [string]$Url = "",
  [switch]$Json,
  [string]$TokenEnv = "MESHRIX_MCP_TOKEN",
  [string]$DiscoveryFile = "",
  [switch]$TokenStdin,
  [string]$ScanPorts = "",
  [switch]$NoVerify,
  [Parameter(DontShow = $true)]
  [Alias("Token")]
  [string]$RejectedRawToken = "",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"

function Write-Failure([string]$Message) {
  if ($Json) {
    @{ ok = $false; error = "native_installer_security_requirement_failed" } |
      ConvertTo-Json -Compress |
      Write-Output
  } else {
    [Console]::Error.WriteLine($Message)
  }
  exit 1
}

$AllowedCommands = @("install", "register", "scan", "discover-local", "uninstall", "doctor", "help", "version")
if ($Command -notin $AllowedCommands) {
  if ($Command -match 'mxak1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}') {
    Write-Failure "Raw API Keys are not accepted in process arguments. Use -TokenStdin or an exported API Key environment variable."
  }
  Write-Failure "Unsupported installer command."
}

function Test-TokenEnvironmentName([string]$Name) {
  return $Name -match '^[A-Za-z_][A-Za-z0-9_]*$'
}

function Invoke-Connector([string]$Connector, [string[]]$Arguments) {
  if (-not (Test-Path -LiteralPath $Connector -PathType Leaf)) {
    Write-Failure "The configured MCP connector is not available."
  }

  if ([IO.Path]::GetExtension($Connector) -eq ".ts") {
    $Node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $Node) {
      Write-Failure "The repository connector requires Node.js. Use a verified portable release bundle when Node.js is unavailable."
    }
    & $Node.Source $Connector @Arguments
  } else {
    & $Connector @Arguments
  }

  if ($null -ne $LASTEXITCODE) {
    exit $LASTEXITCODE
  }
  exit 0
}

if (-not (Test-TokenEnvironmentName $TokenEnv)) {
  Write-Failure "Invalid -TokenEnv name. Use letters, digits, and underscores with a non-digit first character."
}

if ($PSBoundParameters.ContainsKey("RejectedRawToken")) {
  Write-Failure "Raw API Keys are not accepted in process arguments. Use -TokenStdin or an exported API Key environment variable."
}

foreach ($Argument in @($RemainingArgs) | Where-Object { $null -ne $_ }) {
  if ($Argument -match 'mxak1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}') {
    Write-Failure "Raw API Keys are not accepted in process arguments. Use -TokenStdin or an exported API Key environment variable."
  }
  if ($Argument -eq "--token" -or $Argument.StartsWith("--token=")) {
    Write-Failure "Raw API Keys are not accepted in process arguments. Use -TokenStdin or an exported API Key environment variable."
  }
}

foreach ($Argument in @($Target, $Url, $DiscoveryFile, $ScanPorts) | Where-Object { $null -ne $_ }) {
  if ($Argument -match 'mxak1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}') {
    Write-Failure "Raw API Keys are not accepted in process arguments. Use -TokenStdin or an exported API Key environment variable."
  }
}

$ConnectorArguments = @($Command)
if ($Target) { $ConnectorArguments += @("--target", $Target) }
if ($Url) { $ConnectorArguments += @("--url", $Url) }
if ($Json) { $ConnectorArguments += "--json" }
if ($TokenEnv) { $ConnectorArguments += @("--token-env", $TokenEnv) }
if ($DiscoveryFile) { $ConnectorArguments += @("--discovery-file", $DiscoveryFile) }
if ($TokenStdin) { $ConnectorArguments += "--token-stdin" }
if ($ScanPorts) { $ConnectorArguments += @("--scan-ports", $ScanPorts) }
if ($NoVerify) { $ConnectorArguments += "--no-verify" }
$ConnectorArguments += @($RemainingArgs)

$SiblingExecutable = @(
  (Join-Path $PSScriptRoot "meshrix-mcp.exe"),
  (Join-Path $PSScriptRoot "meshrix-mcp.cmd"),
  (Join-Path $PSScriptRoot "meshrix-mcp.ps1")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if ($SiblingExecutable) {
  Invoke-Connector $SiblingExecutable $ConnectorArguments
}

$RepositoryConnector = Join-Path $PSScriptRoot "..\gateway-installer\bin\meshrix-mcp.ts"
if (Test-Path -LiteralPath $RepositoryConnector -PathType Leaf) {
  Invoke-Connector $RepositoryConnector $ConnectorArguments
}

Write-Failure "No verified Meshrix MCP connector was found. Download a release bundle, verify its published SHA256, extract it, and run this script from that bundle."
