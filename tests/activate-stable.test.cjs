'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {activate}=require('../scripts/activate-stable.cjs');
const core=require('../scripts/lib/setup-core.cjs');
function fixture(){
 const snapshot={authenticatedUser:'002-421',authenticatedUserId:210672295,repositoryAdmin:true,branchProtectionReadable:true,
 branchProtection:{required_pull_request_reviews:{required_approving_review_count:1},required_status_checks:{contexts:['validate']},enforce_admins:{enabled:true}},
 environments:Object.fromEntries(core.ENVIRONMENTS.map(name=>[name,{readable:true,reviewers:['002-421'],deploymentBranches:['main']}])),
 existingTestSecret:true,existingStableSecret:true,testProvisioned:true,wizardState:{rootPublished:true,testSecretUploaded:true,stableSecretUploaded:true}};
 let writes=0;
 const options={platform:'win32',env:{},status:async()=>({hosts:{'github.com':[{active:true,state:'success',login:'002-421',tokenSource:'keyring'}]}}),
 readSnapshot:async()=>snapshot,verifyTest:async()=>({channel:'test',catalogVersion:'1.0.0',sha256:'a'.repeat(64)}),ownerConfirmed:async()=>true,setFlag:async()=>{writes++;}};
 return {snapshot,options,writes:()=>writes};
}
test('Stable activation requires complete protected setup, authenticated test receipt and separate owner acceptance',async()=>{
 const good=fixture();assert.equal((await activate(good.options)).status,'stable-provisioned');assert.equal(good.writes(),1);
 for(const mutate of [f=>{f.options.ownerConfirmed=async()=>false;},f=>{f.snapshot.testProvisioned=false;},f=>{f.snapshot.wizardState.rootPublished=false;},f=>{f.snapshot.existingStableSecret=false;},f=>{f.snapshot.branchProtectionReadable=false;},f=>{f.options.verifyTest=async()=>{throw Error('SIGNATURE');};},f=>{f.options.verifyTest=async()=>({channel:'stable',catalogVersion:'1.0.0',sha256:'a'.repeat(64)});},f=>{f.options.env={GH_TOKEN:'synthetic'};}]){
  const bad=fixture();mutate(bad);await assert.rejects(()=>activate(bad.options));assert.equal(bad.writes(),0);
 }
 const failed=fixture();failed.options.setFlag=async()=>{throw Error('GITHUB_FORBIDDEN');};await assert.rejects(()=>activate(failed.options),/GITHUB_FORBIDDEN/);
});
