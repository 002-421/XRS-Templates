'use strict';
const p=require('./template-protocol.cjs');
// Only call after a current, unrevoked index has authenticated this exact entry
// or for an already accepted immutable generation. Old keys cannot sign a new index.
function readAuthenticatedPackage(raw,entry,root,roots,options){
 p.check(raw.length===entry.size&&p.sha256(raw)===entry.sha256,'PACKAGE_HASH');
 const auth=p.parse(p.unzip(raw)['package.json']);
 for(const candidate of [root,...roots].filter(Boolean)){
  try{p.verify(auth,candidate,options.channel);return p.readPackage(raw,entry,candidate,options);}catch(error){if(error.code!=='SIGNATURE')throw error;}
 }p.fail('SIGNATURE');
}
module.exports={readAuthenticatedPackage};
