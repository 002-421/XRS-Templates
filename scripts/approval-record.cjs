'use strict';
// GitHub, rather than an untrusted proposal, supplies the publication approver.
const {execFileSync}=require('node:child_process'),fs=require('node:fs/promises'),p=require('./lib/template-protocol.cjs');
function approvalRecord(rows, env = process.env) {
 const run = env.GITHUB_RUN_ID, channel = env.CATALOG_CHANNEL;
 p.check(/^\d+$/.test(run??'') && ['stable','test'].includes(channel), 'APPROVAL_CONTEXT');
 p.check(Array.isArray(rows), 'APPROVAL_CONTEXT');
 const approved = rows.filter(row => row.state === 'approved' && row.environments?.some(e => e.name === 'catalog-'+channel) && row.user?.login);
 p.check(approved.length, 'ENVIRONMENT_APPROVAL_REQUIRED');
 const reviewer = approved.at(-1).user;
 const record = {runId:run, channel, approvedBy:'github:'+reviewer.login};
 if (env.REQUEST_ID || env.REQUEST_COMMIT || env.REQUEST_SHA256) {
  const r = require('./lib/publication-request.cjs');
  p.check(reviewer.login === r.OWNER && reviewer.id === r.OWNER_ID, 'PUBLISHER_IDENTITY');
  p.check(r.UUID.test(env.REQUEST_ID) && r.COMMIT.test(env.REQUEST_COMMIT) && r.HASH.test(env.REQUEST_SHA256) && r.COMMIT.test(env.GITHUB_SHA), 'REQUEST_BINDING');
  Object.assign(record, {requestId:env.REQUEST_ID, requestCommit:env.REQUEST_COMMIT, requestSha256:env.REQUEST_SHA256, workflowSha:env.GITHUB_SHA});
 }
 return record;
}
if (require.main === module) (async()=>{
 const run=process.env.GITHUB_RUN_ID;p.check(/^\d+$/.test(run??''),'APPROVAL_CONTEXT');
 const rows=JSON.parse(execFileSync('gh',['api',`repos/002-421/XRS-Templates/actions/runs/${run}/approvals`],{encoding:'utf8',maxBuffer:1000000}));
 await fs.writeFile('approval-record.json',p.bytes(approvalRecord(rows)));
})().catch(e=>{console.error(e.code??'APPROVAL_CHECK_FAILED');process.exitCode=1;});
module.exports = {approvalRecord};
