'use strict';
const p = require('./template-protocol.cjs');
const VERSION = 1;
const operations = new Set(['authorize','capabilities','inspect','source','stage','dispatch','status','approve','verify','cleanup']);
function command(envelope) {
 p.keys(envelope,['protocolVersion','operationId','command','context']);
 p.check(envelope.protocolVersion===VERSION,'PUBLISHER_PROTOCOL_VERSION');
 p.check(typeof envelope.operationId==='string'&&/^[a-f0-9-]{36}$/.test(envelope.operationId),'OPERATION_ID');
 p.check(envelope.command&&operations.has(envelope.command.operation),'ADMIN_COMMAND');
 p.keys(envelope.context,['trust','appVersion','roots'],['trust','appVersion']);p.version(envelope.context.appVersion);
 if(envelope.context.roots)p.check(Array.isArray(envelope.context.roots)&&envelope.context.roots.length<=65,'ROOT_CHAIN_LIMIT');
 if(envelope.context.trust)p.validateRoot(envelope.context.trust,Date.now(),false);
 return envelope.command;
}
function response(envelope,result,error) {
 const names={prepared:'PREPARED',submitted:'SUBMITTED','not-started':'PREPARED','awaiting-workflow':'RUNNING','approved-awaiting-publication':'RUNNING','workflow-succeeded':'RUNNING',published:'PUBLISHED',failed:'FAILED',authorized:'VALIDATED',inspected:'VALIDATED',cleaned:'PUBLISHED'};
 const code=error?(typeof error.code==='string'&&/^[A-Z0-9_]{1,100}$/.test(error.code)?error.code:'ADMIN_PUBLICATION_FAILED'):null;
 return {protocolVersion:VERSION,operationId:envelope.operationId,status:code?(code==='DISPATCH_STATUS_UNKNOWN'?'UNKNOWN_REQUIRES_RECONCILIATION':'FAILED'):names[result?.status]??'RUNNING',error:code,result:code?null:result};
}
module.exports={VERSION,command,response};
