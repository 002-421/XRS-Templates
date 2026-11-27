'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const core = require('../scripts/lib/setup-core.cjs');
const protocol = require('../scripts/lib/template-protocol.cjs');
const { checkProvisioned } = require('../scripts/check-provisioning.cjs');
const { SetupBlocked, verifyRemovableBackupMedia } = require('../scripts/setup-wizard.cjs');

test('setup generates three independent protocol-valid Ed25519 roles', () => {
  const generated = core.makeKeySet();
  protocol.validateRoot(generated.root);
  const ids = ['root', 'test', 'stable'].map(role => generated.generated[role].id);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(generated.root.roles.root.keyIds, [generated.generated.root.id]);
  assert.deepEqual(generated.root.roles.test.keyIds, [generated.generated.test.id]);
  assert.deepEqual(generated.root.roles.stable.keyIds, [generated.generated.stable.id]);
  for (const role of ['root', 'test', 'stable']) {
    const item = generated.generated[role];
    const publicKey = crypto.createPublicKey(item.privatePem);
    assert.equal(protocol.keyId(publicKey.export({ type: 'spki', format: 'pem' })), item.id);
  }
  for (const role of ['root', 'test', 'stable']) generated.generated[role].privatePem = '';
});

test('root backup is encrypted, round-trips, and rejects a wrong passphrase', () => {
  const keys = core.makeKeySet();
  const pem = keys.generated.root.privatePem;
  const backup = core.encryptRootBackup(pem, 'fixture-passphrase-2026');
  assert.equal(backup.includes(Buffer.from(pem)), false);
  assert.equal(core.decryptRootBackup(backup, 'fixture-passphrase-2026'), pem);
  assert.throws(() => core.decryptRootBackup(backup, 'wrong-fixture-passphrase'), { message: 'BACKUP_AUTHENTICATION_FAILED' });
  assert.throws(() => core.encryptRootBackup(pem, 'too-short'), { message: 'BACKUP_PASSPHRASE_TOO_SHORT' });
  keys.generated.root.privatePem = '';
});

test('Windows key path policy requires a separate non-root drive outside the checkout', () => {
  const pathApi = path.win32;
  const accepted = core.validateKeyDirectory({
    repositoryRoot: 'C:\\workspace\\XRS-Templates',
    keyDirectory: 'C:\\Users\\owner\\AppData\\Local\\XRS-Templates-Setup\\private',
    backupDirectory: 'E:\\XRS-Key-Backup',
    platform: 'win32', pathApi,
  });
  assert.equal(accepted.backupDirectory, 'E:\\XRS-Key-Backup');
  assert.throws(() => core.validateKeyDirectory({ repositoryRoot: 'C:\\repo', keyDirectory: 'C:\\repo\\keys', backupDirectory: 'E:\\backup', platform: 'win32', pathApi }), { message: 'KEYS_MUST_BE_OUTSIDE_REPOSITORY' });
  assert.throws(() => core.validateKeyDirectory({ repositoryRoot: 'C:\\repo', keyDirectory: 'C:\\keys', backupDirectory: 'C:\\backup', platform: 'win32', pathApi }), { message: 'BACKUP_MUST_BE_ON_DIFFERENT_DRIVE' });
  assert.throws(() => core.validateKeyDirectory({ repositoryRoot: 'C:\\repo', keyDirectory: 'C:\\keys', backupDirectory: 'E:\\', platform: 'win32', pathApi }), { message: 'BACKUP_NEEDS_DEDICATED_DIRECTORY' });
  assert.throws(() => core.validateKeyDirectory({ repositoryRoot: '/repo', keyDirectory: '/tmp/keys', backupDirectory: '/mnt/usb', platform: 'linux' }), { message: 'WINDOWS_11_REQUIRED' });
});

test('root backup requires Windows to confirm separate physical removable media', () => {
  let call;
  const success = (...args) => { call = args; return { status: 0, stdout: 'XRS_BACKUP_MEDIA_OK\r\n' }; };
  assert.equal(verifyRemovableBackupMedia('C:\\Users\\owner\\AppData\\Local\\XRS', 'E:\\XRS-Backup', success), true);
  assert.equal(call[0], 'powershell.exe');
  assert.match(call[1].at(-1), /Get-Disk/);
  assert.throws(() => verifyRemovableBackupMedia('C:\\Users\\owner\\AppData\\Local\\XRS', 'E:\\XRS-Backup', () => ({ status: 3, stdout: '' })), error => error instanceof SetupBlocked && error.code === 'BACKUP_MUST_BE_SEPARATE_REMOVABLE_MEDIA');
});

test('GitHub secret transfer uses stdin and never puts private material in argv or errors', () => {
  const pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  let call;
  const fakeSpawn = (command, args, options) => {
    call = { command, args, options };
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.deepEqual(core.setEnvironmentSecret(fakeSpawn, 'catalog-test', pem), {
    environment: 'catalog-test', secretName: 'TEMPLATE_SIGNING_PRIVATE_KEY', uploaded: true,
  });
  assert.equal(call.command, 'gh');
  assert.equal(call.options.input, pem);
  assert.equal(call.args.includes(pem), false);
  assert.equal(call.args.includes('--body'), false);
  const failing = () => ({ status: 1, stdout: '', stderr: `fatal response included ${pem}` });
  assert.throws(() => core.setEnvironmentSecret(failing, 'catalog-stable', pem), { message: 'SECRET_UPLOAD_FAILED_CATALOG_STABLE' });
  assert.throws(() => core.githubSecretArgs('catalog-root-recovery'), { message: 'INVALID_SIGNING_ENVIRONMENT' });
});

test('GitHub protection checks fail closed and accept an authorized org admin', () => {
  const snapshot = {
    authenticatedUser: 'ksv1977', repositoryAdmin: true, branchProtectionReadable: true,
    branchProtection: {
      required_pull_request_reviews: { required_approving_review_count: 1 },
      required_status_checks: { contexts: ['validate'] }, enforce_admins: { enabled: true },
    },
    environments: Object.fromEntries(core.ENVIRONMENTS.map(name => [name, { readable: true, reviewers: ['002-421'], deploymentBranches: ['main'] }])),
    existingTestSecret: false, existingStableSecret: false,
  };
  assert.deepEqual(core.validateSnapshot(snapshot), []);
  assert.ok(core.validateSnapshot({ ...snapshot, branchProtectionReadable: false }).includes('github.protection.unreadable'));
  assert.ok(core.validateSnapshot({ ...snapshot, repositoryAdmin: false }).includes('github.repo.admin_required'));
  assert.ok(core.validateSnapshot({ ...snapshot, environments: { ...snapshot.environments, 'catalog-stable': { readable: false } } }).includes('github.environment.catalog-stable.unreadable_or_missing'));
  assert.ok(core.validateSnapshot({ ...snapshot, existingTestSecret: true }).includes('github.secret.catalog_test.exists_unowned'));
});

test('wizard state rejects private keys and contains only public recovery metadata', () => {
  assert.throws(() => core.safeState({ progress: 'keys', value: '-----BEGIN PRIVATE KEY-----' }), { message: 'PRIVATE_KEY_IN_STATE' });
  assert.doesNotThrow(() => core.safeState({ root: { roles: {} }, keyIds: { root: 'public-id' }, pendingSecretUpload: { environment: 'catalog-test', keyId: 'public-id' } }));
});

test('test publication gate is independent; Stable remains fail-closed', () => {
  assert.equal(checkProvisioned('test', 'true', 'false'), 'test');
  assert.throws(() => checkProvisioned('stable', 'true', 'false'), { code: 'STABLE_PUBLICATION_NOT_PROVISIONED' });
  assert.throws(() => checkProvisioned('test', 'false', 'true'), { code: 'TEST_PUBLICATION_NOT_PROVISIONED' });
  assert.equal(checkProvisioned('stable', 'false', 'true'), 'stable');
  assert.throws(() => checkProvisioned('unknown', 'true', 'true'), { code: 'UNKNOWN_PUBLICATION_CHANNEL' });
});
