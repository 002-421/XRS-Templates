'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const p=require('./lib/template-protocol.cjs'),c=require('./lib/simple-catalog.cjs');
const SOURCE_SHA='658b96d19472e7cd87857c655b9dae96bf86383d';
async function auditOfficial(checkout,directory,seed){
 await fs.mkdir(directory,{recursive:true});
 const blob=name=>execFileSync('git',['-C',path.resolve(checkout),'show',SOURCE_SHA+':x-ray-report-studio/electron/'+name],{maxBuffer:32*1024*1024});
 for(const [input,output]of [['template-publisher-runtime.cjs','stable-publisher.cjs'],['template-baseline.cjs','stable-baseline.cjs']])await fs.writeFile(path.join(directory,output),blob(input),{mode:0o400});
 const runtime=require(path.resolve(directory,'stable-publisher.cjs')),baseline=require(path.resolve(directory,'stable-baseline.cjs'));
 const loaded=await new runtime.SimplePublisher({gh:{}}).loadSources(),templates=[...loaded.sources.values()].sort((a,b)=>a.id.localeCompare(b.id,'en'));
 p.check(templates.length===113&&new Set(templates.map(t=>t.id)).size===113,'CATALOG_COUNT');const privacy=require('./validate.cjs').checkPrivacy;
 for(const t of templates){p.validateTemplate(t,{allowedImages:baseline.allowedImages});privacy(t);const row=baseline.templates.find(b=>b.id===t.id);p.check(row&&p.sha256(p.bytes(t))===row.sha256&&p.canonical(p.structure(t.doc))===p.canonical(row.contract),'STABLE_SOURCE_MISMATCH');}
 const spine=templates.filter(t=>t.id.startsWith('spine-'));p.check(spine.length===8&&spine.reduce((n,t)=>n+p.structure(t.doc).fields.length,0)===40,'SPINE_FIELDS');
 const report={sourceCommit:SOURCE_SHA,templates:templates.length,mri:templates.filter(t=>t.modality==='MRI').length,ct:templates.filter(t=>t.modality==='CT').length,spineTemplates:8,spineNativeFields:40,contentSha256:c.contentHash(templates),templateHashes:templates.map(t=>({id:t.id,sha256:p.sha256(p.bytes(t))}))};
 const request={schemaVersion:1,type:'xrs-https-publication-request',id:seed?.operationId??crypto.randomUUID(),createdAt:seed?.createdAt??new Date().toISOString(),catalogVersion:'1.0.0',sequence:1,previousVersion:'0.0.0',previousManifestSha256:null,contentSha256:report.contentSha256,templates,summaries:{}};
 const {archive,raw}=require('./lib/catalog-artifacts.cjs').buildArtifacts(request,null,{allowedImages:baseline.allowedImages});
 if(seed)p.check(seed.sourceCommit===SOURCE_SHA&&seed.contentSha256===report.contentSha256&&seed.requestSha256===p.sha256(p.bytes(request)),'OFFICIAL_SEED_MISMATCH');
 report.operationId=request.id;report.requestSha256=p.sha256(p.bytes(request));report.archiveSha256=p.sha256(archive);report.manifestSha256=p.sha256(raw);if(seed)p.check(seed.archiveSha256===report.archiveSha256&&seed.manifestSha256===report.manifestSha256,'OFFICIAL_ARTIFACT_MISMATCH');
 await fs.writeFile(path.join(directory,'catalog.json'),p.bytes(templates),{mode:0o400});await fs.writeFile(path.join(directory,'new-publication-request.json'),p.bytes(request),{mode:0o400});await fs.writeFile(path.join(directory,'catalog.xrszip'),archive,{mode:0o400});await fs.writeFile(path.join(directory,'catalog-manifest.json'),raw,{mode:0o400});await fs.writeFile(path.join(directory,'source-report.json'),JSON.stringify(report,null,2),{mode:0o400});return report;
}
module.exports={auditOfficial,SOURCE_SHA};
if(require.main===module)auditOfficial(process.argv[2],path.resolve(process.argv[3]),process.argv[4]?require(path.resolve(process.argv[4])):undefined).then(({templateHashes,...report})=>console.log(JSON.stringify(report))).catch(e=>{console.error(e.code??'SOURCE_AUDIT_FAILED');process.exitCode=1;});
