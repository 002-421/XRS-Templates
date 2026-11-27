'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const p = require('../scripts/lib/template-protocol.cjs');
const r = require('../scripts/lib/publication-request.cjs');
const { GitHubPublisher, createGh, verifyCredentialStatus } = require('../scripts/lib/github-publisher.cjs');
const { approvalRecord } = require('../scripts/approval-record.cjs');
const { loadSources, validateProposal, schemas } = require('../scripts/validate.cjs');
const { makeProposal } = require('../scripts/admin-server.cjs');
const core = require('../scripts/lib/setup-core.cjs');
const { receiveRequest } = require('../scripts/receive-request.cjs');
const { handleCommand } = require('../scripts/publisher-admin.cjs');

const now = () => Date.now();
const request = (channel = 'test', proposals = [{ channel, template: { id: 'synthetic' }, medicalApproval: { approved: true } }]) => ({
  schemaVersion: 1, type: 'xrs-template-publication-request', requestId: crypto.randomUUID(), channel,
  createdAt: new Date(now()).toISOString(), expiresAt: new Date(now() + 3600000).toISOString(),
  publisher: { id: r.OWNER_ID, login: r.OWNER },
  expectedCatalog: { version: '0.0.0', sequence: 0, manifestSha256: null }, proposals,
});
const keyring = () => ({ hosts: { 'github.com': [{ state: 'success', login: r.OWNER, active: true, tokenSource: 'keyring' }] } });

function apiFixture(data) {
  const raw = p.bytes(data), commit = 'c'.repeat(40), tree = 'd'.repeat(40), blob = 'e'.repeat(40), main = 'a'.repeat(40);
  const staged = { requestId: data.requestId, commit, hash: p.sha256(raw), status: 'prepared', reused: false };
  const calls = [];
  let exists = true, runs = [], dispatchMarker = null;
  const api = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (endpoint === '/user') return { login: r.OWNER, id: r.OWNER_ID, type: 'User' };
    const route = endpoint.replace(`/repos/${r.REPOSITORY}`, '');
    if (route === '') return { full_name: r.REPOSITORY, permissions: { push: true } };
    if (method === 'POST') {
      if (route === '/git/blobs') return { sha: blob };
      if (route === '/git/trees') return { sha: tree };
      if (route === '/git/commits') return { sha: commit };
      if (route === '/git/refs') {
        if (body.ref.startsWith('refs/heads/xrs-dispatches/')) dispatchMarker = { ref: body.ref, object: { sha: body.sha } };
        else exists = true;
        return { ref: body.ref, object: { sha: body.sha } };
      }
      if (route.includes('/dispatches')) return null;
      if (route.includes('/pending_deployments')) return [];
    }
    if (route === '/git/ref/heads/main') return { object: { sha: main } };
    if (route === `/git/ref/heads/xrs-dispatches/${data.requestId}`) {
      if (!dispatchMarker) throw Object.assign(new Error('NOT_FOUND'), { httpStatus: 404 });
      return dispatchMarker;
    }
    if (route === `/git/ref/heads/xrs-submissions/${data.requestId}`) {
      if (!exists) throw Object.assign(new Error('NOT_FOUND'), { httpStatus: 404 });
      return { ref: r.reference(data.requestId), object: { type: 'commit', sha: commit } };
    }
    if (route === `/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
    if (route === `/git/trees/${tree}`) return { truncated: false, tree: [{ path: 'request.json', type: 'blob', mode: '100644', size: raw.length, sha: blob }] };
    if (route === `/git/blobs/${blob}`) return { sha: blob, encoding: 'base64', size: raw.length, content: raw.toString('base64') };
    if (route.includes('/runs?event=')) return { workflow_runs: runs };
    if (route.endsWith('/jobs?per_page=100')) return { total_count: 2, jobs: [{ name: 'validate', conclusion: 'success' }] };
    if (route.endsWith('/pending_deployments')) return [{ environment: { id: 17, name: `catalog-${data.channel}` }, current_user_can_approve: true }];
    throw new Error('UNEXPECTED_FIXTURE_ENDPOINT');
  };
  return { staged, calls, api, setExists: value => { exists = value; }, setRuns: value => { runs = value; }, setMarker: value => { dispatchMarker = value; }, publisher: new GitHubPublisher({ gh: { api, status: keyring }, platform: 'win32', env: {}, validate: async snapshot => ({ hash: p.sha256(p.bytes(snapshot)) }) }), main };
}

test('real proposal validation runs before any public data upload', async () => {
  const f = apiFixture(request());
  f.publisher.validate = require('../scripts/lib/publication-validation.cjs').validateContent;
  await assert.rejects(() => f.publisher.stage(request()), /JSON_SCHEMA/);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('persistent administrator auth accepts Windows keyring and rejects plaintext, env tokens, wrong identities and JSON auth errors', async () => {
  assert.equal(verifyCredentialStatus(keyring(), { platform: 'win32', env: {} }).login, r.OWNER);
  for (const tokenSource of ['GH_TOKEN', 'C:\\Users\\fixture\\hosts.yml', 'oauth_token']) {
    const status = keyring(); status.hosts['github.com'][0].tokenSource = tokenSource;
    assert.throws(() => verifyCredentialStatus(status, { platform: 'win32', env: {} }), /SECURE_OWNER_LOGIN_REQUIRED/);
  }
  const bad = keyring(); bad.hosts['github.com'][0].state = 'error';
  assert.throws(() => verifyCredentialStatus(bad, { platform: 'win32', env: {} }), /SECURE_OWNER_LOGIN_REQUIRED/);
  assert.throws(() => verifyCredentialStatus(keyring(), { platform: 'win32', env: { GH_TOKEN: 'synthetic-secret' } }), /ENVIRONMENT_CREDENTIAL_FORBIDDEN/);
  const f = apiFixture(request());
  f.publisher.gh.api = async (method, endpoint, body) => endpoint === '/user' ? { login: r.OWNER, id: 123, type: 'User' } : f.api(method, endpoint, body);
  await assert.rejects(() => f.publisher.authorize(), /PUBLISHER_IDENTITY/);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('request staging writes only a data branch, reuses exact immutable requests, and never creates PRs or writes main', async () => {
  const data = request(), f = apiFixture(data); f.setExists(false);
  const first = await f.publisher.stage(data);
  assert.equal(first.status, 'prepared'); assert.equal(first.reused, false);
  assert.equal((await f.publisher.stage(data)).reused, true);
  const posts = f.calls.filter(call => call.method === 'POST');
  assert.deepEqual(posts.map(call => call.endpoint.split(r.REPOSITORY)[1]), ['/git/blobs', '/git/trees', '/git/commits', '/git/refs']);
  assert.equal(posts.at(-1).body.ref, r.reference(data.requestId));
  assert.equal(posts[1].body.tree.length, 1); assert.equal(posts[1].body.tree[0].path, 'request.json');
  await assert.rejects(() => f.publisher.stage({ ...data, channel: 'stable', proposals: [{ ...data.proposals[0], channel: 'stable' }] }), /REQUEST_HASH/);
  assert.equal(f.calls.some(call => /pulls|secrets|environments|branches\/main\/protection/.test(call.endpoint)), false);
});

test('request validation rejects malicious trees, changed refs, bad hashes, duplicate IDs, wrong channel, expiry, and stale catalogs', async () => {
  const data = request(), f = apiFixture(data);
  const opts = { requestId: data.requestId, commit: f.staged.commit, hash: f.staged.hash, channel: 'test' };
  await r.readRequest((m, e, b) => f.api(m, `/repos/${r.REPOSITORY}${e}`, b), opts);
  await assert.rejects(() => r.readRequest((m, e, b) => f.api(m, `/repos/${r.REPOSITORY}${e}`, b), { ...opts, hash: '0'.repeat(64) }), /REQUEST_HASH/);
  await assert.rejects(() => r.readRequest(async (m, e, b) => e.startsWith('/git/trees/') ? { truncated: false, tree: [{ path: '../script.js' }] } : f.api(m, `/repos/${r.REPOSITORY}${e}`, b), opts), /REQUEST_TREE/);
  await assert.rejects(() => r.readRequest((m, e, b) => f.api(m, `/repos/${r.REPOSITORY}${e}`, b), { ...opts, commit: '0'.repeat(40) }), /REQUEST_REF_CHANGED/);
  assert.throws(() => r.validateRequest(data, { channel: 'stable' }), /CHANNEL/);
  assert.throws(() => r.validateRequest({ ...data, proposals: [...data.proposals, ...data.proposals] }), /DUPLICATE_ID/);
  assert.throws(() => r.validateRequest({ ...data, expiresAt: data.createdAt }), /REQUEST_EXPIRED/);
  assert.throws(() => r.bindCatalog({ ...data, expectedCatalog: { version: '1.0.0', sequence: 1, manifestSha256: 'a'.repeat(64) } }, null), /CATALOG_BASE_CONFLICT/);
  const previous = p.bytes({ signed: { catalogVersion: '1.0.0', sequence: 1 } });
  assert.throws(() => r.bindCatalog(data, previous), /CATALOG_BASE_CONFLICT/);
});

test('dispatch needs explicit Stable consent and reports submitted, never published; review binds owner/run/hash/version and validation', async () => {
  const data = request('stable'), f = apiFixture(data);
  await assert.rejects(() => f.publisher.dispatch(f.staged, { confirmed: true }), /PUBLICATION_CONFIRMATION_REQUIRED/);
  const submitted = await f.publisher.dispatch(f.staged, { confirmed: true, stableConfirmed: true });
  assert.equal(submitted.status, 'submitted');
  assert.equal(f.calls.filter(call => call.endpoint.endsWith('/dispatches')).length, 1);
  const run = { id: 45, actor: { id: r.OWNER_ID }, head_branch: 'main', head_sha: f.main, path: '.github/workflows/publish-catalog.yml', display_title: r.runTitle(data.requestId, f.staged.hash), status: 'waiting', conclusion: null };
  f.setRuns([run]);
  const confirm = { confirmed: true, runId: 45, workflowSha: f.main, hash: f.staged.hash, channel: 'stable', catalogVersion: '1.0.0' };
  await assert.rejects(() => f.publisher.approve(f.staged, { ...confirm, hash: 'a'.repeat(64) }), /ENVIRONMENT_CONFIRMATION_REQUIRED/);
  await assert.rejects(() => f.publisher.approve(f.staged, { ...confirm, catalogVersion: '1.0.1' }), /ENVIRONMENT_CONFIRMATION_REQUIRED/);
  assert.equal((await f.publisher.approve(f.staged, confirm)).status, 'approved-awaiting-publication');
  const approval = f.calls.find(call => call.method === 'POST' && call.endpoint.endsWith('/pending_deployments'));
  assert.deepEqual(approval.body.environment_ids, [17]);
  assert.equal((await f.publisher.dispatch(f.staged, { confirmed: true, stableConfirmed: true })).status, 'awaiting-workflow');
  assert.equal(f.calls.filter(call => call.endpoint.endsWith('/dispatches')).length, 1);
  f.setRuns([{ ...run, status: 'completed', conclusion: 'failure' }]);
  assert.equal((await f.publisher.status(f.staged)).status, 'failed');
});

test('403, unavailable reviewer, incomplete validation and ambiguous retries cannot approve or silently retry', async () => {
  const data = request(), f = apiFixture(data);
  f.setMarker({ object: { sha: f.staged.commit } });
  await assert.rejects(() => f.publisher.dispatch(f.staged, { confirmed: true }), /DISPATCH_STATUS_UNKNOWN/);
  const run = { id: 55, actor: { id: r.OWNER_ID }, head_branch: 'main', head_sha: f.main, path: '.github/workflows/publish-catalog.yml', display_title: r.runTitle(data.requestId, f.staged.hash), status: 'waiting' };
  f.setRuns([run]);
  const confirmation = { confirmed: true, runId: 55, workflowSha: f.main, hash: f.staged.hash, channel: 'test', catalogVersion: '1.0.0' };
  for (const mode of ['forbidden', 'reviewer', 'validation']) {
    f.publisher.gh.api = async (m, e, b) => {
      if (e.endsWith('/pending_deployments') && mode === 'forbidden') throw Object.assign(new Error('GITHUB_REQUEST_FAILED'), { httpStatus: 403 });
      if (e.endsWith('/pending_deployments') && mode === 'reviewer') return [{ environment: { id: 17, name: 'catalog-test' }, current_user_can_approve: false }];
      if (e.includes('/jobs?') && mode === 'validation') return { total_count: 1, jobs: [{ name: 'validate', conclusion: 'failure' }] };
      return f.api(m, e, b);
    };
    await assert.rejects(() => f.publisher.approve(f.staged, confirmation), /GITHUB_REQUEST_FAILED|ENVIRONMENT_REVIEW_UNAVAILABLE|VALIDATION_REQUIRED/);
  }
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('gh transport uses stdin, handles HTTP 204, strips debug and does not expose secret-bearing errors', () => {
  const calls = [];
  const gh = createGh({ env: { GH_DEBUG: 'api', DEBUG: '1' }, spawn: (command, args, options) => { calls.push({ command, args, options }); return { status: 0, stdout: '' }; } });
  assert.equal(gh.api('POST', `/repos/${r.REPOSITORY}/actions/workflows/publish-catalog.yml/dispatches`, { fixture: 'synthetic-content' }), null);
  assert.equal(calls[0].args.includes('synthetic-content'), false);
  assert.equal(calls[0].options.env.GH_DEBUG, undefined);
  assert.match(calls[0].options.input, /synthetic-content/);
  const failed = createGh({ spawn: () => ({ status: 1, stderr: 'HTTP 403 synthetic-sensitive-value', stdout: '' }) });
  assert.throws(() => failed.api('GET', '/user'), error => error.code === 'GITHUB_REQUEST_FAILED' && error.httpStatus === 403 && !String(error).includes('sensitive'));
});

test('administrative stdio commands require public-data consent and reject arbitrary API or shell operations', async () => {
  let called = false;
  const publisher = { stage: async () => { called = true; return { status: 'prepared' }; } };
  await assert.rejects(() => handleCommand({ operation: 'stage', request: request(), publicUploadConfirmed: false }, publisher), /PUBLIC_DATA_CONFIRMATION_REQUIRED/);
  assert.equal(called, false);
  await assert.rejects(() => handleCommand({ operation: 'shell', command: 'echo synthetic' }, publisher), /ADMIN_COMMAND/);
  assert.equal((await handleCommand({ operation: 'stage', request: request(), publicUploadConfirmed: true }, publisher)).status, 'prepared');
});

test('signed publisher consumes a data request without incoming/ changes and rejects mismatched approval binding', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xrs-request-publisher-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of ['scripts', 'schemas', 'sources', 'baseline.json']) await fs.cp(path.join(__dirname, '..', name), path.join(directory, name), { recursive: true });
  await fs.mkdir(path.join(directory, 'incoming')); await fs.mkdir(path.join(directory, 'trust'));
  const keys = core.makeKeySet(); await fs.writeFile(path.join(directory, 'trust/root.json'), p.bytes(keys.root));
  const { sources, baseline } = await loadSources(), before = sources.values().next().value, after = structuredClone(before);
  after.templateVersion = '0.0.2'; after.title += ' synthetic test only';
  const proposal = makeProposal(before, after, 'Synthetic change, never publish', 'Synthetic approval', { channel: 'test', allowedImages: baseline.allowedImages });
  await validateProposal(p.bytes(proposal), sources, baseline, await schemas());
  const data = request('test', [proposal]), raw = p.bytes(data), hash = p.sha256(raw);
  await fs.writeFile(path.join(directory, 'publication-request.json'), raw);
  const env = { ...process.env, NODE_PATH: path.join(__dirname, '../node_modules'), GITHUB_REPOSITORY: r.REPOSITORY, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_ACTOR: r.OWNER, GITHUB_ACTOR_ID: String(r.OWNER_ID), REQUEST_ID: data.requestId, REQUEST_COMMIT: 'c'.repeat(40), REQUEST_SHA256: hash, CATALOG_CHANNEL: 'test', MEDICAL_APPROVAL: 'true', WORKING_CATALOG_APPROVAL: 'false', BOOTSTRAP_CATALOG: 'false', PROPOSAL_FILE: '', TEMPLATE_SIGNING_PRIVATE_KEY: keys.generated.test.privatePem };
  const transport = apiFixture(data), api = (method, endpoint, body) => transport.api(method, `/repos/${r.REPOSITORY}${endpoint}`, body);
  assert.deepEqual((await receiveRequest({ env, api, directory })).raw, raw);
  await assert.rejects(() => receiveRequest({ env: { ...env, GITHUB_ACTOR_ID: '123' }, api, directory }), /PUBLISHER_IDENTITY/);
  await assert.rejects(() => receiveRequest({ env: { ...env, REQUEST_COMMIT: '' }, api, directory }), /REQUEST_INPUT_CONFLICT/);
  const approval = approvalRecord([{ state: 'approved', environments: [{ name: 'catalog-test' }], user: { login: r.OWNER, id: r.OWNER_ID } }], env);
  await fs.writeFile(path.join(directory, 'approval-record.json'), p.bytes({ ...approval, requestSha256: '0'.repeat(64) }));
  assert.throws(() => execFileSync(process.execPath, ['scripts/publish.cjs'], { cwd: directory, env, stdio: 'pipe' }), error => String(error.stderr).includes('APPROVAL_REQUEST_BINDING'));
  await fs.writeFile(path.join(directory, 'approval-record.json'), p.bytes(approval));
  execFileSync(process.execPath, ['scripts/publish.cjs'], { cwd: directory, env, stdio: 'pipe' });
  const manifest = p.verify(p.parse(await fs.readFile(path.join(directory, 'out/manifest.json'))), keys.root, 'test');
  assert.equal(manifest.catalogVersion, '1.0.0'); assert.equal(manifest.packages.length, 1);
  const entry = manifest.packages[0], zip = await fs.readFile(path.join(directory, 'out', `${after.id}-${after.templateVersion}.xrszip`));
  assert.deepEqual(p.readPackage(zip, entry, keys.root, { channel: 'test', appVersion: '0.4.86', allowedImages: baseline.allowedImages }), after);
  assert.equal((await fs.readdir(path.join(directory, 'incoming'))).length, 0);
  for (const wrongRole of ['test', 'root']) {
    assert.throws(() => execFileSync(process.execPath, ['scripts/publish.cjs'], { cwd: directory, env: { ...env, CATALOG_CHANNEL: 'stable', WORKING_CATALOG_APPROVAL: 'true', TEMPLATE_SIGNING_PRIVATE_KEY: keys.generated[wrongRole].privatePem }, stdio: 'pipe' }), error => String(error.stderr).includes('KEY'));
  }
  assert.throws(() => approvalRecord([{ state: 'approved', environments: [{ name: 'catalog-test' }], user: { login: 'synthetic-other', id: 321 } }], env), /PUBLISHER_IDENTITY/);
});
