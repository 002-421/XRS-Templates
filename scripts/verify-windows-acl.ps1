param(
  [Parameter(Mandatory = $true)]
  [string]$Directory
)

$ErrorActionPreference = 'Stop'

try {
  $currentAccount = (& whoami.exe).Trim()
  $lines = @(& icacls.exe $Directory 2>&1 | ForEach-Object { [string]$_ })
  if ($LASTEXITCODE -ne 0) { throw 'ICACLS_READ_FAILED' }
  $aceLines = @($lines | Where-Object { $_ -match '^\s+[^:]+:\(' })
  $currentLine = @($aceLines | Where-Object { $_ -match [regex]::Escape($currentAccount) -and $_ -match '\(F\)' })
  $systemLine = @($aceLines | Where-Object { $_ -match '(?i)S-1-5-18|SYSTEM|СИСТЕМ' -and $_ -match '\(F\)' })
  $unexpected = @($aceLines | Where-Object { $_ -notmatch [regex]::Escape($currentAccount) -and $_ -notmatch '(?i)S-1-5-18|SYSTEM|СИСТЕМ' })
  $inherited = @($aceLines | Where-Object { $_ -match '\(I\)' })
  $diagnostic = [ordered]@{
    protected = [bool]($inherited.Count -eq 0)
    currentAccountAllowed = [bool]($currentLine.Count -gt 0)
    systemAllowed = [bool]($systemLine.Count -gt 0)
    unexpectedAllowCount = [int]$unexpected.Count
  }
  Write-Output ('XRS_ACL_DIAG:' + (ConvertTo-Json -InputObject $diagnostic -Compress))
  if ($diagnostic.protected -and $diagnostic.currentAccountAllowed -and $diagnostic.systemAllowed -and $diagnostic.unexpectedAllowCount -eq 0) {
    Write-Output 'XRS_ACL_OK'
    exit 0
  }
  exit 4
}
catch {
  $errorId = if ($_.Exception.Message -match '^[A-Z0-9_]+$') { $_.Exception.Message } else { ($_.FullyQualifiedErrorId -split ',')[0] }
  $diagnostic = [ordered]@{ powershellExitCode = 5; diagnosticAvailable = $false; errorId = $errorId }
  Write-Output ('XRS_ACL_DIAG:' + (ConvertTo-Json -InputObject $diagnostic -Compress))
  exit 5
}
