'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const core = require('../scripts/lib/setup-core.cjs');
const protocol = require('../scripts/lib/template-protocol.cjs');
const { checkProvisioned } = require('../scripts/check-provisioning.cjs');
const { SetupBlocked, verifyRemovableBackupMedia, setupPreflight, readSnapshot, recoverUnrecordedKeySetup, provisionEnvironmentSecret, saveState } = require('../scripts/setup-wizard.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');

test('GitHub CLI preflight requires the actual token-free JSON auth capability version',()=>{
 const {checkGhInstalled}=require('../scripts/setup-wizard.cjs');
 for(const version of ['2.65.0','2.80.0','1.99.0'])assert.throws(()=>checkGhInstalled(()=>`gh version ${version}`),{code:'GH_VERSION_TOO_OLD'});
 for(const version of ['2.81.0','2.106.0','3.0.0'])assert.doesNotThrow(()=>checkGhInstalled(()=>`gh version ${version}`));
 assert.throws(()=>checkGhInstalled(()=>{throw Error('synthetic missing CLI');}),{code:'GH_REQUIRED'});
});

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

test('GitHub protection checks fail closed and accept only the authorized single owner', () => {
  const snapshot = {
    authenticatedUser: '002-421', authenticatedUserId: 210672295, repositoryAdmin: true, branchProtectionReadable: true,
    branchProtection: {
      required_pull_request_reviews: { required_approving_review_count: 1 },
      required_status_checks: { contexts: ['validate'] }, enforce_admins: { enabled: true },
    },
    environments: Object.fromEntries(core.ENVIRONMENTS.map(name => [name, { readable: true, reviewers: ['002-421'], deploymentBranches: ['main'] }])),
    existingTestSecret: false, existingStableSecret: false,
  };
  assert.deepEqual(core.validateSnapshot(snapshot), []);
  assert.ok(core.validateSnapshot({ ...snapshot, authenticatedUserId: 123 }).includes('github.auth.owner_required'));
  assert.ok(core.validateSnapshot({ ...snapshot, branchProtectionReadable: false }).includes('github.protection.unreadable'));
  assert.ok(core.validateSnapshot({ ...snapshot, repositoryAdmin: false }).includes('github.repo.admin_required'));
  assert.ok(core.validateSnapshot({ ...snapshot, environments: { ...snapshot.environments, 'catalog-stable': { readable: false } } }).includes('github.environment.catalog-stable.unreadable_or_missing'));
  assert.ok(core.validateSnapshot({ ...snapshot, existingTestSecret: true }).includes('github.secret.catalog_test.exists_unowned'));
});

test('GitHub API fixture covers allowed access, HTTP 403, and incomplete environments', () => {
  const protection = {
    required_pull_request_reviews: { required_approving_review_count: 1 },
    required_status_checks: { contexts: ['validate'] }, enforce_admins: { enabled: true },
  };
  const fixture = (args) => {
    const route = args[0];
    if (route === '/user') return { login: '002-421', id: 210672295 };
    if (route === '/repos/002-421/XRS-Templates') return { permissions: { admin: true } };
    if (route.endsWith('/branches/main/protection')) return protection;
    if (route.endsWith('/actions/variables')) return { variables: [] };
    if (route.endsWith('/environments/catalog-test/secrets') || route.endsWith('/environments/catalog-stable/secrets')) return { secrets: [] };
    if (route.endsWith('/contents/trust/root.json?ref=main')) throw Object.assign(new SetupBlocked('HTTP_404'), { httpStatus: 404 });
    const environment = route.match(/\/environments\/(catalog-[^/]+)/)?.[1];
    if (environment && route.endsWith('/deployment-branch-policies')) return { branch_policies: [{ type: 'branch', name: 'main' }] };
    if (environment) return { protection_rules: [{ type: 'required_reviewers', reviewers: [{ reviewer: { login: '002-421' } }] }] };
    throw new Error('UNEXPECTED_FIXTURE_ROUTE');
  };
  const allowed = readSnapshot({ api: fixture });
  assert.equal(allowed.authenticatedUser, '002-421');
  assert.equal(allowed.repositoryAdmin, true);
  assert.equal(allowed.publicRoot, null);
  assert.deepEqual(core.validateSnapshot(allowed), []);

  const forbiddenProtection = readSnapshot({ api: args => {
    if (args[0].endsWith('/branches/main/protection')) throw Object.assign(new SetupBlocked('HTTP_403'), { httpStatus: 403 });
    return fixture(args);
  } });
  assert.equal(forbiddenProtection.branchProtectionReadable, false);
  assert.ok(core.validateSnapshot(forbiddenProtection).includes('github.protection.unreadable'));

  assert.throws(() => readSnapshot({ api: args => {
    if (args[0].endsWith('/actions/variables')) throw Object.assign(new SetupBlocked('HTTP_403'), { httpStatus: 403 });
    return fixture(args);
  } }), error => error.code === 'ACTIONS_VARIABLES_READ_FAILED' && error.link.includes('/settings/variables'));

  assert.throws(() => readSnapshot({ api: args => {
    if (args[0].endsWith('/environments/catalog-test/secrets')) throw Object.assign(new SetupBlocked('HTTP_403'), { httpStatus: 403 });
    return fixture(args);
  } }), error => error.code === 'ENVIRONMENT_SECRETS_READ_FAILED_CATALOG_TEST' && error.link.includes('/settings/secrets'));

  const incomplete = readSnapshot({ api: args => {
    if (args[0] === '/repos/002-421/XRS-Templates/environments/catalog-stable') throw Object.assign(new SetupBlocked('HTTP_403'), { httpStatus: 403 });
    return fixture(args);
  } });
  assert.ok(core.validateSnapshot(incomplete).includes('github.environment.catalog-stable.unreadable_or_missing'));
});

test('wizard recovery stops on interrupted partial key setup without replacing artifacts', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'xrs-setup-partial-'));
  const keyDirectory = path.join(base, 'keys');
  const backupDirectory = path.join(base, 'backup');
  await fs.mkdir(keyDirectory);
  await fs.mkdir(backupDirectory);
  const rootMarker = path.join(keyDirectory, 'root.json');
  await fs.writeFile(rootMarker, '{"partial":true}');
  const stateFile = path.join(base, 'state.json');
  let prompted = false;
  await assert.rejects(recoverUnrecordedKeySetup({ keyDirectory, backupDirectory }, { hidden: async () => { prompted = true; } }, base, stateFile), { code: 'PARTIAL_KEY_SETUP_REQUIRES_OWNER_REVIEW' });
  assert.equal(prompted, false);
  assert.equal(await fs.readFile(rootMarker, 'utf8'), '{"partial":true}');
  await assert.rejects(fs.stat(stateFile), { code: 'ENOENT' });
  await fs.rm(base, { recursive: true, force: true });
});

test('partial secret transfer resumes only with the same synthetic key and explicit confirmation', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'xrs-setup-secret-fixture-'));
  const keyDirectory = path.join(base, 'private');
  await fs.mkdir(keyDirectory);
  const pair = crypto.generateKeyPairSync('ed25519');
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keyId = protocol.keyId(pair.publicKey.export({ type: 'spki', format: 'pem' }));
  await fs.writeFile(path.join(keyDirectory, 'test-signing.pem'), pem, { mode: 0o600 });
  const stateFile = path.join(base, 'setup-state.json');
  const state = { keyIds: { test: keyId }, testSecretUploaded: false, stableSecretUploaded: false, pendingSecretUpload: null };
  let visible = false;
  let uploadedOnce = false;
  const setCalls = [];
  const fakeSpawn = (command, args, options = {}) => {
    if (args[0] === 'api') return { status: 0, stdout: JSON.stringify({ secrets: visible ? [{ name: core.SECRET_NAME }] : [] }), stderr: '' };
    if (args[0] === 'secret') {
      setCalls.push({ args: [...args], input: options.input });
      uploadedOnce = true;
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error('UNEXPECTED_FAKE_GH_COMMAND');
  };
  const output = { value: '', write(chunk) { this.value += chunk; } };
  try {
    await assert.rejects(provisionEnvironmentSecret({
      environment: 'catalog-test', role: 'test', field: 'testSecretUploaded', state, stateFile,
      paths: { keyDirectory }, testPem: pem, stablePem: '', spawn: fakeSpawn,
      prompts: { ask: async () => 'YES' }, output, persist: saveState,
    }), { code: 'SECRET_NOT_VISIBLE_CATALOG_TEST' });
    assert.equal(uploadedOnce, true);
    assert.deepEqual(state.pendingSecretUpload, { environment: 'catalog-test', keyId });
    assert.equal(await fs.readFile(path.join(keyDirectory, 'test-signing.pem'), 'utf8'), pem);
    assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).pendingSecretUpload.keyId, keyId);

    visible = true;
    await provisionEnvironmentSecret({
      environment: 'catalog-test', role: 'test', field: 'testSecretUploaded', state, stateFile,
      paths: { keyDirectory }, testPem: pem, stablePem: '', spawn: fakeSpawn,
      prompts: { ask: async prompt => { assert.match(prompt, /RESUME SECRET/); return 'RESUME SECRET'; } }, output, persist: saveState,
    });
    assert.equal(setCalls.length, 2);
    assert.equal(setCalls[0].input, pem);
    assert.equal(setCalls[1].input, pem);
    assert.equal(setCalls.some(call => call.args.includes(pem)), false);
    assert.equal(state.testSecretUploaded, true);
    assert.equal(state.pendingSecretUpload, null);
    assert.equal(JSON.stringify(state).includes(pem), false);
    await assert.rejects(fs.stat(path.join(keyDirectory, 'test-signing.pem')), { code: 'ENOENT' });
    assert.equal(output.value.includes(pem), false);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    pair.privateKey = null;
  }
});

test('Windows runtime preflight validates OS and Node version without connecting to GitHub', () => {
  assert.deepEqual(setupPreflight({ platform: 'win32', release: '10.0.26100', nodeMajor: 24, checkTools: false }), { windows11: true, nodeMajor: 24, toolsChecked: false });
  assert.throws(() => setupPreflight({ platform: 'win32', release: '10.0.20348', nodeMajor: 24, checkTools: false }), { code: 'WINDOWS_11_REQUIRED' });
  assert.throws(() => setupPreflight({ platform: 'win32', release: '10.0.26100', nodeMajor: 23, checkTools: false }), { code: 'NODE_24_REQUIRED' });
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
