'use strict';
// Opt-in Windows integration probe. No repository/configuration write endpoints.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {app,safeStorage}=require('electron');
const ids=[460700726,460705617,460705986,460707589,460709077];
const safeError=e=>({code:/^[A-Z_0-9]{1,100}$/.test(e.code??'')?e.code:'PROBE_FAILED',httpStatus:Number.isInteger(e.httpStatus)?e.httpStatus:null});
async function run(){
 if(process.platform!=='win32'||process.env.XRS_LIVE_OAUTH_READ_ONLY!=='1')throw Object.assign(Error(),{code:'EXPLICIT_WINDOWS_PROBE_REQUIRED'});
 const root=path.resolve(process.env.XRS_PROBE_APP_ROOT??''),directory=await fs.mkdtemp(path.join(os.tmpdir(),'xrs-read-only-oauth-'));
 try{
  const {createDesktopAuth}=require(path.join(root,'electron/github-desktop-auth.cjs'));
  const auth=createDesktopAuth({directory,clientId:'Ov23liCCT5QblmUZGycA',safeStorage,openExternal:async()=>{}});
  const flow=await auth.begin();
  console.log('::notice title=XRS read-only OAuth code::Open https://github.com/login/device and enter '+flow.userCode+'. Read-only probe; no release will be created or modified.');
  await auth.complete(flow.id);
  const status=await auth.status(),transport=auth.transport,report={scope:'real OAuth, Windows DPAPI, read-only GitHub API',connected:status.connected,oauthScopes:status.scopes,repository:'002-421/XRS-Templates',drafts:[]};
  for(const id of ids){try{const release=await transport.api('GET','/repos/002-421/XRS-Templates/releases/'+id);report.drafts.push({id:release.id,draft:release.draft,assetCount:release.assets?.length??0,httpStatus:200});}catch(e){report.drafts.push({id,...safeError(e)});}}
  try{const release=await transport.api('GET','/repos/002-421/XRS-Templates/releases/tags/xrs-templates-v1.0.0');report.tagRoute={httpStatus:200,id:release.id,draft:release.draft};}catch(e){report.tagRoute=safeError(e);}
  report.status=status.connected?'PASS':'FAIL';
  await fs.mkdir('test-output',{recursive:true});await fs.writeFile('test-output/read-only-oauth.json',JSON.stringify(report,null,2));
  console.log('::notice title=XRS real OAuth read-only result::'+JSON.stringify(report));
  if(report.status!=='PASS')throw Object.assign(Error(),{code:'IDENTITY_NOT_VERIFIED'});
 }finally{await fs.rm(directory,{recursive:true,force:true});}
}
const timeout=setTimeout(()=>{console.error('::error title=XRS read-only OAuth::AUTHORIZATION_TIMEOUT');app.exit(1);},16*60*1000);
app.whenReady().then(run).then(()=>{clearTimeout(timeout);app.exit(0);},e=>{clearTimeout(timeout);console.error('::error title=XRS read-only OAuth::'+JSON.stringify(safeError(e)));app.exit(1);});
