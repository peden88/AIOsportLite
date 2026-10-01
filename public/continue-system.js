/* AIOPlay Continue Watching / Upcoming resolver. */
(()=>{'use strict';
const DAY=86400000;
const seriesType=v=>['series','tv','episode'].includes(String(v||'').toLowerCase());
function releaseValue(video){return video?.released??video?.releaseTimestamp??video?.releaseDate??video?.airDate??video?.firstAired??''}
function parseRelease(value){
  if(value==null||value==='')return null;
  if(typeof value==='number'&&Number.isFinite(value))return value<1e12?value*1000:value;
  const raw=String(value).trim(); if(!raw)return null;
  if(/^\d{4}-\d{2}-\d{2}$/.test(raw)){const [y,m,d]=raw.split('-').map(Number);return Date.UTC(y,m-1,d)}
  const exact=Date.parse(raw); if(Number.isFinite(exact))return exact;
  const embedded=raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);return embedded?parseRelease(embedded[1]):null;
}
function isAired(video,now=Date.now()){const at=parseRelease(releaseValue(video));return at==null||at<=now}
function episodeOrder(a,b){return (Number(a?.season)||0)-(Number(b?.season)||0)||(Number(a?.episode)||0)-(Number(b?.episode)||0)}
function eligibleVideos(meta){
  const videos=(Array.isArray(meta?.videos)?meta.videos:[]).filter(v=>v?.id&&Number(v.season)>0&&Number.isFinite(Number(v.episode))).sort(episodeOrder);
  const blocked=new Set();
  for(const v of videos){const s=Number(v.season);if(blocked.has(s))continue;const first=videos.find(x=>Number(x.season)===s);if(first&&(first.available===false||!isAired(first)))blocked.add(s)}
  return {all:videos,watchable:videos.filter(v=>v.available!==false&&!blocked.has(Number(v.season)))};
}
function afterSeed(video,seed){if(!seed)return true;return episodeOrder(video,seed)>0}
function progressSeed(row){return {season:Number(row?.season)||0,episode:Number(row?.episode)||0}}
function airBadge(value,now=Date.now()){
  const at=parseRelease(value);if(at==null||at<=now)return '';
  const start=new Date(now);const target=new Date(at);
  const a=Date.UTC(start.getFullYear(),start.getMonth(),start.getDate());
  const b=Date.UTC(target.getFullYear(),target.getMonth(),target.getDate());
  const days=Math.max(0,Math.round((b-a)/DAY));
  if(days===0)return 'Today';if(days===1)return 'Tomorrow';if(days<=7)return 'In '+days+' Days';
  return 'Airs '+new Intl.DateTimeFormat(undefined,{day:'numeric',month:'short',year:start.getFullYear()===target.getFullYear()?undefined:'numeric'}).format(target);
}
function rowForEpisode(meta,video,seed,kind){
  const release=releaseValue(video);return {
    id:video.id,type:'episode',name:meta?.name||seed?.name||'Untitled',
    description:['S'+String(video.season).padStart(2,'0')+'E'+String(video.episode).padStart(2,'0'),video.title||video.name||'',kind==='upcoming'?airBadge(release):''].filter(Boolean).join(' · '),
    poster:meta?.poster||seed?.poster,background:meta?.background||meta?.backdrop||seed?.backdrop,logo:meta?.logo||seed?.logo,
    _progress:{...seed,contentId:seed?.contentId||meta?.id,contentType:'series',videoId:video.id,season:Number(video.season),episode:Number(video.episode),episodeTitle:video.title||video.name||'',position:0,progressPercent:0},
    _releaseAt:parseRelease(release),_continueKind:kind
  };
}
async function mapLimit(items,limit,worker){const out=new Array(items.length);let next=0;async function run(){while(next<items.length){const i=next++;out[i]=await worker(items[i],i)}}await Promise.all(Array.from({length:Math.min(limit,items.length)},run));return out}
async function resolve({progress=[],loadMeta,now=Date.now(),maxSeries=32}={}){
  const rows=Array.isArray(progress)?progress:[];
  const movies=rows.filter(r=>String(r?.contentType||'').toLowerCase()==='movie'&&Number(r.progressPercent)>0&&Number(r.progressPercent)<90)
    .sort((a,b)=>Number(b.lastWatched||0)-Number(a.lastWatched||0)).map(r=>({id:r.videoId||r.contentId,type:'movie',name:r.name||'Untitled',poster:r.poster,background:r.backdrop,logo:r.logo,_progress:r,_continueKind:'progress'}));
  const groups=new Map();
  for(const r of rows){if(!seriesType(r?.contentType)||!r?.contentId)continue;const key=String(r.contentId);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r)}
  const seeds=[...groups.entries()].map(([id,rs])=>({id,rows:rs.sort((a,b)=>Number(b.lastWatched||0)-Number(a.lastWatched||0))})).sort((a,b)=>Number(b.rows[0]?.lastWatched||0)-Number(a.rows[0]?.lastWatched||0)).slice(0,maxSeries);
  const resolved=await mapLimit(seeds,4,async group=>{
    const rs=group.rows;
    // Resolve from the furthest episode reached, not any older unfinished row.
    // Otherwise completing a later episode can be masked by an abandoned
    // partial episode and the genuine next/future episode is never discovered.
    const seed=rs.slice().sort((a,b)=>episodeOrder(progressSeed(b),progressSeed(a))||Number(b.lastWatched||0)-Number(a.lastWatched||0))[0];
    const inProgress=rs.find(r=>Number(r.progressPercent)>0&&Number(r.progressPercent)<90&&episodeOrder(progressSeed(r),progressSeed(seed))>=0);
    if(inProgress)return {continue:{id:inProgress.videoId||inProgress.contentId,type:'episode',name:inProgress.name||'Untitled',description:[inProgress.season!=null&&inProgress.episode!=null?'S'+String(inProgress.season).padStart(2,'0')+'E'+String(inProgress.episode).padStart(2,'0'):'',inProgress.episodeTitle||''].filter(Boolean).join(' · '),poster:inProgress.poster,background:inProgress.backdrop,logo:inProgress.logo,_progress:inProgress,_continueKind:'progress'}};
    let meta=null;try{meta=await loadMeta({id:group.id,type:'series',name:seed?.name})}catch(_){}
    if(!meta)return null;const {all,watchable}=eligibleVideos(meta);const s=progressSeed(seed);
    const nextAll=all.find(v=>afterSeed(v,s)&&v.available!==false);
    const nextAired=watchable.find(v=>afterSeed(v,s)&&isAired(v,now));
    if(nextAired)return {continue:rowForEpisode(meta,nextAired,seed,'next')};
    if(nextAll&&!isAired(nextAll,now))return {upcoming:rowForEpisode(meta,nextAll,seed,'upcoming')};
    return null;
  });
  const cont=[...movies,...resolved.map(x=>x?.continue).filter(Boolean)];
  const upcoming=resolved.map(x=>x?.upcoming).filter(Boolean).sort((a,b)=>(a._releaseAt||Infinity)-(b._releaseAt||Infinity));
  const keys=new Set();const dedupe=arr=>arr.filter(x=>{const k=String(x?._progress?.contentId||x.id);if(keys.has(k))return false;keys.add(k);return true});
  const continueItems=dedupe(cont);keys.clear();for(const x of continueItems)keys.add(String(x?._progress?.contentId||x.id));
  const upcomingItems=upcoming.filter(x=>!keys.has(String(x?._progress?.contentId||x.id)));
  return {continueItems,upcomingItems,nextRefreshAt:upcomingItems.reduce((min,x)=>x._releaseAt&&x._releaseAt>now?Math.min(min,x._releaseAt):min,Infinity)};
}
window.AIOContinue=Object.freeze({parseRelease,isAired,airBadge,eligibleVideos,resolve});
})();