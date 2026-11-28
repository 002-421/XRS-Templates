'use strict';
const {spawn}=require('node:child_process'),fs=require('node:fs/promises'),path=require('node:path'),readline=require('node:readline');
async function runProbe({command,args,reportFile,cwd=process.cwd(),log=console.log}){
 await fs.rm(reportFile,{force:true});
 const child=spawn(command,args,{cwd,env:process.env,stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])readline.createInterface({input:stream}).on('line',line=>{if(/^::(?:notice|error) title=XRS /.test(line))log(line);});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 if(code!==0)throw Object.assign(Error(),{code:'PROBE_PROCESS_FAILED'});
 let report;try{report=JSON.parse(await fs.readFile(reportFile,'utf8'));}catch{throw Object.assign(Error(),{code:'PROBE_RESULT_MISSING'});}
 if(report.status!=='PASS'||report.connected!==true||!Array.isArray(report.oauthScopes)||report.scope!=='real OAuth, Windows DPAPI, read-only GitHub API')throw Object.assign(Error(),{code:'PROBE_RESULT_INVALID'});
 return report;
}
module.exports={runProbe};
if(require.main===module){const root=path.resolve(process.env.XRS_PROBE_APP_ROOT??''),command=path.join(root,'node_modules/electron/dist/electron.exe');runProbe({command,args:[path.join(__dirname,'read-only-oauth-probe.cjs')],reportFile:path.resolve('test-output/read-only-oauth.json')}).catch(e=>{console.error('::error title=XRS read-only OAuth launcher::'+(/^[A-Z_]{1,100}$/.test(e.code??'')?e.code:'PROBE_LAUNCH_FAILED'));process.exitCode=1;});}
