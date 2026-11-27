'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { privateDirectoryAcl, verifyRemovableBackupMedia, SetupBlocked } = require('../scripts/setup-wizard.cjs');
const core = require('../scripts/lib/setup-core.cjs');

const windowsOnly = { skip: process.platform !== 'win32' || process.env.XRS_WINDOWS_INTEGRATION !== '1' };

function powershell(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('Windows command launcher runs preflight without authenticating or provisioning', windowsOnly, () => {
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', 'Setup-XRS-Templates.cmd --preflight-only'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS: Windows runner, Node\.js 24, GitHub CLI и Git доступны/i);
  assert.match(result.stdout, /GitHub API не вызывался; ключи и Secrets не создавались/i);
});

test('icacls applies a protected ACL on a temporary directory', windowsOnly, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xrs-setup-acl-fixture-'));
  try {
    privateDirectoryAcl(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('PowerShell Get-Acl confirms only current account and SYSTEM are allowed', windowsOnly, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xrs-setup-acl-check-'));
  try {
    privateDirectoryAcl(directory);
    const escaped = directory.replaceAll("'", "''");
    const check = powershell(`$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath '${escaped}'; $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $allowed=@($user,'S-1-5-18'); $sids=@($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }); $bad=@($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed }); if ($acl.AreAccessRulesProtected -and $sids -contains $user -and $sids -contains 'S-1-5-18' -and $bad.Count -eq 0) { 'XRS_ACL_OK' } else { exit 4 }`);
    assert.equal(check.status, 0, `PowerShell failed (${check.status}): ${check.stderr || check.stdout}`);
    assert.match(check.stdout, /XRS_ACL_OK/, `ACL validation did not report success: ${check.stdout}`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('absent removable USB volume is rejected by the real PowerShell disk check', windowsOnly, () => {
  const freeDrive = powershell("$used=@(Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Name }); $free=([char[]](68..90) | Where-Object { $_.ToString() -notin $used } | Select-Object -First 1); if ($free) { $free } else { exit 5 }");
  assert.equal(freeDrive.status, 0, freeDrive.stderr);
  const drive = freeDrive.stdout.trim().at(0);
  assert.ok(drive);
  assert.throws(() => verifyRemovableBackupMedia(os.tmpdir(), `${drive}:\\xrs-no-device`), error => error instanceof SetupBlocked && error.code === 'BACKUP_MUST_BE_SEPARATE_REMOVABLE_MEDIA');
});

test('Windows path policy rejects the repository, same-volume backup, and drive root', windowsOnly, () => {
  assert.throws(() => core.validateKeyDirectory({ repositoryRoot: 'C:\\repo', keyDirectory: 'C:\\repo\\keys', backupDirectory: 'E:\\backup', platform: 'win32', pathApi: path.win32 }), { message: 'KEYS_MUST_BE_OUTSIDE_REPOSITORY' });
  assert.throws(() => core.validateKeyDirectory({ repositoryRoot: 'C:\\repo', keyDirectory: 'C:\\keys', backupDirectory: 'C:\\backup', platform: 'win32', pathApi: path.win32 }), { message: 'BACKUP_MUST_BE_ON_DIFFERENT_DRIVE' });
  assert.throws(() => core.validateKeyDirectory({ repositoryRoot: 'C:\\repo', keyDirectory: 'C:\\keys', backupDirectory: 'E:\\', platform: 'win32', pathApi: path.win32 }), { message: 'BACKUP_NEEDS_DEDICATED_DIRECTORY' });
});
