'use strict';
// Download-only selection sessions are independent of playback leases.
const crypto=require('crypto');
const vod=require('./VodGateway');
const external=require('./ExternalPlaybackBridge');
const sessions=new Map();
const TTL=10*60*1000;
function clean(){for(const [id,s] of sessions)if(s.expires<Date.now())sessions.delete(id);}
function fail(message,status=400){const e=new Error(message);e.statusCode=status;throw e;}
function owner(s,userId){if(!s||s.userId!==String(userId||''))fail('Download selection expired or unavailable.',410);s.expires=Date.now()+TTL;return s;}
async function options(userId,type,id){
  if(!userId)fail('Sign in required.',401);
  clean();
  type=vod.validStremioType(type);
  if(typeof id!=='string'||!id.trim()||id.length>500)fail('Invalid content ID.');
  const rows=await vod.rawPlaybackCandidates(type,id,'web');
  const client=vod._clientFor('streams','web');
  const selected=rows.filter(row=>row&&typeof row.url==='string'&&row.url.trim()&&!['info','statistic','error'].includes(String(row.streamData?.type||'').toLowerCase()));
  const candidates=selected.map(row=>({
    target:client.absolutizePlaybackUrl(row.url),
    headers:row.behaviorHints?.proxyHeaders?.request||{},
    name:String(row.name||''),
    title:String(row.title||''),
    description:String(row.description||''),
    size:Number(row.behaviorHints?.videoSize)||0
  })).filter(row=>row.target&&!/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(row.target));
  const token=crypto.randomUUID();
  sessions.set(token,{userId:String(userId),candidates,expires:Date.now()+TTL});
  if(sessions.size>500){clean();if(sessions.size>500)sessions.delete(sessions.keys().next().value);}
  return {selectionId:token,candidates:candidates.map((row,index)=>({index,name:row.name,title:row.title,description:row.description,size:row.size}))};
}
async function select(userId,selectionId,index,filename){
  clean();
  const session=owner(sessions.get(String(selectionId||'')),userId);
  if(!Number.isInteger(index)||index<0||index>=session.candidates.length)fail('Invalid download option.');
  const row=session.candidates[index];
  if(!/^https?:\/\//i.test(row.target))fail('Invalid media URL.');
  const probe=await fetch(row.target,{method:'GET',headers:{...row.headers,Range:'bytes=0-0'},redirect:'follow',signal:AbortSignal.timeout(12000)});
  const mime=String(probe.headers.get('content-type')||'').toLowerCase();
  if(probe.body)await probe.body.cancel().catch(()=>{});
  if(!probe.ok||/text\/|application\/json|mpegurl|dash\+xml/.test(mime))fail('Source is not a directly downloadable media file.',409);
  const ext=mime.includes('matroska')?'.mkv':mime.includes('webm')?'.webm':mime.includes('quicktime')?'.mov':'.mp4';
  const safe=String(filename||'AIOPlay download').replace(/[^a-z0-9 ._()\-]/gi,'').trim().slice(0,140)||'AIOPlay download';
  const issued=external.issue({kind:'direct',url:row.target,...(Object.keys(row.headers).length?{requestHeaders:row.headers}:{})},{downloadName:safe.replace(/\.(mp4|mkv|mov|webm)$/i,'')+ext});
  if(!issued)fail('Download link could not be created.',409);
  sessions.delete(selectionId);
  return {url:'/api/v1/external-play/'+encodeURIComponent(issued.token),expiresAt:new Date(issued.expiresAt).toISOString()};
}
module.exports={options,select,_sessions:sessions};
