param(
  [Parameter(Mandatory = $true)]
  [string]$Directory
)

$ErrorActionPreference = 'Stop'

try {
  Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
  $acl = Get-Acl -LiteralPath $Directory
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowSids = @(
    foreach ($rule in $acl.Access) {
      if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
        $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      }
    }
  )
  $unexpected = @($allowSids | Where-Object { $_ -ne $currentSid -and $_ -ne 'S-1-5-18' })
  $diagnostic = [ordered]@{
    protected = [bool]($acl.AreAccessRulesProtected)
    currentAccountAllowed = [bool]($allowSids -contains $currentSid)
    systemAllowed = [bool]($allowSids -contains 'S-1-5-18')
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
  $errorId = ($_.FullyQualifiedErrorId -split ',')[0]
  $diagnostic = [ordered]@{ powershellExitCode = 5; diagnosticAvailable = $false; errorId = $errorId }
  Write-Output ('XRS_ACL_DIAG:' + (ConvertTo-Json -InputObject $diagnostic -Compress))
  exit 5
}
