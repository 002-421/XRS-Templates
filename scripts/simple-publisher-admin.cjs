'use strict';
const p=require('./lib/template-protocol.cjs'),{SimplePublisher}=require('./lib/simple-publisher.cjs');
async function handleEnvelope(envelope,publisher=new SimplePublisher()){
 try{p.keys(envelope,['protocolVersion','operationId','command','context']);p.check(envelope.protocolVersion===2,'PUBLISHER_PROTOCOL_VERSION');p.check(require('./lib/simple-catalog.cjs').UUID.test(envelope.operationId),'OPERATION_ID');p.keys(envelope.context,['appVersion']);p.version(envelope.context.appVersion);const cmd=envelope.command;let result;
  switch(cmd.operation){
   case 'capabilities':case 'authorize':p.keys(cmd,['operation']);result={status:'authorized',publisher:await publisher.authorize()};break;
   case 'inspect':p.keys(cmd,['operation']);result=await publisher.inspect();break;
   case 'source':p.keys(cmd,['operation','id','version'],['operation','id']);result=await publisher.source(cmd.id,cmd.version);break;
   case 'prepare':p.keys(cmd,['operation','id','approved']);result=await publisher.prepare(cmd.id,cmd.approved);break;
   case 'publish':p.keys(cmd,['operation','request']);result=await publisher.publish(cmd.request);break;
   default:p.fail('ADMIN_COMMAND');
  }
  return {protocolVersion:2,operationId:envelope.operationId,status:result.status==='published'?'PUBLISHED':result.status==='up-to-date'?'UP_TO_DATE':result.status==='prepared'?'PREPARED':'VALIDATED',error:null,result};
 }catch(error){return {protocolVersion:2,operationId:envelope?.operationId??null,status:'FAILED',error:/^[A-Z0-9_]{1,100}$/.test(error.code??'')?error.code:'PUBLICATION_FAILED',result:null};}
}
if(require.main===module)(async()=>{const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;p.check(size<=p.LIMITS.archive+64000,'SIZE');chunks.push(chunk);}let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{p.fail('JSON');}process.stdout.write(JSON.stringify(await handleEnvelope(input))+'\n');})().catch(error=>{process.stdout.write(JSON.stringify({protocolVersion:2,operationId:null,status:'FAILED',error:error.code??'PUBLICATION_FAILED',result:null})+'\n');process.exitCode=1;});
module.exports={handleEnvelope,SimplePublisher};
