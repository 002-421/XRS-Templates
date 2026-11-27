'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const p = require('./template-protocol.cjs');
const r = require('./publication-request.cjs');
const { schemas, loadSources, validateProposal } = require('../validate.cjs');
const { applyPublishedSources, publicManifest } = require('../current-sources.cjs');

async function validateContent(request,{trust,roots=[],appVersion='0.4.86'}={}) {
  r.validateRequest(request);
  const loaded = await loadSources();
  let sources = loaded.sources;
  if (request.expectedCatalog.sequence > 0) {
    const root = trust??p.parse(await fs.readFile(path.join(require('../validate.cjs').ROOT, 'trust/root.json')));
    p.validateRoot(root);if(!roots.length&&!trust)roots=await require('./root-chain.cjs').readRootHistory(root,path.join(require('../validate.cjs').ROOT,'trust'));
    const raw = await publicManifest(request.channel);
    sources = (await applyPublishedSources(raw, root, request.channel, sources, loaded.baseline,appVersion,roots)).sources;
    r.bindCatalog(request, raw);
  }
  const ajv = await schemas();
  for (const proposal of request.proposals) await validateProposal(p.bytes(proposal), sources, loaded.baseline, ajv);
  return { hash: p.sha256(p.bytes(request)), count: request.proposals.length };
}

module.exports = { validateContent };
