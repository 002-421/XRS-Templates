'use strict';

function checkProvisioned(channel, testFlag, stableFlag) {
  if (channel === 'test') {
    if (testFlag !== 'true') throw Object.assign(new Error('TEST_PUBLICATION_NOT_PROVISIONED'), { code: 'TEST_PUBLICATION_NOT_PROVISIONED' });
    return 'test';
  }
  if (channel === 'stable') {
    if (stableFlag !== 'true') throw Object.assign(new Error('STABLE_PUBLICATION_NOT_PROVISIONED'), { code: 'STABLE_PUBLICATION_NOT_PROVISIONED' });
    return 'stable';
  }
  throw Object.assign(new Error('UNKNOWN_PUBLICATION_CHANNEL'), { code: 'UNKNOWN_PUBLICATION_CHANNEL' });
}

if (require.main === module) {
  try {
    checkProvisioned(process.env.CATALOG_CHANNEL, process.env.TEMPLATE_TEST_PUBLICATION_PROVISIONED, process.env.TEMPLATE_PUBLICATION_PROVISIONED);
    console.log(`PASS: ${process.env.CATALOG_CHANNEL} publication gate`);
  } catch (error) {
    console.error(error.code ?? 'PUBLICATION_GATE_FAILED');
    process.exitCode = 1;
  }
}

module.exports = { checkProvisioned };
