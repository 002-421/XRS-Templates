'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),crypto=require('node:crypto');
const p=require('../scripts/lib/template-protocol.cjs'),c=require('../scripts/lib/simple-catalog.cjs'),{SimplePublisher}=require('../scripts/lib/simple-publisher.cjs'),{loadSources}=require('../scripts/validate.cjs');
const loaded=loadSources();const missing=()=>Object.assign(Error('SOURCE_NOT_FOUND'),{code:'SOURCE_NOT_FOUND',httpStatus:404});
async function fixture(){
 const data=await loaded,calls=[],releases=[],tags=new Map(),objects=new Map();let id=0,failAfterPublish=false,deny=false;
 const gh={status:async()=>({hosts:{'github.com':[{active:true,state:'success',login:'002-421',tokenSource:'keyring'}]}}),api:async(method,endpoint,body)=>{
  calls.push({method,endpoint});if(deny)throw Object.assign(Error('GITHUB_FORBIDDEN'),{code:'GITHUB_FORBIDDEN',httpStatus:403});if(endpoint==='/user')return {login:'002-421',id:c.OWNER_ID,type:'User'};const route=endpoint.replace('/repos/'+c.REPOSITORY,'');if(route==='')return {full_name:c.REPOSITORY,permissions:{push:true}};
  if(method==='GET'&&route.startsWith('/releases?'))return releases.map(r=>({...r,assets:r.assets.map(({bytes,...a})=>a)}));
  if(method==='GET'&&route.startsWith('/releases/tags/')){const r=releases.find(r=>r.tag_name===route.slice('/releases/tags/'.length));if(!r)throw missing();return {...r,assets:r.assets.map(({bytes,...a})=>a)};}
  if(method==='GET'&&route==='/git/ref/heads/main')return {object:{sha:'a'.repeat(40),type:'commit'}};
  if(route.startsWith('/git/ref/tags/')){const row=tags.get(route.slice('/git/ref/tags/'.length));if(!row)throw missing();return row;}
  if(method==='POST'&&route==='/git/tags'){const sha=(++id).toString(16).padStart(40,'0');objects.set(sha,{sha,...body});return {sha};}
  if(method==='GET'&&route.startsWith('/git/tags/'))return objects.get(route.slice('/git/tags/'.length));
  if(method==='POST'&&route==='/git/refs'){const key=body.ref.replace('refs/tags/','');if(tags.has(key))throw Object.assign(Error('VERSION_CONFLICT'),{httpStatus:422});const ref={object:{sha:body.sha,type:'tag'}};tags.set(key,ref);return ref;}
  if(method==='POST'&&route==='/releases'){const r={id:++id,...body,assets:[]};releases.push(r);return {...r};}
  if(method==='PATCH'&&route.startsWith('/releases/')){const r=releases.find(r=>r.id===Number(route.slice('/releases/'.length)));Object.assign(r,body);if(failAfterPublish){failAfterPublish=false;throw Object.assign(Error('GITHUB_UNAVAILABLE'),{code:'GITHUB_UNAVAILABLE'});}return {...r};}
  throw Error('UNEXPECTED_GITHUB_ROUTE');
 },upload:async(tag,file)=>{const r=releases.find(r=>r.tag_name===tag),name=require('node:path').basename(file);assert.ok(r.draft);assert.ok(!r.assets.some(a=>a.name===name));const bytes=await fs.readFile(file);r.assets.push({name,size:bytes.length,digest:'sha256:'+p.sha256(bytes),bytes});}};
 const download=async url=>{if(url.includes('/latest/download/')){const r=releases.filter(r=>!r.draft).at(-1),asset=r?.assets.find(a=>a.name==='catalog-manifest.json');if(!asset)throw missing();return asset.bytes;}const part=url.slice(c.PREFIX.length),slash=part.indexOf('/'),tag=part.slice(0,slash),name=part.slice(slash+1),release=releases.find(r=>r.tag_name===tag&&!r.draft),asset=release?.assets.find(a=>a.name===name);if(!asset)throw missing();return asset.bytes;};
 const publisher=new SimplePublisher({gh,download,loadSources:async()=>data,platform:'win32',env:{}});
 return {data,publisher,calls,releases,tags,failPublished:()=>{failAfterPublish=true;},deny:()=>{deny=true;}};
}
test('full 113-template catalog publishes with HTTPS/SHA only, never Actions, Environments, keys or main edits',async()=>{
 const f=await fixture(),prepared=await f.publisher.prepare(crypto.randomUUID(),[]);assert.equal(prepared.request.templates.length,113);const result=await f.publisher.publish(prepared.request);assert.equal(result.status,'published');assert.equal(f.releases.length,1);assert.equal(f.releases[0].draft,false);assert.equal(f.releases[0].assets.length,2);const raw=f.releases[0].assets.find(a=>a.name==='catalog-manifest.json').bytes,m=c.manifest(raw);assert.equal(m.schemaVersion,3);assert.equal(m.packages.length,113);assert.ok(!raw.includes(Buffer.from('signatures')));assert.ok(!f.calls.some(x=>/actions|environments|secrets/.test(x.endpoint)));assert.ok(!f.calls.some(x=>x.method!=='GET'&&x.endpoint.includes('/heads/')));
 assert.equal((await f.publisher.prepare(crypto.randomUUID(),[])).status,'up-to-date');assert.equal(f.releases.length,1);
 const first=prepared.request.templates.find(t=>t.id==='spine-pop'),after=structuredClone(first);after.templateVersion='0.0.2';const paragraph=after.doc.content[1].content.find(n=>n.type==='paragraph'&&n.content?.some(n=>n.type==='text'));paragraph.content.push({type:'text',text:' SYNTHETIC TEST ONLY.'});
 const proposal={template:after,baseVersion:first.templateVersion,baseSha256:p.sha256(p.bytes(first)),summary:'Synthetic only',medicalApproval:{approved:true,reference:'SYNTHETIC ONLY'}};
 const update=await f.publisher.prepare(crypto.randomUUID(),[proposal]);assert.equal(update.request.catalogVersion,'1.0.1');await f.publisher.publish(update.request);assert.equal(f.releases.length,2);const current=await f.publisher.current();assert.equal(current.templates.find(t=>t.id===first.id).templateVersion,'0.0.2');assert.equal(current.manifest.revisions.filter(r=>r.templateId===first.id&&r.status==='Archived').length,1);
 const packageRead=c.packageReader({allowedImages:f.data.baseline.allowedImages});for(const row of current.manifest.packages){const release=f.releases.find(r=>c.archiveUrl(r.tag_name.slice(15))===row.url),bytes=release.assets.find(a=>a.name==='catalog.xrszip').bytes;assert.equal(packageRead(bytes,row).id,row.templateId);}
});
test('ambiguous public response reconciles the same immutable version; wrong owner and HTTP403 cannot write',async()=>{
 const f=await fixture(),plan=await f.publisher.prepare(crypto.randomUUID(),[]);f.failPublished();await assert.rejects(()=>f.publisher.publish(plan.request),/GITHUB_UNAVAILABLE/);assert.equal((await f.publisher.publish(plan.request)).status,'published');assert.equal(f.releases.length,1);assert.equal(f.tags.size,1);
 const blocked=await fixture();blocked.deny();await assert.rejects(()=>blocked.publisher.prepare(crypto.randomUUID(),[]),/GITHUB_FORBIDDEN/);assert.equal(blocked.releases.length,0);assert.equal(blocked.calls.filter(c=>c.method!=='GET').length,0);
});
test('catalog ZIP rejects corruption, path traversal, duplicate IDs and incompatible versions without keys',async()=>{
 const f=await fixture(),plan=await f.publisher.prepare(crypto.randomUUID(),[]);await f.publisher.publish(plan.request);const manifest=c.manifest(f.releases[0].assets.find(a=>a.name==='catalog-manifest.json').bytes),archive=f.releases[0].assets.find(a=>a.name==='catalog.xrszip').bytes;
 assert.throws(()=>c.manifest(p.bytes({...manifest,minimumXrsVersion:'99.0.0'})),/XRS_VERSION_REQUIRED/);assert.throws(()=>c.manifest(p.bytes({...manifest,packages:[...manifest.packages,manifest.packages[0]]})),/DUPLICATE_ID/);assert.throws(()=>c.packageReader({allowedImages:f.data.baseline.allowedImages})(Buffer.from('broken'),manifest.packages[0]),/PACKAGE_HASH/);
 const unsafe=Buffer.from(archive),offset=unsafe.indexOf(Buffer.from('catalog.json'));unsafe.write('../evil.json',offset,'utf8');assert.throws(()=>p.unzip(unsafe,{catalog:true}),/ZIP_/);
 assert.throws(()=>p.zip({'../evil.json':Buffer.from('{}')},{catalog:true}),/ZIP_PATH/);
});
module.exports={fixture};
