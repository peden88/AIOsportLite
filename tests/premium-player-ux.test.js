'use strict';const assert=require('assert'),fs=require('fs'),path=require('path');const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
assert(html.includes('miniPlayerTitle')&&html.includes('miniPlayerTime')&&html.includes('miniPlayPause'),'mini player exposes metadata and transport');
assert(html.includes("classList.remove('player-open');document.body.classList.add('mini-player-active')"),'minimize restores browsing chrome');
assert(html.includes("body.mini-player-active>.mobile-bottom-nav"),'mobile dock remains interactive while minimized');
assert(html.includes("playerReturnToDetails&&currentDetailsMeta?'details':''"),'originating details view can be restored beneath mini player');
assert(html.includes("classList.remove('mini-player-active','details-open');document.body.classList.add('player-open')"),'expand returns to full player');
assert.equal((html.match(/timelineTrack\?\.addEventListener\('click'/g)||[]).length,0,'legacy duplicate timeline click seek removed');
assert(html.includes("if(window.AIOTrickplay&&currentPlaybackSession)AIOTrickplay.start(currentPlaybackSession)"),'trickplay lifecycle remains attached to playback session');
console.log('premium player UX contract passed');