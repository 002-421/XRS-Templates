'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const core=require('../scripts/lib/setup-core.cjs'),p=require('../scripts/lib/template-protocol.cjs');
const {appendRootRotation,verifyRootChain}=require('../scripts/lib/root-chain.cjs');
test('offline root rotation preserves separate roles and requires old/new custody; root revocation blocks new indexes',()=>{
 const a=core.makeKeySet(),b=core.makeKeySet(),next={...b.root,version:2,revoked:[a.generated.test.id,a.generated.stable.id]};
 const initial={schemaVersion:1,type:'xrs-template-root-chain',envelopes:[]};
 const chain=appendRootRotation(a.root,initial,next,a.generated.root.privatePem,b.generated.root.privatePem);
 assert.deepEqual(verifyRootChain(a.root,chain),next);
 assert.throws(()=>appendRootRotation(a.root,initial,next,a.generated.test.privatePem,b.generated.root.privatePem),/SIGNATURE/);
 assert.throws(()=>p.verify(p.envelope({safe:true},[a.generated.stable.privatePem]),next,'stable'),/SIGNATURE/);
 assert.throws(()=>verifyRootChain(a.root,{...chain,envelopes:[p.envelope({...next,version:3},[a.generated.root.privatePem,b.generated.root.privatePem])]}),/ROOT_SEQUENCE/);
 assert.equal(p.bytes(chain).includes(Buffer.from('BEGIN PRIVATE KEY')),false);
});
