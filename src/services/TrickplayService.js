'use strict';
const crypto=require('crypto'),childProcess=require('child_process'),fs=require('fs'),path=require('path');
const {DATA_DIR}=require('../config');
const ROOT=process.env.AIOPLAY_TRICKPLAY_DIR||path.join(DATA_DIR,'trickplay');
const TTL_MS=Math.max(3600000,Number(process.env.AIOPLAY_TRICKPLAY_TTL_MS)||7*24*3600000);
const MAX_BYTES=Math.max(64*1024*1024,Number(process.env.AIOPLAY_TRICKPLAY_MAX_BYTES)||1024*1024*1024);
const TILE_W=Math.max(120,Math.min(480,Number(process.env.AIOPLAY_TRICKPLAY_WIDTH)||240));
const TILE_H=Math.round(TILE_W*9/16),COLS=5,ROWS=5,PER_SHEET=COLS*ROWS;
const jobs=new Map();
function ensureRoot(){fs.mkdirSync(ROOT,{recursive:true})}
function safeHeaders(target){const h=target?.requestHeaders&&typeof target.requestHeaders==='object'?target.requestHeaders:{};return Object.entries(h).filter(([k])=>!/^(?:host|content-length|range)$/i.test(k)).map(([k,v])=>String(k)+': '+String(v)).join('\r\n')}
function keyFor(target){return crypto.createHash('sha256').update(String(target?.url||'')+'\n'+safeHeaders(target)).digest('hex').slice(0,32)}
function dirFor(key){return path.join(ROOT,key)}
function manifestFor(key){try{return JSON.parse(fs.readFileSync(path.join(dirFor(key),'manifest.json'),'utf8'))}catch(_){return null}}
function publicManifest(key,m){return {...m,sheets:(m.sheets||[]).map((x,i)=>({index:i,url:'/api/v1/trickplay/'+key+'/sheet-'+String(i).padStart(3,'0')+'.jpg'}))}}
function touch(dir){try{const now=new Date();fs.utimesSync(dir,now,now)}catch(_){}}
function cleanup(){
 ensureRoot();const entries=[];
 for(const name of fs.readdirSync(ROOT)){const dir=path.join(ROOT,name);let st;try{st=fs.statSync(dir)}catch(_){continue}if(!st.isDirectory())continue;
   let size=0;try{for(const f of fs.readdirSync(dir)){try{size+=fs.statSync(path.join(dir,f)).size}catch(_){}}}catch(_){}
   if(Date.now()-st.mtimeMs>TTL_MS){try{fs.rmSync(dir,{recursive:true,force:true})}catch(_){};continue}entries.push({dir,size,mtime:st.mtimeMs});
 }
 let total=entries.reduce((n,x)=>n+x.size,0);for(const e of entries.sort((a,b)=>a.mtime-b.mtime)){if(total<=MAX_BYTES)break;try{fs.rmSync(e.dir,{recursive:true,force:true});total-=e.size}catch(_){}}
}
async function probe(target){
 const args=['-v','error'];const headers=safeHeaders(target);if(headers)args.push('-headers',headers+'\r\n');args.push('-show_entries','format=duration','-of','default=nw=1:nk=1',String(target.url));
 return new Promise((resolve,reject)=>{const p=childProcess.spawn('ffprobe',args,{stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',code=>{const duration=Number(out.trim());code===0&&duration>0?resolve(duration):reject(new Error(err.trim()||'Could not probe media duration.'))})});
}
async function generate(key,target){
 ensureRoot();const dir=dirFor(key),tmp=dir+'.tmp-'+process.pid+'-'+Date.now();fs.rmSync(tmp,{recursive:true,force:true});fs.mkdirSync(tmp,{recursive:true});
 try{
   const duration=await probe(target),interval=Math.max(5,Math.ceil(duration/300)),count=Math.max(1,Math.ceil(duration/interval)),sheetCount=Math.ceil(count/PER_SHEET);
   const args=['-hide_banner','-loglevel','error'];const headers=safeHeaders(target);if(headers)args.push('-headers',headers+'\r\n');args.push('-i',String(target.url),'-an','-sn','-vf',`fps=1/${interval},scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,pad=${TILE_W}:${TILE_H}:(ow-iw)/2:(oh-ih)/2,tile=${COLS}x${ROWS}:nb_frames=${PER_SHEET}`,'-q:v','5','-frames:v',String(sheetCount),path.join(tmp,'sheet-%03d.jpg'));
   await new Promise((resolve,reject)=>{const p=childProcess.spawn('ffmpeg',args,{stdio:['ignore','ignore','pipe']});let err='';p.stderr.on('data',d=>{err=(err+d).slice(-4000)});p.on('error',reject);p.on('close',code=>code===0?resolve():reject(new Error(err||'Trickplay generation failed.')))});
   const sheets=fs.readdirSync(tmp).filter(x=>/^sheet-\d+\.jpg$/.test(x)).sort();if(!sheets.length)throw new Error('No trickplay sprites were generated.');
   const manifest={version:1,key,duration,interval,tileWidth:TILE_W,tileHeight:TILE_H,columns:COLS,rows:ROWS,framesPerSheet:PER_SHEET,frameCount:count,createdAt:new Date().toISOString(),sheets};
   fs.writeFileSync(path.join(tmp,'manifest.json'),JSON.stringify(manifest));fs.rmSync(dir,{recursive:true,force:true});fs.renameSync(tmp,dir);cleanup();return manifest;
 }catch(err){fs.rmSync(tmp,{recursive:true,force:true});throw err}
}
function request(target){
 if(!target||target.kind!=='direct'||!target.url||/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(String(target.url)))return{status:'unsupported'};
 cleanup();const key=keyFor(target),cached=manifestFor(key);if(cached){touch(dirFor(key));return{status:'ready',key,manifest:publicManifest(key,cached)}}
 if(jobs.has(key))return{status:'generating',key};
 const job=generate(key,target).catch(err=>{console.warn('[trickplay] generation failed:',err.message)}).finally(()=>jobs.delete(key));jobs.set(key,job);return{status:'generating',key};
}
function status(key){const m=manifestFor(String(key||''));if(m){touch(dirFor(key));return{status:'ready',key,manifest:publicManifest(key,m)}}return jobs.has(String(key||''))?{status:'generating',key}:{status:'missing',key}}
function serve(key,file,res){if(!/^[a-f0-9]{32}$/.test(String(key))||!/^sheet-\d{3}\.jpg$/.test(String(file)))return res.status(404).end();const p=path.join(dirFor(key),file);if(!fs.existsSync(p))return res.status(404).end();touch(dirFor(key));res.type('image/jpeg');res.setHeader('Cache-Control','private, max-age=86400');return res.sendFile(p)}
module.exports={request,status,serve,cleanup,_keyFor:keyFor,_manifestFor:manifestFor};
