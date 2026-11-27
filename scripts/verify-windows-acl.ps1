param(
  [Parameter(Mandatory = $true)]
  [string]$Directory
)

$ErrorActionPreference = 'Stop'

try {
  $currentAccount = (& whoami.exe).Trim()
  $directoryInfo = New-Object System.IO.DirectoryInfo($Directory)
  $acl = $directoryInfo.GetAccessControl()
  $currentSid = ([System.Security.Principal.NTAccount]::new($currentAccount)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  $systemSid = 'S-1-5-18'
  $aces = @($acl.Access)
  $allowAces = @($aces | Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow })
  $sidForAce = { param($ace) try { $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { '' } }
  $currentLine = @($allowAces | Where-Object { (& $sidForAce $_) -eq $currentSid -and (([int]$_.FileSystemRights -band [int][System.Security.AccessControl.FileSystemRights]::FullControl) -eq [int][System.Security.AccessControl.FileSystemRights]::FullControl) })
  $systemLine = @($allowAces | Where-Object { (& $sidForAce $_) -eq $systemSid -and (([int]$_.FileSystemRights -band [int][System.Security.AccessControl.FileSystemRights]::FullControl) -eq [int][System.Security.AccessControl.FileSystemRights]::FullControl) })
  $systemPrincipalLine = @($allowAces | Where-Object { (& $sidForAce $_) -eq $systemSid })
  $unexpected = @($allowAces | Where-Object { (& $sidForAce $_) -notin @($currentSid, $systemSid) })
  $diagnostic = [ordered]@{
    protected = [bool]$acl.AreAccessRulesProtected
    currentAccountAllowed = [bool]($currentLine.Count -gt 0)
    systemAllowed = [bool]($systemLine.Count -gt 0)
    systemAceSeen = [bool]($systemPrincipalLine.Count -gt 0)
    systemAceFullCount = [int]$systemLine.Count
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
