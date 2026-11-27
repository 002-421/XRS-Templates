'use strict';

const p = require('./template-protocol.cjs');
const OWNER = '002-421';
const OWNER_ID = 210672295;
const REPOSITORY = '002-421/XRS-Templates';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;

function validateRequest(request, { now = Date.now(), channel,expiry=true } = {}) {
  p.keys(request, ['schemaVersion', 'type', 'requestId', 'channel', 'createdAt', 'expiresAt', 'publisher', 'expectedCatalog', 'proposals']);
  p.check(request.schemaVersion === 1 && request.type === 'xrs-template-publication-request', 'REQUEST_SCHEMA');
  p.check(UUID.test(request.requestId), 'REQUEST_ID');
  p.check(['test', 'stable'].includes(request.channel) && (!channel || channel === request.channel), 'CHANNEL');
  p.keys(request.publisher, ['login', 'id']);
  p.check(request.publisher.login === OWNER && request.publisher.id === OWNER_ID, 'PUBLISHER_IDENTITY');
  for (const name of ['createdAt', 'expiresAt']) p.check(typeof request[name] === 'string' && Number.isFinite(Date.parse(request[name])) && new Date(request[name]).toISOString() === request[name], 'REQUEST_DATE');
  p.check(Date.parse(request.createdAt) <= now + 300000 && (!expiry||Date.parse(request.expiresAt) > now) && Date.parse(request.expiresAt) > Date.parse(request.createdAt) && Date.parse(request.expiresAt) - Date.parse(request.createdAt) <= 86400000, 'REQUEST_EXPIRED');
  p.keys(request.expectedCatalog, ['version', 'sequence', 'manifestSha256']);
  const expected = request.expectedCatalog;
  p.version(expected.version);
  p.check(Number.isSafeInteger(expected.sequence) && expected.sequence >= 0 && (expected.sequence === 0 ? expected.version === '0.0.0' && expected.manifestSha256 === null : HASH.test(expected.manifestSha256)), 'REQUEST_BASE');
  p.check(Array.isArray(request.proposals) && request.proposals.length > 0 && request.proposals.length <= 50, 'REQUEST_COUNT');
  p.check(p.bytes(request).length <= p.LIMITS.json, 'SIZE');
  p.check(new Set(request.proposals.map(row => row.template?.id)).size === request.proposals.length, 'DUPLICATE_ID');
  p.check(request.proposals.filter(row=>row.template?.retired===true).length<=1,'MASS_REMOVAL_BLOCKED');
  for (const proposal of request.proposals) p.check(proposal.channel === request.channel && proposal.medicalApproval?.approved === true, 'APPROVAL_REQUIRED');
  return request;
}

function bindCatalog(request, previousRaw) {
  const expected = request.expectedCatalog;
  if (!previousRaw) { p.check(expected.sequence === 0, 'CATALOG_BASE_CONFLICT'); return; }
  // The caller must authenticate previousRaw with applyPublishedSources first.
  const previous = p.parse(previousRaw).signed;
  p.check(expected.sequence === previous.sequence && expected.version === previous.catalogVersion && expected.manifestSha256 === p.sha256(previousRaw), 'CATALOG_BASE_CONFLICT');
}

function reference(requestId) {
  p.check(UUID.test(requestId), 'REQUEST_ID');
  return `refs/heads/xrs-submissions/${requestId}`;
}

function runTitle(requestId, hash) {
  p.check(UUID.test(requestId) && HASH.test(hash), 'REQUEST_BINDING');
  return `XRS request ${requestId} ${hash}`;
}

function nextCatalogVersion(request) {
  if (request.expectedCatalog.sequence === 0) return '1.0.0';
  const parts = request.expectedCatalog.version.split('.').map(Number);
  parts[2]++;
  return p.version(parts.join('.'));
}

async function readRequest(api, { requestId, commit, hash, channel, now,allowExpired=false }) {
  p.check(COMMIT.test(commit) && HASH.test(hash), 'REQUEST_BINDING');
  const ref = await api('GET', `/git/ref/heads/xrs-submissions/${validateId(requestId)}`);
  p.check(ref.ref === reference(requestId) && ref.object?.type === 'commit' && ref.object.sha === commit, 'REQUEST_REF_CHANGED');
  const record = await api('GET', `/git/commits/${commit}`);
  p.check(record.sha === commit && COMMIT.test(record.tree?.sha), 'REQUEST_COMMIT');
  const tree = await api('GET', `/git/trees/${record.tree.sha}`);
  p.check(tree.truncated === false && tree.tree?.length === 1, 'REQUEST_TREE');
  const entry = tree.tree[0];
  p.check(entry.path === 'request.json' && entry.mode === '100644' && entry.type === 'blob' && COMMIT.test(entry.sha) && Number.isInteger(entry.size) && entry.size > 0 && entry.size <= p.LIMITS.json, 'REQUEST_TREE');
  const blob = await api('GET', `/git/blobs/${entry.sha}`);
  p.check(blob.sha === entry.sha && blob.encoding === 'base64' && blob.size === entry.size && typeof blob.content === 'string' && blob.content.length <= p.LIMITS.json * 2, 'REQUEST_BLOB');
  const bytes = Buffer.from(blob.content, 'base64');
  p.check(bytes.length === entry.size && p.sha256(bytes) === hash, 'REQUEST_HASH');
  const request = validateRequest(p.parse(bytes), { channel, now,expiry:!allowExpired });
  p.check(request.requestId === requestId, 'REQUEST_BINDING');
  return { request, raw: bytes };
}

function validateId(id) { p.check(typeof id === 'string' && UUID.test(id), 'REQUEST_ID'); return id; }

module.exports = { OWNER, OWNER_ID, REPOSITORY, UUID, COMMIT, HASH, validateRequest, bindCatalog, reference, runTitle, nextCatalogVersion, readRequest };
