'use strict';

// Administrative-process API only. No HTTP server, renderer or signing key.
const { spawnSync } = require('node:child_process');
const p = require('./template-protocol.cjs');
const r = require('./publication-request.cjs');
const { validateContent } = require('./publication-validation.cjs');

function createGh({ spawn = spawnSync, env = process.env } = {}) {
  const safeEnv = { ...env };
  delete safeEnv.GH_DEBUG;
  delete safeEnv.DEBUG;
  function execute(args, input) {
    const result = spawn('gh', args, { input, env: safeEnv, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      const error = Object.assign(new Error('GITHUB_REQUEST_FAILED'), { code: 'GITHUB_REQUEST_FAILED' });
      const status = /HTTP (\d{3})/.exec(result.stderr ?? '');
      if (status) error.httpStatus = Number(status[1]);
      throw error;
    }
    if (!result.stdout.trim()) return null; // A successful workflow dispatch returns HTTP 204.
    try { return JSON.parse(result.stdout); } catch { p.fail('GITHUB_RESPONSE_INVALID'); }
  }
  return {
    status: () => execute(['auth', 'status', '--hostname', 'github.com', '--active', '--json', 'hosts']),
    api: (method, endpoint, body) => {
      p.check(['GET', 'POST'].includes(method) && /^\/(?:user$|repos\/002-421\/XRS-Templates(?:\/|$))/.test(endpoint) && !endpoint.includes('..') && !endpoint.includes('#'), 'GITHUB_ENDPOINT');
      const args = ['api', '--hostname', 'github.com', '--method', method, endpoint];
      if (body !== undefined) args.push('--input', '-');
      return execute(args, body === undefined ? undefined : JSON.stringify(body));
    },
  };
}

function verifyCredentialStatus(status, { platform = process.platform, env = process.env } = {}) {
  p.check(platform === 'win32', 'WINDOWS_11_REQUIRED');
  p.check(!['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'].some(name => env[name]), 'ENVIRONMENT_CREDENTIAL_FORBIDDEN');
  const rows = status?.hosts?.['github.com'];
  p.check(Array.isArray(rows) && rows.filter(row => row.active).length === 1, 'GITHUB_LOGIN_REQUIRED');
  const active = rows.find(row => row.active);
  p.check(active.state === 'success' && active.login === r.OWNER && active.tokenSource === 'keyring' && !active.token, 'SECURE_OWNER_LOGIN_REQUIRED');
  return { login: active.login, storage: 'windows-credential-manager' };
}

class GitHubPublisher {
  constructor({ gh = createGh(), platform = process.platform, env = process.env, now = () => Date.now(), validate = validateContent } = {}) {
    this.gh = gh; this.platform = platform; this.env = env; this.now = now; this.validate = validate;
  }
  api(method, path, body) { return this.gh.api(method, `/repos/${r.REPOSITORY}${path}`, body); }
  async authorize() {
    verifyCredentialStatus(await this.gh.status(), { platform: this.platform, env: this.env });
    const user = await this.gh.api('GET', '/user');
    p.check(user.id === r.OWNER_ID && user.login === r.OWNER && user.type === 'User', 'PUBLISHER_IDENTITY');
    const repo = await this.api('GET', '');
    p.check(repo.full_name === r.REPOSITORY && repo.permissions?.push === true, 'PUBLISHER_PERMISSION');
    return { login: user.login, id: user.id };
  }
  async stage(request) {
    request = p.parse(p.bytes(request)); // Immutable snapshot before asynchronous validation.
    await this.authorize(); r.validateRequest(request, { now: this.now() });
    const checked = await this.validate(request);
    p.check(checked?.hash === p.sha256(p.bytes(request)), 'LOCAL_VALIDATION_REQUIRED');
    const raw = p.bytes(request), hash = p.sha256(raw), refName = r.reference(request.requestId);
    // An existing request cannot be overwritten, even on retry.
    let existing;
    try { existing = await this.api('GET', `/git/ref/heads/xrs-submissions/${request.requestId}`); }
    catch (error) { if (error.httpStatus !== 404) throw error; }
    if (existing) {
      const commit = existing.object?.sha;
      await r.readRequest(this.api.bind(this), { requestId: request.requestId, commit, hash, channel: request.channel, now: this.now() });
      return { requestId: request.requestId, commit, hash, status: 'prepared', reused: true };
    }
    const main = await this.api('GET', '/git/ref/heads/main');
    p.check(r.COMMIT.test(main.object?.sha), 'WORKFLOW_SHA');
    const blob = await this.api('POST', '/git/blobs', { encoding: 'base64', content: raw.toString('base64') });
    p.check(r.COMMIT.test(blob.sha), 'REQUEST_BLOB');
    const tree = await this.api('POST', '/git/trees', { tree: [{ path: 'request.json', mode: '100644', type: 'blob', sha: blob.sha }] });
    p.check(r.COMMIT.test(tree.sha), 'REQUEST_TREE');
    const commit = await this.api('POST', '/git/commits', { message: `XRS data request ${request.requestId}`, tree: tree.sha, parents: [main.object.sha] });
    p.check(r.COMMIT.test(commit.sha), 'REQUEST_COMMIT');
    await this.api('POST', '/git/refs', { ref: refName, sha: commit.sha });
    await r.readRequest(this.api.bind(this), { requestId: request.requestId, commit: commit.sha, hash, channel: request.channel, now: this.now() });
    return { requestId: request.requestId, commit: commit.sha, hash, status: 'prepared', reused: false };
  }
  async dispatch(staged, { confirmed = false, stableConfirmed = false } = {}) {
    await this.authorize();
    const { request } = await r.readRequest(this.api.bind(this), { requestId: staged.requestId, commit: staged.commit, hash: staged.hash, now: this.now() });
    p.check(confirmed === true && (request.channel !== 'stable' || stableConfirmed === true), 'PUBLICATION_CONFIRMATION_REQUIRED');
    const main = await this.api('GET', '/git/ref/heads/main');
    p.check(r.COMMIT.test(main.object?.sha), 'WORKFLOW_SHA');
    // Do not retry an ambiguous dispatch automatically: status() locates the run.
    const prior = await this.status(staged);
    if (prior.status !== 'not-started') return prior;
    // Persist a remote attempt marker before dispatch. Even a new process cannot
    // silently dispatch twice after an interrupted or ambiguous API response.
    let marker;
    try { marker = await this.api('GET', `/git/ref/heads/xrs-dispatches/${request.requestId}`); }
    catch (error) { if (error.httpStatus !== 404) throw error; }
    p.check(!marker, 'DISPATCH_STATUS_UNKNOWN');
    await this.api('POST', '/git/refs', { ref: `refs/heads/xrs-dispatches/${request.requestId}`, sha: staged.commit });
    await this.api('POST', '/actions/workflows/publish-catalog.yml/dispatches', { ref: 'main', inputs: { request_id: staged.requestId, request_commit: staged.commit, request_sha256: staged.hash, channel: request.channel, approved: true, stable_content_approved: stableConfirmed === true } });
    return { status: 'submitted', workflowSha: main.object.sha, requestId: staged.requestId, hash: staged.hash };
  }
  async status(staged) {
    await this.authorize();
    const title = r.runTitle(staged.requestId, staged.hash);
    // Bounded search; an old request outside this window needs owner diagnosis.
    const rows = await this.api('GET', '/actions/workflows/publish-catalog.yml/runs?event=workflow_dispatch&per_page=100');
    const runs = (rows.workflow_runs ?? []).filter(run => run.display_title === title);
    p.check(runs.length <= 1, 'DUPLICATE_PUBLICATION_RUN');
    if (!runs.length) return { status: 'not-started', requestId: staged.requestId };
    const run = runs[0];
    p.check(Number.isSafeInteger(run.id) && run.id > 0 && run.actor?.id === r.OWNER_ID && run.head_branch === 'main' && r.COMMIT.test(run.head_sha) && run.path === '.github/workflows/publish-catalog.yml', 'WORKFLOW_CONTEXT');
    return { status: run.status === 'completed' ? run.conclusion === 'success' ? 'workflow-succeeded' : 'failed' : 'awaiting-workflow', runId: run.id, workflowSha: run.head_sha, requestId: staged.requestId, hash: staged.hash, url: `https://github.com/${r.REPOSITORY}/actions/runs/${run.id}` };
  }
  async approve(staged, confirmation) {
    await this.authorize();
    const { request } = await r.readRequest(this.api.bind(this), { requestId: staged.requestId, commit: staged.commit, hash: staged.hash, now: this.now() });
    const current = await this.status(staged);
    p.check(confirmation?.confirmed === true && current.status === 'awaiting-workflow' && confirmation.runId === current.runId && confirmation.workflowSha === current.workflowSha && confirmation.hash === staged.hash && confirmation.channel === request.channel && confirmation.catalogVersion === r.nextCatalogVersion(request), 'ENVIRONMENT_CONFIRMATION_REQUIRED');
    const jobs = await this.api('GET', `/actions/runs/${current.runId}/jobs?per_page=100`);
    p.check(jobs.total_count <= 100 && jobs.jobs?.some(job => job.name === 'validate' && job.conclusion === 'success'), 'VALIDATION_REQUIRED');
    const pending = await this.api('GET', `/actions/runs/${current.runId}/pending_deployments`);
    const target = pending.find(row => row.environment?.name === `catalog-${request.channel}`);
    p.check(target?.current_user_can_approve === true && Number.isSafeInteger(target.environment.id), 'ENVIRONMENT_REVIEW_UNAVAILABLE');
    await this.api('POST', `/actions/runs/${current.runId}/pending_deployments`, { environment_ids: [target.environment.id], state: 'approved', comment: `XRS request ${request.requestId}, sha256 ${staged.hash}` });
    return { status: 'approved-awaiting-publication', runId: current.runId, requestId: request.requestId };
  }
}

module.exports = { createGh, verifyCredentialStatus, GitHubPublisher };
