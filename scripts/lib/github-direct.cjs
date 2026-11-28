'use strict';
const {spawnSync}=require('node:child_process');const p=require('./template-protocol.cjs'),c=require('./simple-catalog.cjs');
function verifyLogin(status,{platform=process.platform,env=process.env}={}){
 p.check(platform==='win32','WINDOWS_ADMIN_REQUIRED');p.check(!['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN'].some(k=>env[k]),'ENVIRONMENT_CREDENTIAL_FORBIDDEN');
 const rows=status?.hosts?.['github.com'];p.check(Array.isArray(rows)&&rows.filter(x=>x.active).length===1,'GITHUB_LOGIN_REQUIRED');const row=rows.find(x=>x.active);p.check(row.state==='success'&&row.login==='002-421'&&row.tokenSource==='keyring'&&!row.token,'GITHUB_LOGIN_REQUIRED');
}
function createGitHub({spawn=spawnSync,env=process.env}={}){
 const safeEnv={...env,GH_PROMPT_DISABLED:'1',GH_NO_UPDATE_NOTIFIER:'1'};for(const key of ['GH_DEBUG','DEBUG','NODE_DEBUG'])delete safeEnv[key];
 const run=(args,input,json=true)=>{const r=spawn('gh',args,{input,env:safeEnv,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:16*1024*1024});if(r.error||r.status!==0){const status=Number(/HTTP (\d{3})/.exec(r.stderr??'')?.[1]);const code=status===401?'GITHUB_UNAUTHORIZED':status===403?'GITHUB_FORBIDDEN':status===404?'SOURCE_NOT_FOUND':status===422?'VERSION_CONFLICT':r.error?.code==='ENOENT'||/unknown flag/.test(r.stderr??'')?'GITHUB_CLI_REQUIRED':'GITHUB_UNAVAILABLE';throw Object.assign(Error(code),{code,httpStatus:status||undefined});}if(!json||!r.stdout.trim())return null;try{return JSON.parse(r.stdout);}catch{p.fail('GITHUB_RESPONSE_INVALID');}};
 return {status:()=>run(['auth','status','--hostname','github.com','--active','--json','hosts']),api:(method,route,body)=>{
  p.check(['GET','POST','PATCH','DELETE'].includes(method)&&/^\/(?:user$|repos\/002-421\/XRS-Templates(?:\/|$))/.test(route)&&!route.includes('..')&&!route.includes('#'),'GITHUB_ENDPOINT');
  if(method==='DELETE')p.check(/^\/repos\/002-421\/XRS-Templates\/releases\/assets\/\d+$/.test(route),'GITHUB_ENDPOINT');
  if(method==='PATCH')p.check(/^\/repos\/002-421\/XRS-Templates\/releases\/\d+$/.test(route),'GITHUB_ENDPOINT');
  return run(['api','--hostname','github.com','--method',method,route,...(body===undefined?[]:['--input','-'])],body===undefined?undefined:JSON.stringify(body));
 },upload:(tag,file)=>{p.check(/^xrs-templates-v\d+\.\d+\.\d+$/.test(tag),'TAG');return run(['release','upload',tag,file,'--repo',c.REPOSITORY],undefined,false);}};
}
module.exports={verifyLogin,createGitHub};
