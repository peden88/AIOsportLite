'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('../config');

const FILE = path.join(DATA_DIR, 'analytics-events.jsonl');
const RETENTION_DAYS = Math.max(7, Number(process.env.ANALYTICS_RETENTION_DAYS) || 90);
const MAX_WATCH_DELTA_MS = 2 * 60 * 1000;
const activePlayback = new Map();

function ensureDir(){ fs.mkdirSync(DATA_DIR,{recursive:true}); }
function clean(v,n=240){ return String(v??'').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,n); }
function append(event){
  ensureDir();
  const row={id:crypto.randomUUID(),at:Date.now(),...event};
  fs.appendFileSync(FILE,JSON.stringify(row)+'\n',{mode:0o600});
  return row;
}
function readEvents(){
  try{return fs.readFileSync(FILE,'utf8').split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line)}catch(_){return null}}).filter(Boolean)}
  catch(_){return []}
}
function record(type,{user=null,session=null,...data}={}){
  return append({type:clean(type,64),userId:clean(user?.id||data.userId,80),username:clean(user?.username||data.username,80),sessionId:clean(session?.id||data.sessionId,80),...data});
}
function login(user,session){return record('login',{user,session,device:clean(session?.deviceName),client:clean(session?.kind)});}
function loginFailed(username,req){return record('login_failed',{username:clean(username,80),client:'web',device:clean(req?.get?.('user-agent')||'',160)});}
function detailsView(user,body={}){return record('details_view',{user,contentType:clean(body.contentType||body.type,24),contentId:clean(body.contentId||body.id,180),title:clean(body.title||body.name),seriesTitle:clean(body.seriesTitle),season:num(body.season),episode:num(body.episode)});}
function playbackStart(user,session,lease,result={}){
  if(!lease)return;
  const key=clean(result.sessionId||lease.playbackSessionId||lease.id,100);
  const now=Date.now();
  activePlayback.set(key,{userId:user?.id||lease.userId,lastAt:now,watchedMs:0,leaseId:lease.id});
  return record('playback_start',{user,session,playbackSessionId:key,client:lease.client,device:lease.deviceName,contentType:lease.contentType,contentId:lease.contentId,title:lease.title,seriesTitle:lease.seriesTitle,season:lease.season,episode:lease.episode,episodeTitle:lease.episodeTitle});
}
function heartbeat(user,playbackSessionId){
  const key=clean(playbackSessionId,100), state=activePlayback.get(key), now=Date.now();
  if(!state){activePlayback.set(key,{userId:user?.id||'',lastAt:now,watchedMs:0});return 0}
  const delta=Math.max(0,Math.min(MAX_WATCH_DELTA_MS,now-state.lastAt));
  state.lastAt=now;state.watchedMs+=delta;
  if(delta>=1000)record('watch_time',{user,playbackSessionId:key,watchMs:delta});
  return delta;
}
function playbackStop(user,playbackSessionId,reason='stop'){
  const key=clean(playbackSessionId,100),state=activePlayback.get(key);
  heartbeat(user,key);activePlayback.delete(key);
  return record('playback_stop',{user,playbackSessionId:key,reason:clean(reason,40),watchMs:state?.watchedMs||0});
}
function streamSwitch(user,playbackSessionId){return record('stream_switch',{user,playbackSessionId:clean(playbackSessionId,100)});}
function num(v){const n=Number(v);return Number.isFinite(n)?n:null}
function summarize(users=[],days=30){
  const all=readEvents(), now=Date.now(), since=now-Math.max(1,Number(days)||30)*86400000, events=all.filter(e=>Number(e.at)>=since);
  const byUser=new Map(users.map(u=>[u.id,{userId:u.id,username:u.username,displayName:u.displayName,logins:0,lastLogin:null,detailsViews:0,plays:0,watchMs:0,unique:new Set(),lastActive:null}]));
  const titles=new Map(), daily=new Map(), devices=new Map();let logins=0,failedLogins=0,plays=0,watchMs=0,detailsViews=0,switches=0;
  for(const e of events){
    let u=byUser.get(e.userId);if(e.userId&&!u){u={userId:e.userId,username:e.username||'',displayName:e.username||'',logins:0,lastLogin:null,detailsViews:0,plays:0,watchMs:0,unique:new Set(),lastActive:null};byUser.set(e.userId,u)}
    if(u)u.lastActive=Math.max(u.lastActive||0,e.at||0);
    if(e.type==='login'){logins++;if(u){u.logins++;u.lastLogin=Math.max(u.lastLogin||0,e.at)}}
    if(e.type==='login_failed')failedLogins++;
    if(e.type==='details_view'){detailsViews++;if(u){u.detailsViews++;if(e.contentId)u.unique.add(e.contentId)}}
    if(e.type==='playback_start'){plays++;if(u)u.plays++;const k=e.contentType+':'+e.contentId;let t=titles.get(k);if(!t){t={contentType:e.contentType,contentId:e.contentId,title:e.seriesTitle||e.title||e.contentId,plays:0,watchMs:0,viewers:new Set()};titles.set(k,t)}t.plays++;if(e.userId)t.viewers.add(e.userId);const d=e.device||e.client||'Unknown';devices.set(d,(devices.get(d)||0)+1)}
    if(e.type==='watch_time'){const ms=Math.max(0,Number(e.watchMs)||0);watchMs+=ms;if(u)u.watchMs+=ms;const start=[...events].reverse().find(x=>x.type==='playback_start'&&x.playbackSessionId===e.playbackSessionId);if(start){const k=start.contentType+':'+start.contentId;const t=titles.get(k);if(t)t.watchMs+=ms}}
    if(e.type==='stream_switch')switches++;
    const day=new Date(e.at).toISOString().slice(0,10);if(!daily.has(day))daily.set(day,{date:day,plays:0,watchMs:0,logins:0});const d=daily.get(day);if(e.type==='playback_start')d.plays++;if(e.type==='watch_time')d.watchMs+=Number(e.watchMs)||0;if(e.type==='login')d.logins++;
  }
  const active7=new Set(events.filter(e=>e.userId&&e.at>=now-7*86400000).map(e=>e.userId)).size;
  const active30=new Set(events.filter(e=>e.userId&&e.at>=now-30*86400000).map(e=>e.userId)).size;
  return {periodDays:Number(days)||30,totals:{users:users.length,active7,active30,logins,failedLogins,detailsViews,plays,watchMs,streamSwitches:switches,uniqueTitles:new Set(events.filter(e=>e.contentId).map(e=>e.contentId)).size},users:[...byUser.values()].map(u=>({...u,uniqueTitles:u.unique.size,unique:undefined})).sort((a,b)=>b.watchMs-a.watchMs),titles:[...titles.values()].map(t=>({...t,viewers:t.viewers.size})).sort((a,b)=>b.watchMs-a.watchMs).slice(0,100),daily:[...daily.values()].sort((a,b)=>a.date.localeCompare(b.date)),devices:[...devices].map(([name,plays])=>({name,plays})).sort((a,b)=>b.plays-a.plays)};
}
function compact(){
  const cutoff=Date.now()-RETENTION_DAYS*86400000,rows=readEvents().filter(e=>Number(e.at)>=cutoff);
  ensureDir();const tmp=FILE+'.tmp';fs.writeFileSync(tmp,rows.map(x=>JSON.stringify(x)).join('\n')+(rows.length?'\n':''),{mode:0o600});fs.renameSync(tmp,FILE);return rows.length;
}
let timer=setInterval(()=>{try{compact()}catch(_){}},24*3600000);timer.unref?.();
module.exports={record,login,loginFailed,detailsView,playbackStart,heartbeat,playbackStop,streamSwitch,summarize,compact,RETENTION_DAYS,_readEvents:readEvents};
