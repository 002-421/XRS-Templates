// Execute from the reviewed XRS app directory; only synthetic user data.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {_electron} from 'playwright-core';
import {unzipSync} from 'fflate';
import {prepareInlineDocument} from '../src/inline-fields.ts';
process.on('uncaughtException',error=>{const scalar=value=>['string','number','boolean'].includes(typeof value)?String(value).slice(0,160):undefined;console.error('::error title=XRS public update preflight::'+JSON.stringify({name:error.name,message:String(error.message).split('\n')[0].slice(0,200),actual:scalar(error.actual),expected:scalar(error.expected)}));process.exit(1);});
assert.equal(process.platform,'win32');
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifestUrl='https://raw.githubusercontent.com/002-421/-main/codex/mri-report-studio/x-ray-report-studio/downloads/latest.json';
const base='https://raw.githubusercontent.com/002-421/-main/codex/mri-report-studio/x-ray-report-studio/downloads/';
async function download(url){const r=await fetch(url,{headers:{'Cache-Control':'no-cache'}});assert.ok(r.ok,'public download '+r.status);return Buffer.from(await r.arrayBuffer());}
const manifest=JSON.parse(await download(manifestUrl));assert.equal(manifest.version,'0.4.88');
const published=await download(manifest.url);assert.equal(hash(published),manifest.sha256);
const immutable=await download(base+'X-ray_Report_Studio_Windows_Setup-0.4.88.zip');assert.equal(hash(immutable),manifest.sha256);
const old=await download(base+'X-ray_Report_Studio_Windows_Setup-0.4.87.zip');assert.equal(hash(old),'e74d0ab0636a4cc49917329ede395d0a7d44c0afce71f45a4dbf18f4ad25c327');
const backup=JSON.parse(await download(base+'latest-0.4.87-before-0.4.88.json'));assert.equal(backup.version,'0.4.87');assert.equal(backup.sha256,hash(old));
const files=unzipSync(published),prefix='X-ray Report Studio Setup/app/';assert.equal(JSON.parse(Buffer.from(files[prefix+'package.json'])).version,'0.4.88');assert.ok(!files[prefix+'xrs-test-mode.json']);
for(const name of Object.keys(files).filter(n=>n.startsWith(prefix+'electron/')&&n.endsWith('.cjs'))){const source=(await fs.readFile(path.join('electron',name.slice((prefix+'electron/').length)),'utf8')).replace(/\r\n?/g,'\n');assert.equal(hash(files[name]),hash(source),'published module matches checked SHA '+name);}
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'XRS-088-public-')),profile=path.join(temp,'Profile'),oldRoot=path.join(temp,'App_0.4.87');
await fs.mkdir(profile,{recursive:true});await fs.cp('node_modules/electron/dist',oldRoot,{recursive:true});await fs.rename(path.join(oldRoot,'electron.exe'),path.join(oldRoot,'X-ray Report Studio.exe'));
for(const [name,bytes]of Object.entries(unzipSync(old))){if(!name.startsWith(prefix)||name.endsWith('/'))continue;const target=path.join(oldRoot,'resources/app',name.slice(prefix.length));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}
let app,page,stage='launch-087';
async function launch(root){app=await _electron.launch({executablePath:path.join(root,'X-ray Report Studio.exe'),cwd:root,args:['--no-sandbox',`--user-data-dir=${profile}`],env:{...process.env,MRI_REPORT_STUDIO_DICTIONARY_DIR:path.join(temp,'SyntheticDictionary')}});page=await app.firstWindow();await page.locator('#editor .report-content').waitFor();}
const snap=()=>page.locator('#editor .report-content').evaluate(el=>el.editor.getJSON());
const normalize=doc=>{doc=prepareInlineDocument(doc);if(doc.attrs?.templateSource==null)delete doc.attrs.templateSource;return doc;};
try{
 await launch(oldRoot);assert.equal(await app.evaluate(({app})=>app.getVersion()),'0.4.87');
 const plan=await page.evaluate(()=>window.desktop.checkTemplateUpdates());assert.equal(plan.catalogVersion,'1.0.0');await page.evaluate(id=>window.desktop.installTemplateUpdates(id,true),plan.planId);assert.equal((await page.evaluate(()=>window.desktop.templateCatalogState())).version,'1.0.0');
 await page.locator('[data-section-id="description"] p').first().click();await page.keyboard.press('Home');await page.keyboard.insertText('СИНТЕТИЧЕСКИЙ ПРОТОКОЛ ПОСЛЕ ПУБЛИКАЦИИ. ');await page.waitForFunction(()=>document.querySelector('#save-state')?.textContent==='Сохранено на компьютере');
 const before=await snap(),settings=await page.evaluate(()=>localStorage.getItem('mri-alliance.settings.v3'));
 await page.locator('#edit-template').click();await page.locator('#editor .report-content p').first().click();await page.keyboard.press('Home');await page.keyboard.insertText('СИНТЕТИЧЕСКАЯ ЛОКАЛЬНАЯ РЕДАКЦИЯ. ');await page.locator('#save-template').click();const local=await page.evaluate(()=>localStorage.getItem('mri-alliance.templates.v4'));assert.ok(local?.includes('СИНТЕТИЧЕСКАЯ ЛОКАЛЬНАЯ РЕДАКЦИЯ'));
 const sentinel=Buffer.from('SYNTHETIC OLD PUBLICATION OPERATION - KEEP');const oldOperation=path.join(profile,'template-publications-v2','pending.json');await fs.mkdir(path.dirname(oldOperation),{recursive:true});await fs.writeFile(oldOperation,sentinel);
 const encrypted=await app.evaluate(({safeStorage})=>Array.from(safeStorage.encryptString('SYNTHETIC-NOT-A-GITHUB-CREDENTIAL')));const credential=path.join(profile,'github-authorization','synthetic-retention.dat');await fs.mkdir(path.dirname(credential),{recursive:true});await fs.writeFile(credential,Buffer.from(encrypted));
 stage='production-check';const check=await page.evaluate(()=>window.desktop.checkForUpdates());assert.equal(check.available,true);assert.equal(check.version,'0.4.88');assert.equal(check.sha256,manifest.sha256);assert.ok(check.url.startsWith('https:'));
 stage='production-install';await page.evaluate(()=>{window.__postReleaseUpdate=window.desktop.installUpdate().catch(e=>{window.__postReleaseError=String(e)});});await page.waitForFunction(()=>window.desktop.getApplicationVersion().then(v=>v==='0.4.88'),null,{timeout:120000});await page.locator('#editor .report-content').waitFor();assert.deepEqual(normalize(await snap()),normalize(before));
 let state;const deadline=Date.now()+30000;while(Date.now()<deadline){try{state=JSON.parse(await fs.readFile(path.join(profile,'install-state.json'),'utf8'));if(state.current?.version==='0.4.88')break;}catch{}await new Promise(r=>setTimeout(r,100));}assert.equal(state.current.version,'0.4.88');assert.equal(state.previous.version,'0.4.87');await fs.access(path.join(oldRoot,'X-ray Report Studio.exe'));
 for(const [name,bytes]of Object.entries(files)){if(name.startsWith(prefix+'electron/')&&!name.endsWith('/'))assert.equal(hash(await fs.readFile(path.join(state.current.root,'resources/app',name.slice(prefix.length)))),hash(bytes));}
 stage='cold-restart';await app.close();app=null;await launch(state.current.root);assert.equal(await app.evaluate(({app})=>app.getVersion()),'0.4.88');assert.deepEqual(normalize(await snap()),normalize(before));assert.equal(await page.evaluate(()=>localStorage.getItem('mri-alliance.settings.v3')),settings);assert.equal(await page.evaluate(()=>localStorage.getItem('mri-alliance.templates.v4')),local);assert.deepEqual(await fs.readFile(oldOperation),sentinel);assert.deepEqual(await fs.readFile(credential),Buffer.from(encrypted));
 const catalog=await page.evaluate(()=>window.desktop.templateCatalogState());assert.equal(catalog.version,'1.0.0');assert.equal(catalog.count,113);assert.equal((await page.evaluate(()=>window.desktop.checkForUpdates())).available,false);
 assert.equal(await page.locator('#zoom').getAttribute('max'),'200');assert.equal(await page.evaluate(()=>typeof window.desktop.templateAdmin.open),'function');assert.equal(await page.evaluate(()=>typeof window.desktop.templateAdmin.unlock),'undefined');
 await page.waitForTimeout(1500);state=JSON.parse(await fs.readFile(path.join(profile,'install-state.json'),'utf8'));assert.equal(state.status,'stable');const actualExe=await app.evaluate(({app})=>app.getPath('exe'));assert.equal((await fs.realpath(actualExe)).toLowerCase(),(await fs.realpath(state.current.executable)).toLowerCase());
 const desktop=await app.evaluate(({app})=>app.getPath('desktop'));const shortcut=await app.evaluate(({shell},file)=>shell.readShortcutLink(file).target,path.join(desktop,'X-ray Report Studio.lnk'));assert.equal((await fs.realpath(shortcut)).toLowerCase(),(await fs.realpath(actualExe)).toLowerCase());
 const report={status:'PASS',appVersion:'0.4.88',sourceSha:'04c68ecba34ca1ec7e7a69bbb0904c8c0014c033',sha256:manifest.sha256,bytes:published.length,productionManifest:true,realHTTPSUpdater:true,noLocalTestTransport:true,coldRestart:true,installedModulesMatchSource:true,settingsPreserved:true,protocolPreserved:true,localTemplatesPreserved:true,encryptedSyntheticOAuthFilePreserved:true,realOAuthTokenUsed:false,oldPublicationFilePreserved:true,catalogVersion:catalog.version,oldInstallationRetained:true,rollbackManifestPreserved:true,shortcutVerified:true,installState:state.status};await fs.mkdir('test-output/postrelease-088',{recursive:true});await fs.writeFile('test-output/postrelease-088/result.json',JSON.stringify(report,null,2));console.log('::notice title=XRS PUBLIC UPDATE PASS::'+JSON.stringify(report));
}catch(e){console.error('::error title=XRS public update::'+JSON.stringify({stage,name:e.name,message:String(e.message).split('\n')[0].slice(0,200)}));throw e;}finally{await app?.close().catch(()=>{});await fs.rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
