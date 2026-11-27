'use strict';

// One bounded request over stdio for the future administrative XRS main-process
// adapter. No listening port, shell command input, token or signing-key output.
const p = require('./lib/template-protocol.cjs');
const { GitHubPublisher } = require('./lib/github-publisher.cjs');

async function handleCommand(command, publisher = new GitHubPublisher()) {
  p.check(command && typeof command.operation === 'string', 'ADMIN_COMMAND');
  switch (command.operation) {
    case 'authorize':
      p.keys(command, ['operation']);
      return { status: 'authorized', publisher: await publisher.authorize() };
    case 'stage':
      p.keys(command, ['operation', 'request', 'publicUploadConfirmed']);
      p.check(command.publicUploadConfirmed === true, 'PUBLIC_DATA_CONFIRMATION_REQUIRED');
      return publisher.stage(command.request);
    case 'dispatch':
      p.keys(command, ['operation', 'staged', 'confirmation']);
      return publisher.dispatch(command.staged, command.confirmation);
    case 'status':
      p.keys(command, ['operation', 'staged']);
      return publisher.status(command.staged);
    case 'approve':
      p.keys(command, ['operation', 'staged', 'confirmation']);
      return publisher.approve(command.staged, command.confirmation);
    default: p.fail('ADMIN_COMMAND');
  }
}

if (require.main === module) (async () => {
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) { length += chunk.length; p.check(length <= p.LIMITS.json + 1024, 'SIZE'); chunks.push(chunk); }
  let command; try { command = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { p.fail('JSON'); }
  const result = await handleCommand(command);
  process.stdout.write(JSON.stringify(result) + '\n');
})().catch(error => {
  const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'ADMIN_PUBLICATION_FAILED';
  process.stdout.write(JSON.stringify({ status: 'blocked', error: code }) + '\n'); process.exitCode = 1;
});

module.exports = { handleCommand };
