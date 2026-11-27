'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const p = require('./template-protocol.cjs');
const r = require('./publication-request.cjs');
const { schemas, loadSources, validateProposal } = require('../validate.cjs');
const { applyPublishedSources, publicManifest } = require('../current-sources.cjs');

async function validateContent(request) {
  r.validateRequest(request);
  const loaded = await loadSources();
  let sources = loaded.sources;
  if (request.expectedCatalog.sequence > 0) {
    const root = p.parse(await fs.readFile(path.join(__dirname, '../../trust/root.json')));
    p.validateRoot(root);
    const raw = await publicManifest(request.channel);
    sources = (await applyPublishedSources(raw, root, request.channel, sources, loaded.baseline)).sources;
    r.bindCatalog(request, raw);
  }
  const ajv = await schemas();
  for (const proposal of request.proposals) await validateProposal(p.bytes(proposal), sources, loaded.baseline, ajv);
  return { hash: p.sha256(p.bytes(request)), count: request.proposals.length };
}

module.exports = { validateContent };
