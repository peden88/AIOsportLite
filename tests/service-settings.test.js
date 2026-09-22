'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosportlite-services-'));
process.env.SPORTS_ENABLED = 'true';
process.env.VOD_ENABLED = 'false';
process.env.AIOMETADATA_MANIFEST_URL = 'https://env-meta.example/stremio/env/manifest.json';
process.env.AIOSTREAMS_MANIFEST_URL = 'https://env-streams.example/stremio/env/manifest.json';
process.env.AIOSTREAMS_WEB_MANIFEST_URL = 'https://web-streams.example/stremio/web-uuid/manifest.json';
process.env.AIOSTREAMS_APP_MANIFEST_URL = 'https://app-streams.example/stremio/app-uuid/manifest.json';

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
t(true,summary.sports.enabled,'Sports is enabled from environment by default');
t('environment',summary.sports.source,'Sports enable state initially comes from environment');
t(false,summary.vodRequested,'VOD follows environment before an admin override');
t('environment',summary.metadata.source,'AIOMetadata initially comes from environment');
t('env-meta.example',summary.metadata.host,'admin summary exposes host but not full manifest URL');
t('web-streams.example',summary.streamsWeb.host,'Web AIOStreams uses its client-specific environment manifest');
t('app-streams.example',summary.streamsApp.host,'App AIOStreams uses its client-specific environment manifest');
t('environment:web',summary.streamsWeb.source,'Web AIOStreams reports its split environment source');
t('environment:app',summary.streamsApp.source,'App AIOStreams reports its split environment source');
t(false,summary.streamsWeb.fingerprint===summary.streamsApp.fingerprint,'different Web/App manifests have different safe fingerprints');

console.log('--- persisted global override');
registry.updatePersistentServices({
  sportsEnabled:false,
  vodEnabled:true,
  aiometadataManifestUrl:'stremio://persist-meta.example/stremio/app/manifest.json',
  aiostreamsManifestUrl:'https://persist-streams.example/stremio/app/manifest.json'
});
summary=registry.adminSummary();
t(false,summary.sports.enabled,'saved Sports switch overrides environment immediately');
t('data',summary.sports.source,'saved Sports switch reports DATA_DIR as its source');
t(true,summary.vodEnabled,'saved service settings enable VOD immediately');
t('data',summary.metadata.source,'saved AIOMetadata overrides environment');
t('persist-meta.example',summary.metadata.host,'stremio URL normalises to an HTTPS host');
t('web-streams.example',summary.streamsWeb.host,'Web client ENV overrides the saved shared AIOStreams fallback');
t('app-streams.example',summary.streamsApp.host,'App client ENV overrides the saved shared AIOStreams fallback');

const saved=JSON.parse(fs.readFileSync(settings.FILE,'utf8'));
t(false,saved.sportsEnabled,'Sports enabled flag persists under DATA_DIR');
t(true,saved.vodEnabled,'VOD flag persists under DATA_DIR');
t('https://persist-meta.example/stremio/app/manifest.json',saved.aiometadataManifestUrl,'normalised AIOMetadata URL persists');
if(process.platform!=='win32'){
  const mode=fs.statSync(settings.FILE).mode & 0o777;
  t(0o600,mode,'service settings file is owner-read/write only');
}

console.log('--- Sports services page contract');
const servicesHtml=fs.readFileSync(path.join(__dirname,'..','public','services.html'),'utf8');
t(true,servicesHtml.includes('id="sportsEnabled"'),'Services page has the global Sports enable switch');
t(true,servicesHtml.includes('id="configureSports"'),'Services page restores Configure Sports');
t(true,servicesHtml.includes('id="sportsCatalogs"'),'Services page reports enabled catalog count');
t(true,servicesHtml.includes('id="sportsSources"'),'Services page reports enabled source count');
t(true,servicesHtml.includes('id="streamsWebHost"'),'Services page reports Web AIOStreams separately');
t(true,servicesHtml.includes('id="streamsAppHost"'),'Services page reports App AIOStreams separately');
t(true,servicesHtml.includes('Container ENV missing:'),'Services page warns when split AIOStreams ENV is absent');
const compose=fs.readFileSync(path.join(__dirname,'..','docker-compose.yml'),'utf8');
t(true,compose.includes('AIOSTREAMS_WEB_MANIFEST_URL'),'Compose passes Web AIOStreams ENV into the container');
t(true,compose.includes('AIOSTREAMS_APP_MANIFEST_URL'),'Compose passes App AIOStreams ENV into the container');

console.log('--- AIOStreams clear restores environment fallback');
registry.updatePersistentVod({clearAiostreams:true});
summary=registry.adminSummary();
const afterStreamsClear=JSON.parse(fs.readFileSync(settings.FILE,'utf8'));
t(false,Object.prototype.hasOwnProperty.call(afterStreamsClear,'aiostreamsManifestUrl'),'clearing AIOStreams removes the saved override key');
t('web-streams.example',summary.streamsWeb.host,'Web AIOStreams remains on its environment manifest after clear');
t('app-streams.example',summary.streamsApp.host,'App AIOStreams remains on its environment manifest after clear');

delete process.env.AIOSTREAMS_WEB_MANIFEST_URL;
delete process.env.AIOSTREAMS_APP_MANIFEST_URL;
summary=registry.adminSummary();
t('env-streams.example',summary.streamsWeb.host,'Web falls back to shared AIOSTREAMS_MANIFEST_URL when split ENV is absent');
t('env-streams.example',summary.streamsApp.host,'App falls back to shared AIOSTREAMS_MANIFEST_URL when split ENV is absent');
t('environment:shared',summary.streamsWeb.source,'Web reports shared ENV fallback explicitly');
t('environment:shared',summary.streamsApp.source,'App reports shared ENV fallback explicitly');

console.log('--- explicit AIOMetadata clear still disables metadata');
registry.updatePersistentVod({clearAiometadata:true});
summary=registry.adminSummary();
t(false,summary.metadata.configured,'admin can explicitly clear persisted AIOMetadata');
t('data',summary.metadata.source,'AIOMetadata explicit clear remains a deliberate disable');
t(false,summary.vodEnabled,'VOD disables when metadata is explicitly cleared');

let invalid=false;
try{registry.updatePersistentVod({aiometadataManifestUrl:'https://bad.example/not-a-manifest'});}
catch(e){invalid=e&&e.code==='INVALID_SERVICE_URL';}
t(true,invalid,'non-manifest URLs are rejected before persistence');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
