'use strict';
const p=require('./template-protocol.cjs');
function verifyRootChain(anchor,data,{now=Date.now(),fresh=true}={}){
 p.keys(data,['schemaVersion','type','envelopes']);p.check(data.schemaVersion===1&&data.type==='xrs-template-root-chain'&&Array.isArray(data.envelopes)&&data.envelopes.length<=64,'ROOT_CHAIN');
 p.validateRoot(anchor,now,false);let root=anchor;
 for(const auth of data.envelopes){if(auth?.signed?.version<=anchor.version){if(auth.signed.version===anchor.version)p.check(p.canonical(auth.signed)===p.canonical(anchor),'ROOT_ANCHOR');continue;}
  const at=Math.min(now,Date.parse(auth.signed.expiresAt)-1);p.check(Number.isFinite(at),'ROOT');root=p.rotateRoot(root,auth,at);
 }
 p.validateRoot(root,now,fresh);return root;
}
function appendRootRotation(anchor,chain,nextRoot,oldPrivateKey,newPrivateKey,now=Date.now()){
 const before=verifyRootChain(anchor,chain,{now,fresh:false});
 const auth=p.envelope(nextRoot,[oldPrivateKey,newPrivateKey]);p.rotateRoot(before,auth,now);
 const next={schemaVersion:1,type:'xrs-template-root-chain',envelopes:[...chain.envelopes,auth]};verifyRootChain(anchor,next,{now});return next;
}
async function readRootHistory(root,directory){
 const fs=require('node:fs/promises'),path=require('node:path');let anchor,chain;
 try{anchor=p.parse(await fs.readFile(path.join(directory,'anchor.json')));chain=p.parse(await fs.readFile(path.join(directory,'root-chain.json')));}catch(error){if(error.code==='ENOENT')return [];throw error;}
 p.check(p.canonical(verifyRootChain(anchor,chain))===p.canonical(root),'ROOT_CHAIN_MISMATCH');return [anchor,...chain.envelopes.map(row=>row.signed)];
}
module.exports={verifyRootChain,appendRootRotation,readRootHistory};
