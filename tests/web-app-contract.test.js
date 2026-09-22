'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const headerHtml = (html.match(/<header>[\s\S]*?<\/header>/) || [''])[0];
const topHeaderHtml = (html.match(/<div class="top-header">[\s\S]*?<\/div>\s*<header>/) || [''])[0];

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
t(/fetchAndPlay\(\s*video\.id,\s*'episode',\s*'series',/.test(html), 'episodes play through AIOStreams as series resources');
t(!html.includes('AIOMETADATA_MANIFEST_URL'), 'web page never receives the AIOMetadata manifest URL');
t(!html.includes('AIOSTREAMS_MANIFEST_URL'), 'web page never receives the AIOStreams manifest URL');


console.log('--- user web layout contract');
t(!html.includes('Tip on Ko-fi'), 'user header has no Ko-fi button');
t(!html.includes('>GitHub<'), 'user header has no GitHub button');
t(!topHeaderHtml.includes('<span>AIOPlay</span>'), 'user top row shows the AIOPlay mark without redundant product text');
t(html.includes('class="header-row"'), 'logo, search and logout share one top row');
t(/\.header-row\s*\{[\s\S]*?grid-template-columns\s*:\s*auto\s+minmax\(0\s*,\s*1fr\)\s+auto/.test(html), 'top row reserves logo, fluid search and logout columns');
t(html.includes('.mode-tabs { display:flex; justify-content:center'), 'Live VOD selector is centered to the page');
t(/\.mode-tab\s*\{[\s\S]*?border-radius\s*:\s*20px/.test(html), 'top navigation reuses Nuvio season-pill styling');
t(/<div class="top-header">[\s\S]*?id="searchInput"[\s\S]*?<\/div>\s*<header>[\s\S]*?<div class="mode-tabs" id="modeTabs"><\/div>[\s\S]*?<\/header>/.test(html), 'search scrolls naturally above the sticky Live VOD navigation');
t(html.includes("add('sports', 'Live')"), 'Sports mode is labelled Live');
t(html.includes("add('vod', 'VOD')"), 'Movies and Series are combined into one VOD mode');
t(html.includes("add('continue', 'Continue Watching')"), 'signed-in VOD users get a Continue Watching mode');
t(html.includes('/api/v1/progress?continue=1'), 'Continue Watching is loaded from per-user server progress');
t(html.includes("method: 'PUT'") && html.includes('/api/v1/progress'), 'internal web playback writes progress back to the server');
t(!html.includes("add('movie', 'Movies')") && !html.includes("add('series', 'Series')"), 'separate Movies and Series top-level modes are absent');
t(/\.vod-card \.poster-container\s*\{[\s\S]*?aspect-ratio\s*:\s*2\s*\/\s*3/.test(html), 'web VOD cards use portrait poster proportions');
t(/\.vod-card \.info\s*\{[\s\S]*?position\s*:\s*static/.test(html), 'VOD title labels sit below poster artwork');
t(html.includes("for (const catalog of data.catalogs || [])"), 'web VOD catalog rail preserves AIOMetadata order without sorting');
t(html.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'), 'content cards use a two-column grid');
t(/\.tabs\s*\{[\s\S]*?overflow-x\s*:\s*auto/.test(html), 'catalog selector remains horizontally scrollable');
t(/<header>[\s\S]*?class="catalog-rail"[\s\S]*?id="tabs"[\s\S]*?<\/header>/.test(html), 'channel and catalog rail stays inside the sticky header');
t(!html.includes('syncHeaderCollapse') && !html.includes('header-compact'), 'sticky navigation does not mutate header height while scrolling');
t(/\.top-header\s*\{[\s\S]*?position\s*:\s*relative/.test(html), 'logo search and logout use normal document flow');
t(/header\s*\{[\s\S]*?position\s*:\s*sticky[\s\S]*?top\s*:\s*0/.test(html), 'mode and catalog navigation remains sticky');
t(/body::before\s*\{[\s\S]*?url\('\/aioplay-brand\.webp'\)[\s\S]*?filter\s*:\s*blur\(/.test(html), 'web app has a blurred AIOPlay brand background');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
