'use strict';
if(require.main===module){console.error('LEGACY_SIGNED_ACTIVATION_RETIRED: use XRS upload');process.exitCode=1;return;}
// Explicit owner-only, one-time post-acceptance action. Never called by XRS or CI.
const fs=require('node:fs/promises'),path=require('node:path');
const p=require('./lib/template-protocol.cjs'),core=require('./lib/setup-core.cjs');
const {createGh,verifyCredentialStatus}=require('./lib/github-publisher.cjs');
const {publicManifest,applyPublishedSources}=require('./current-sources.cjs');
async function activate({ownerConfirmed,readSnapshot,verifyTest,setFlag,platform=process.platform,env=process.env,status}={}){
 verifyCredentialStatus(await status(),{platform,env});const snapshot=await readSnapshot();
 const blockers=core.validateSnapshot(snapshot);p.check(!blockers.length,'GITHUB_CONFIGURATION_INCOMPLETE');
 p.check(snapshot.wizardState?.rootPublished===true&&snapshot.existingTestSecret===true&&snapshot.existingStableSecret===true,'SETUP_NOT_COMPLETE');
 p.check(snapshot.testProvisioned===true,'TEST_PUBLICATION_NOT_PROVISIONED');
 const acceptance=await verifyTest();p.check(acceptance.channel==='test'&&typeof acceptance.catalogVersion==='string'&&/^[a-f0-9]{64}$/.test(acceptance.sha256),'TEST_ACCEPTANCE_REQUIRED');
 p.check(await ownerConfirmed(acceptance)===true,'OWNER_STABLE_PERMISSION_REQUIRED');
 await setFlag();return {status:'stable-provisioned',testCatalogVersion:acceptance.catalogVersion,testManifestSha256:acceptance.sha256};
}
if(require.main===module)(async()=>{
 const wizard=require('./setup-wizard.cjs'),gh=createGh();
 const stateFile=path.join(process.env.LOCALAPPDATA??'','XRS-Templates-Setup','setup-state.json');
 const state=JSON.parse(await fs.readFile(stateFile,'utf8'));
 const readline=require('node:readline/promises').createInterface({input:process.stdin,output:process.stdout});
 try{const result=await activate({status:gh.status,readSnapshot:async()=>({...wizard.readSnapshot(),wizardState:state}),verifyTest:async()=>{
  const root=p.parse(await fs.readFile('trust/root.json')),anchor=p.parse(await fs.readFile('trust/anchor.json')),chain=p.parse(await fs.readFile('trust/root-chain.json'));
  p.check(p.canonical(anchor)===p.canonical(state.root),'PINNED_SETUP_ROOT_MISMATCH');
  p.check(p.canonical(require('./lib/root-chain.cjs').verifyRootChain(anchor,chain))===p.canonical(root),'ROOT_CHAIN_MISMATCH');
  const remote=wizard.readSnapshot().publicRoot;p.check(remote&&p.canonical(p.parse(Buffer.from(remote)))===p.canonical(root),'PUBLIC_ROOT_MISMATCH');
  p.validateRoot(root);const raw=await publicManifest('test'),loaded=await require('./validate.cjs').loadSources(),roots=await require('./lib/root-chain.cjs').readRootHistory(root,'trust');
  const checked=await applyPublishedSources(raw,root,'test',loaded.sources,loaded.baseline,'0.4.86',roots);
  return {channel:'test',catalogVersion:checked.manifest.catalogVersion,sha256:p.sha256(raw)};
 },ownerConfirmed:async acceptance=>{
  console.log('Только после единой приёмки RC, реального GitHub Test и двух Windows-клиентов. Это отдельное разрешение владельца, не обычная публикация.');
  const phrase=`ENABLE STABLE ${acceptance.catalogVersion}`;return await readline.question(`Если все условия выполнены и вы разрешаете Stable, введите ${phrase}: `)===phrase;
 },setFlag:async()=>{wizard.run('gh',['variable','set','TEMPLATE_PUBLICATION_PROVISIONED','--body','true','--repo',core.REPOSITORY],{code:'STABLE_FLAG_WRITE_FAILED'});const snapshot=wizard.readSnapshot();p.check(snapshot.stableProvisioned===true,'STABLE_FLAG_READBACK_FAILED');}});
 console.log(JSON.stringify(result));}finally{readline.close();}
})().catch(error=>{console.error(error.code??'STABLE_ACTIVATION_FAILED');process.exitCode=1;});
module.exports={activate};
