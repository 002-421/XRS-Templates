'use strict';
const path=require('node:path');const {runProbe}=require('./run-read-only-oauth-probe.cjs');
runProbe({command:path.join(process.env.XRS_PROBE_APP_ROOT,'node_modules/electron/dist/electron.exe'),args:[path.join(__dirname,'catalog-088-acceptance.electron.cjs')],reportFile:path.resolve('test-output/catalog-088/publication-result.json'),expectedScope:'real OAuth, Windows DPAPI, catalog acceptance'}).catch(e=>{console.error('::error title=XRS catalog acceptance launcher::'+(/^[A-Z_]{1,100}$/.test(e.code??'')?e.code:'LAUNCH_FAILED'));process.exitCode=1;});
