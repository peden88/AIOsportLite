'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function t(condition, label) {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? 'PASS' : '*** FAIL'}  ${label}`);
}

console.log('--- first-party web playback contract');
t(!html.includes('/stream/tv/'), 'web app never fetches the raw Stremio stream resource');
t(!html.includes('source-selector'), 'web app contains no stream/source selector');
t(html.includes('/api/v1/play'), 'all playback enters the opaque play API');
t(html.includes('/api/v1/playback/'), 'automatic fallback uses the opaque playback session');
t(html.includes('/api/v1/bootstrap'), 'content modes are capability-driven');

console.log('--- VOD discovery contract');
t(html.includes('/api/v1/vod/catalogs'), 'web app discovers global AIOMetadata catalogs');
t(html.includes('/api/v1/vod/search'), 'web app searches through the global AIOMetadata service');
t(html.includes('/api/v1/vod/meta/series/'), 'series details load episodes from AIOMetadata');
t(html.includes("fetchAndPlay(video.id, 'episode', 'series')"), 'episodes play through AIOStreams as series resources');
t(!html.includes('AIOMETADATA_MANIFEST_URL'), 'web page never receives the AIOMetadata manifest URL');
t(!html.includes('AIOSTREAMS_MANIFEST_URL'), 'web page never receives the AIOStreams manifest URL');


console.log('--- user web layout contract');
t(!html.includes('Tip on Ko-fi'), 'user header has no Ko-fi button');
t(!html.includes('>GitHub<'), 'user header has no GitHub button');
t(!/<header>[\s\S]*?<div class="brand">[\s\S]*?<span>AIOPlay<\/span>/.test(html), 'user header shows the AIOPlay mark without redundant product text');
t(html.includes('class="header-row"'), 'logo, search and logout share one top row');
t(html.includes('grid-template-columns: auto minmax(0, 1fr) auto'), 'top row reserves logo, fluid search and logout columns');
t(html.includes('.mode-tabs { display:flex; justify-content:center'), 'Live Movies Series selector is centered to the page');
t(/<header>[\s\S]*?<div class="mode-tabs" id="modeTabs"><\/div>[\s\S]*?<\/header>/.test(html), 'Live Movies Series selector sits directly in the page header below search');
t(html.includes("add('sports', 'Live')"), 'Sports mode is labelled Live');
t(html.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'), 'content cards use a two-column grid');
t(html.includes('overflow-x: auto; overflow-y:hidden'), 'catalog selector remains horizontally scrollable');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
