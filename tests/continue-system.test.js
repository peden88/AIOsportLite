const assert=require('assert');const fs=require('fs');const vm=require('vm');
const context={window:{},Date,Intl,console,setTimeout,clearTimeout};vm.createContext(context);
vm.runInContext(fs.readFileSync(require('path').join(__dirname,'../public/continue-system.js'),'utf8'),context);
const C=context.window.AIOContinue;
(async()=>{
  const now=Date.parse('2026-10-01T12:00:00Z');
  assert(C.isAired({released:'2026-10-01T11:59:59Z'},now));
  assert(!C.isAired({released:'2026-10-01T12:00:01Z'},now));
  assert.equal(C.airBadge('2026-10-02T18:00:00Z',now),'Tomorrow');
  assert.equal(C.airBadge('2026-10-04T18:00:00Z',now),'In 3 Days');
  const meta={id:'show',name:'Show',videos:[
    {id:'special',season:0,episode:1,released:'2026-01-01'},
    {id:'e1',season:1,episode:1,released:'2026-09-01'},
    {id:'e2',season:1,episode:2,released:'2026-09-08'},
    {id:'e3',season:1,episode:3,released:'2026-10-03T20:00:00Z'}
  ]};
  const base={contentId:'show',contentType:'series',name:'Show',season:1,episode:2,videoId:'e2',progressPercent:100,lastWatched:10};
  let r=await C.resolve({progress:[base],loadMeta:async()=>meta,now});
  assert.equal(r.continueItems.length,0);assert.equal(r.upcomingItems.length,1);assert.equal(r.upcomingItems[0]._progress.videoId,'e3');
  r=await C.resolve({progress:[base],loadMeta:async()=>meta,now:Date.parse('2026-10-03T20:00:01Z')});
  assert.equal(r.continueItems.length,1);assert.equal(r.upcomingItems.length,0);assert.equal(r.continueItems[0]._progress.videoId,'e3');
  const inProgress={...base,episode:2,videoId:'e2',progressPercent:44};
  r=await C.resolve({progress:[inProgress],loadMeta:async()=>meta,now});
  assert.equal(r.continueItems[0]._progress.videoId,'e2');assert.equal(r.upcomingItems.length,0);
  // An abandoned older partial episode must not hide the future episode after
  // the furthest watched episode has been completed.
  const olderPartial={...base,episode:1,videoId:'e1',progressPercent:35,lastWatched:20};
  const latestComplete={...base,episode:2,videoId:'e2',progressPercent:100,lastWatched:30};
  r=await C.resolve({progress:[olderPartial,latestComplete],loadMeta:async()=>meta,now});
  assert.equal(r.continueItems.length,0);assert.equal(r.upcomingItems.length,1);assert.equal(r.upcomingItems[0]._progress.videoId,'e3');
  const futureSeason={id:'future',name:'Future',videos:[{id:'s1e1',season:1,episode:1,released:'2026-09-01'},{id:'s2e1',season:2,episode:1,released:'2026-10-10'}]};
  const elig=C.eligibleVideos(futureSeason);assert(!elig.watchable.some(v=>v.season===2));
  console.log('continue-system contract passed');
})().catch(err=>{console.error(err);process.exit(1)});