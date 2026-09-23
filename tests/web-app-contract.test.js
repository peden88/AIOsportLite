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
t(html.includes('/heartbeat'), 'web playback keeps its account lease alive with heartbeats');
t(html.includes('startPlaybackHeartbeat'), 'web player starts a lease heartbeat for internal playback');
t(html.includes('The external-player bridge now owns the lease'), 'external handoff leaves lease ownership with the proxy');
t(html.includes('/api/v1/bootstrap'), 'content modes are capability-driven');

console.log('--- VOD discovery contract');
t(html.includes('/api/v1/vod/catalogs'), 'web app discovers global AIOMetadata catalogs');
t(html.includes('/api/v1/vod/search'), 'web app searches through the global AIOMetadata service');
t(html.includes('/api/v1/vod/meta/series/'), 'series details load episodes from AIOMetadata');
t(/fetchAndPlay\(\s*video\.id,\s*'episode',\s*'series',/.test(html), 'episodes play through AIOStreams as series resources');
t(html.includes(": () => openMovie(meta, card);"), 'movie poster selection opens Details instead of starting playback');
t(html.includes('id="detailsMoviePlay"') && html.includes('class="details-play-orb"'), 'movie Details exposes the round hero Play control');
t(html.includes('class="details-play-orb-image"') && html.includes('src="/assets/aioplay-movie-play-orb.webp"'), 'movie hero Play control renders the approved orb as an explicit image');
t(/\.details-play-orb\s*\{[\s\S]*?width\s*:\s*70px[\s\S]*?background\s*:\s*transparent/.test(html), 'movie hero Play control keeps the compact 70px transparent treatment');
t(html.includes("aioplay-movie-play-orb.webp"), 'movie hero Play control uses the exact green-cyan rendered artwork');
t(html.includes("this.src='/assets/aioplay-movie-play-orb.png'"), 'movie hero Play falls back from WebP to PNG artwork');
t(html.includes('configureMovieHeroAction(currentDetailsMeta)'), 'movie Details wires Play or Resume through the hero action');
t(html.includes('function seriesHeroTarget(meta, videos)'), 'series Details resolves the correct smart Play, Resume or Next Episode target');
t(html.includes('configureSeriesHeroAction(currentDetailsMeta, videos)'), 'series Details exposes the hero play action after episodes load');
t(html.includes("mode === 'resume' ? 'Resume' : mode === 'next' ? 'Next Episode'"), 'series hero action labels resume and next episode states');
t(html.includes("Keep the underlying catalog dimmed while Details fades away"), 'Details dismissal uses the staged mobile fade path');
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
t(/body\.details-open > \.top-header[\s\S]*?body\.details-open > header[\s\S]*?body\.details-open > main[\s\S]*?opacity\s*:\s*\.28/.test(html), 'title details keep the mounted catalog softly dimmed during overlay transitions');
t(/#details-overlay\s*\{[\s\S]*?background\s*:\s*transparent[\s\S]*?backdrop-filter\s*:\s*none/.test(html), 'title details overlay stays transparent over the active catalog');
t(/\.details-shell\s*\{[\s\S]*?background\s*:\s*rgba\(18\s*,\s*18\s*,\s*22\s*,\s*\.985\)/.test(html), 'title details card remains dark and opaque');
t(html.includes("document.body.classList.add('details-open')"), 'opening details dims the current catalog rather than replacing it');
t(html.includes("document.body.classList.remove('details-open')"), 'closing details restores the catalog opacity');
t(/#details-overlay\s*\{[\s\S]*?safe-area-inset-bottom/.test(html), 'details overlay extends through the iOS bottom safe area');
t(html.includes("for (const catalog of data.catalogs || [])"), 'web VOD catalog rail preserves AIOMetadata order without sorting');
t(/\.grid\s*\{[\s\S]*?grid-template-columns\s*:\s*repeat\(2\s*,\s*minmax\(0\s*,\s*1fr\)\)/.test(html), 'content cards use a two-column grid');
t(/\.tabs\s*\{[\s\S]*?overflow-x\s*:\s*auto/.test(html), 'catalog selector remains horizontally scrollable');
t(/<header>[\s\S]*?class="catalog-rail"[\s\S]*?id="tabs"[\s\S]*?<\/header>/.test(html), 'channel and catalog rail stays inside the sticky header');
t(!html.includes('syncHeaderCollapse') && !html.includes('header-compact'), 'sticky navigation does not mutate header height while scrolling');
t(/\.top-header\s*\{[\s\S]*?position\s*:\s*relative/.test(html), 'logo search and logout use normal document flow');
t(/header\s*\{[\s\S]*?position\s*:\s*sticky[\s\S]*?top\s*:\s*0/.test(html), 'mode and catalog navigation remains sticky');
t(/header\s*\{[\s\S]*?background\s*:\s*rgba\(15\s*,\s*15\s*,\s*17\s*,\s*\.46\)/.test(html), 'sticky mode and catalog glass is another 25 percent more transparent');
t(html.includes('viewport-fit=cover'), 'iOS viewport extends into the safe area');
t(!html.includes('name="theme-color"'), 'Safari is not forced to paint an opaque theme strip');
t(html.includes('env(safe-area-inset-bottom, 0px)'), 'page gradient extends through the iOS bottom safe area');
t(/header\s*\{[\s\S]*?box-shadow\s*:\s*none/.test(html), 'sticky navigation has no dark drop shadow over the page gradient');
t(/\.catalog-rail\.is-empty\s*\{[\s\S]*?display\s*:\s*none/.test(html), 'empty catalog rails collapse instead of leaving a dark strip');
t(html.includes("setCatalogRailVisible(mode !== 'continue')"), 'Continue Watching hides the unused catalog rail');
t(/html\s*\{[\s\S]*?background-color\s*:\s*#414a7f[\s\S]*?linear-gradient\([\s\S]*?135deg[\s\S]*?#355f7f[\s\S]*?#2f4d7f[\s\S]*?#414a7f/.test(html), 'web app uses one opaque continuous AIOPlay gradient through the Safari underlay');
t(!html.includes('body::before') && !html.includes('body::after'), 'global background uses no fixed pseudo-element layers that can seam on iOS');
t(/\.content-state\s*\{[\s\S]*?place-items\s*:\s*center[\s\S]*?font\s*:\s*600\s+1\.5rem/.test(html), 'loading and empty states are centered and enlarged');
t(html.includes("beginGridTransition({ posterMode:false })"), 'sports catalog loading uses the premium skeleton grid');
t(html.includes("setGridState('Nothing to show here right now.')"), 'empty catalog text uses the centered state');
t(html.includes('id="playerMinimize"'), 'web player exposes the mini-player control');
t(html.includes('id="searchFilters"'), 'global search exposes All Movies Series filters');
t(html.includes('prefers-reduced-motion:reduce'), 'web UI respects reduced motion preferences');
t(html.includes('player-timeline-marker'), 'player HUD supports timeline markers');
t(html.includes("IntersectionObserver"), 'visible VOD cards progressively hydrate metadata');
t(/\.mode-tab\s*\{[\s\S]*?var\(--accent-gradient\) border-box/.test(html), 'top navigation uses gradient pill outlines');
t(/\.admin-only\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/.test(html), 'admin controls are hidden before role resolution');
t(html.includes("gate.user.role === 'admin'"), 'admin controls are only revealed after an admin role is confirmed');
t(/\.tab\s*\{[\s\S]*?var\(--accent-gradient\) border-box/.test(html), 'catalog navigation uses gradient pill outlines');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
