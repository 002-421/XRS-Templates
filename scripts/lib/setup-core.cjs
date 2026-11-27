'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const protocol = require('./template-protocol.cjs');
const { OWNER_ID } = require('./publication-request.cjs');

const OWNER = '002-421';
const REPOSITORY = `${OWNER}/XRS-Templates`;
const ENVIRONMENTS = ['catalog-test', 'catalog-stable', 'catalog-root-recovery'];
const SECRET_NAME = 'TEMPLATE_SIGNING_PRIVATE_KEY';
const SECRET_RE = /-----BEGIN PRIVATE KEY-----/;

function makeKeySet({ now = Date.now(), generateKeyPair = crypto.generateKeyPairSync } = {}) {
  const generated = {};
  const keys = {};
  for (const role of ['root', 'test', 'stable']) {
    const pair = generateKeyPair('ed25519');
    const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const id = protocol.keyId(publicPem);
    if (keys[id]) throw new Error('KEY_ID_COLLISION');
    const challenge = protocol.bytes({ purpose: 'xrs-template-key-check', role, keyId: id });
    const signature = crypto.sign(null, challenge, pair.privateKey);
    if (!crypto.verify(null, challenge, pair.publicKey, signature)) throw new Error('KEY_PAIR_MISMATCH');
    generated[role] = { id, privatePem };
    keys[id] = publicPem;
  }

  const root = {
    schemaVersion: 1,
    type: 'xrs-template-root',
    version: 1,
    expiresAt: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
    keys,
    roles: {
      root: { keyIds: [generated.root.id], threshold: 1 },
      test: { keyIds: [generated.test.id], threshold: 1 },
      stable: { keyIds: [generated.stable.id], threshold: 1 },
    },
    revoked: [],
  };
  protocol.validateRoot(root, now);
  for (const role of ['root', 'test', 'stable']) {
    const material = generated[role];
    if (protocol.keyId(crypto.createPublicKey(material.privatePem).export({ type: 'spki', format: 'pem' })) !== material.id) {
      throw new Error('KEY_PAIR_MISMATCH');
    }
  }
  return { root, generated };
}

function validateSnapshot(snapshot) {
  const blockers = [];
  if (!snapshot || typeof snapshot !== 'object') return ['github.api.no_snapshot'];
  // Simplified Publishing v1 is provisioned only by the single approved owner.
  if (typeof snapshot.authenticatedUser !== 'string' || snapshot.authenticatedUser.length === 0) blockers.push('github.auth.user_unavailable');
  if (snapshot.authenticatedUser !== OWNER || snapshot.authenticatedUserId !== OWNER_ID) blockers.push('github.auth.owner_required');
  if (snapshot.repositoryAdmin !== true) blockers.push('github.repo.admin_required');
  if (snapshot.branchProtectionReadable !== true) blockers.push('github.protection.unreadable');
  else {
    const p = snapshot.branchProtection;
    if (!p?.required_pull_request_reviews) blockers.push('github.protection.pull_request_review_required');
    if (!p?.required_status_checks?.contexts?.includes('validate')) blockers.push('github.protection.validate_required');
    if (p?.enforce_admins?.enabled !== true) blockers.push('github.protection.admin_bypass_disabled');
  }
  for (const environment of ENVIRONMENTS) {
    const item = snapshot.environments?.[environment];
    if (!item?.readable) { blockers.push(`github.environment.${environment}.unreadable_or_missing`); continue; }
    const reviewers = (item.reviewers ?? []).map(x => typeof x === 'string' ? x : x.login ?? x.reviewer?.login).filter(Boolean);
    if (!reviewers.includes(OWNER)) blockers.push(`github.environment.${environment}.owner_reviewer_missing`);
    const branches = item.deploymentBranches ?? [];
    if (!branches.includes('main')) blockers.push(`github.environment.${environment}.main_policy_missing`);
  }
  const pending = snapshot.wizardState?.pendingSecretUpload;
  if (snapshot.existingTestSecret === true && snapshot.wizardState?.testSecretUploaded !== true && pending?.environment !== 'catalog-test') blockers.push('github.secret.catalog_test.exists_unowned');
  if (snapshot.existingStableSecret === true && snapshot.wizardState?.stableSecretUploaded !== true && pending?.environment !== 'catalog-stable') blockers.push('github.secret.catalog_stable.exists_unowned');
  return blockers;
}

function isInside(parent, target, pathApi = path) {
  const rel = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(target));
  return rel === '' || (!rel.startsWith(`..${pathApi.sep}`) && rel !== '..' && !pathApi.isAbsolute(rel));
}

function validateKeyDirectory({ repositoryRoot, keyDirectory, backupDirectory, platform = process.platform, pathApi = platform === 'win32' ? path.win32 : path }) {
  if (platform !== 'win32') throw new Error('WINDOWS_11_REQUIRED');
  const repo = pathApi.resolve(repositoryRoot);
  const keys = pathApi.resolve(keyDirectory);
  const backup = pathApi.resolve(backupDirectory);
  if (isInside(repo, keys, pathApi) || isInside(repo, backup, pathApi)) throw new Error('KEYS_MUST_BE_OUTSIDE_REPOSITORY');
  if (isInside(keys, backup, pathApi) || isInside(backup, keys, pathApi)) throw new Error('BACKUP_MUST_BE_SEPARATE_MEDIA');
  if (!/^[A-Za-z]:\\/.test(keys) || !/^[A-Za-z]:\\/.test(backup) || keys.slice(0, 2).toLowerCase() === backup.slice(0, 2).toLowerCase()) {
    throw new Error('BACKUP_MUST_BE_ON_DIFFERENT_DRIVE');
  }
  if (backup === pathApi.parse(backup).root) throw new Error('BACKUP_NEEDS_DEDICATED_DIRECTORY');
  return { keyDirectory: keys, backupDirectory: backup };
}

function encryptRootBackup(privatePem, passphrase, { randomBytes = crypto.randomBytes, scrypt = crypto.scryptSync } = {}) {
  if (typeof passphrase !== 'string' || passphrase.length < 14) throw new Error('BACKUP_PASSPHRASE_TOO_SHORT');
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = scrypt(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('XRS-Templates root key backup v1'));
  const encrypted = Buffer.concat([cipher.update(privatePem, 'utf8'), cipher.final()]);
  const header = Buffer.from(JSON.stringify({
    format: 'xrs-root-backup', version: 1, kdf: 'scrypt-32768-8-1', cipher: 'aes-256-gcm',
    salt: salt.toString('base64'), nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
  }) + '\n', 'utf8');
  return Buffer.concat([Buffer.from('XRSROOT1\n', 'ascii'), header, encrypted]);
}

function decryptRootBackup(raw, passphrase, { scrypt = crypto.scryptSync } = {}) {
  const data = Buffer.from(raw);
  if (!data.subarray(0, 9).equals(Buffer.from('XRSROOT1\n', 'ascii'))) throw new Error('BACKUP_FORMAT');
  const end = data.indexOf(0x0a, 9);
  if (end < 0 || end - 9 > 2048) throw new Error('BACKUP_FORMAT');
  let header;
  try { header = JSON.parse(data.subarray(9, end).toString('utf8')); } catch { throw new Error('BACKUP_FORMAT'); }
  if (header.format !== 'xrs-root-backup' || header.version !== 1 || header.kdf !== 'scrypt-32768-8-1' || header.cipher !== 'aes-256-gcm') throw new Error('BACKUP_FORMAT');
  try {
    const salt = Buffer.from(header.salt, 'base64');
    const nonce = Buffer.from(header.nonce, 'base64');
    const tag = Buffer.from(header.tag, 'base64');
    if (salt.length !== 16 || nonce.length !== 12 || tag.length !== 16) throw new Error('BACKUP_FORMAT');
    const key = scrypt(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from('XRS-Templates root key backup v1'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data.subarray(end + 1)), decipher.final()]).toString('utf8');
  } catch { throw new Error('BACKUP_AUTHENTICATION_FAILED'); }
}

function githubSecretArgs(environment) {
  if (!['catalog-test', 'catalog-stable'].includes(environment)) throw new Error('INVALID_SIGNING_ENVIRONMENT');
  return ['secret', 'set', SECRET_NAME, '--env', environment, '--repo', REPOSITORY];
}

function setEnvironmentSecret(spawnSync, environment, privatePem) {
  if (typeof privatePem !== 'string' || !SECRET_RE.test(privatePem)) throw new Error('PRIVATE_KEY_REQUIRED');
  const args = githubSecretArgs(environment);
  const result = spawnSync('gh', args, { input: privatePem, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`SECRET_UPLOAD_FAILED_${environment.replaceAll('-', '_').toUpperCase()}`);
  return { environment, secretName: SECRET_NAME, uploaded: true };
}

function secretListHas(spawnSync, environment) {
  const result = spawnSync('gh', ['api', `repos/${REPOSITORY}/environments/${environment}/secrets`], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`SECRET_LIST_UNAVAILABLE_${environment.replaceAll('-', '_').toUpperCase()}`);
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw new Error('GITHUB_RESPONSE_INVALID'); }
  return Array.isArray(data.secrets) && data.secrets.some(item => item.name === SECRET_NAME);
}

function safeState(state) {
  const serialized = JSON.stringify(state);
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(serialized)) throw new Error('PRIVATE_KEY_IN_STATE');
  return serialized;
}

module.exports = {
  OWNER, REPOSITORY, ENVIRONMENTS, SECRET_NAME, makeKeySet, validateSnapshot,
  validateKeyDirectory, encryptRootBackup, decryptRootBackup, githubSecretArgs,
  setEnvironmentSecret, secretListHas, safeState,
};
