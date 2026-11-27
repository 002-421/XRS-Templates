'use strict';

// Fetch data through the API; never checkout or execute a submissions branch.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const p = require('./lib/template-protocol.cjs');
const r = require('./lib/publication-request.cjs');
const { createGh } = require('./lib/github-publisher.cjs');
const { schemas, loadSources, validateProposal } = require('./validate.cjs');
const { applyPublishedSources } = require('./current-sources.cjs');

async function receiveRequest({ env = process.env, api, now = Date.now(), directory = process.cwd() } = {}) {
  const supplied = [env.REQUEST_ID, env.REQUEST_COMMIT, env.REQUEST_SHA256].filter(Boolean);
  if (!supplied.length) return null; // Existing bootstrap/legacy workflow stays available.
  p.check(supplied.length === 3 && !env.PROPOSAL_FILE && env.BOOTSTRAP_CATALOG !== 'true', 'REQUEST_INPUT_CONFLICT');
  p.check(env.GITHUB_REPOSITORY === r.REPOSITORY && env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_ACTOR === r.OWNER && env.GITHUB_ACTOR_ID === String(r.OWNER_ID), 'PUBLISHER_IDENTITY');
  const gh = createGh({ spawn: spawnSync, env });
  api ??= (method, endpoint, body) => gh.api(method, `/repos/${r.REPOSITORY}${endpoint}`, body);
  const fetched = await r.readRequest(api, { requestId: env.REQUEST_ID, commit: env.REQUEST_COMMIT, hash: env.REQUEST_SHA256, channel: env.CATALOG_CHANNEL, now });
  const loaded = await loadSources(), trust = p.parse(await fs.readFile(path.join(directory, 'trust/root.json')));
  p.validateRoot(trust, now);
  let sources = loaded.sources, previousRaw = null;
  try {
    previousRaw = await fs.readFile(path.join(directory, 'previous-manifest.json'));
    sources = (await applyPublishedSources(previousRaw, trust, env.CATALOG_CHANNEL, sources, loaded.baseline)).sources;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  r.bindCatalog(fetched.request, previousRaw);
  const ajv = await schemas();
  for (const proposal of fetched.request.proposals) await validateProposal(p.bytes(proposal), sources, loaded.baseline, ajv);
  return fetched;
}

if (require.main === module) receiveRequest().then(async result => {
  if (!result) return;
  await fs.writeFile('publication-request.json', result.raw);
  console.log(`Validated request ${result.request.requestId}; ${result.request.proposals.length} template changes; target catalog ${r.nextCatalogVersion(result.request)}. Not published.`);
}).catch(error => { console.error(error.code ?? 'REQUEST_VALIDATION_FAILED'); process.exitCode = 1; });

module.exports = { receiveRequest };
