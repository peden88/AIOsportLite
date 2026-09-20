'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosportlite-services-'));
process.env.VOD_ENABLED = 'false';
process.env.AIOMETADATA_MANIFEST_URL = 'https://env-meta.example/stremio/env/manifest.json';
process.env.AIOSTREAMS_MANIFEST_URL = 'https://env-streams.example/stremio/env/manifest.json';

const settings = require('../src/services/ServiceSettings');
const registry = require('../src/services/AppServiceRegistry');

let pass=0,fail=0;
function t(want,got,label){
  const ok=JSON.stringify(want)===JSON.stringify(got);
  ok?pass++:fail++;
  console.log(`  ${ok?'PASS':'*** FAIL'}  ${label} (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
}

console.log('--- environment fallback');
let summary=registry.adminSummary();
t(false,summary.vodRequested,'VOD follows environment before an admin override');
t('environment',summary.metadata.source,'AIOMetadata initially comes from environment');
t('env-meta.example',summary.metadata.host,'admin summary exposes host but not full manifest URL');

console.log('--- persisted global override');
registry.updatePersistentVod({
  vodEnabled:true,
  aiometadataManifestUrl:'stremio://persist-meta.example/stremio/app/manifest.json',
  aiostreamsManifestUrl:'https://persist-streams.example/stremio/app/manifest.json'
});
summary=registry.adminSummary();
t(true,summary.vodEnabled,'saved service settings enable VOD immediately');
t('data',summary.metadata.source,'saved AIOMetadata overrides environment');
t('persist-meta.example',summary.metadata.host,'stremio URL normalises to an HTTPS host');
t('persist-streams.example',summary.streams.host,'saved AIOStreams host is reported safely');

const saved=JSON.parse(fs.readFileSync(settings.FILE,'utf8'));
t(true,saved.vodEnabled,'VOD flag persists under DATA_DIR');
t('https://persist-meta.example/stremio/app/manifest.json',saved.aiometadataManifestUrl,'normalised AIOMetadata URL persists');
if(process.platform!=='win32'){
  const mode=fs.statSync(settings.FILE).mode & 0o777;
  t(0o600,mode,'service settings file is owner-read/write only');
}

console.log('--- explicit clear beats environment fallback');
registry.updatePersistentVod({clearAiometadata:true});
summary=registry.adminSummary();
t(false,summary.metadata.configured,'admin can explicitly clear persisted AIOMetadata');
t('data',summary.metadata.source,'explicit clear does not silently fall back to environment');
t(false,summary.vodEnabled,'VOD disables when either required service is cleared');

let invalid=false;
try{registry.updatePersistentVod({aiometadataManifestUrl:'https://bad.example/not-a-manifest'});}
catch(e){invalid=e&&e.code==='INVALID_SERVICE_URL';}
t(true,invalid,'non-manifest URLs are rejected before persistence');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
