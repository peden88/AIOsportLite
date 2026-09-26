'use strict';

const fs = require('fs/promises');
const path = require('path');
const { UpstreamServiceError } = require('./StremioServiceClient');
const vod = require('./VodGateway');

const FILE = String(process.env.NUVIO_COLLECTIONS_FILE || '/data/COLLECTIONS.json').trim();
const TTL_MS = Math.max(5_000, Number(process.env.COLLECTIONS_TTL_MS) || 30_000);
let cache = null;

function text(v,max=500){ return String(v||'').trim().slice(0,max); }
function image(v){ const s=text(v,2000); if(!s)return ''; if(/^\/collections-assets\/[A-Za-z0-9._\/-]+$/.test(s)&&!s.includes('..'))return s; try{const u=new URL(s);return ['http:','https:'].includes(u.protocol)?u.toString():''}catch(_){return ''} }
function source(s){
  if(!s||typeof s!=='object') return null;
  const provider=text(s.provider,40).toLowerCase();
  const type=text(s.type||s.mediaType,40).toLowerCase();
  return {
    provider,
    type:type==='movie'||type==='series'?type:'',
    id:text(s.catalogId||s.id,500),
    addonId:text(s.addonId,500),
    title:text(s.title||s.name),
    genre:text(s.genre,120),
    tmdbSourceType:text(s.tmdbSourceType,80),
    tmdbId:text(s.tmdbId,120),
    sortBy:text(s.sortBy,120),
    filters:s.filters&&typeof s.filters==='object'?s.filters:{}
  };
}
function normalize(raw){
  if(!Array.isArray(raw)) throw new UpstreamServiceError('Local Collections file must contain a JSON array.',{statusCode:502,code:'INVALID_COLLECTIONS_FILE'});
  return {name:'Collections',collections:raw.slice(0,100).map((col,ci)=>({
    id:text(col.id||('collection-'+ci),160),
    name:text(col.title||col.name||('Collection '+(ci+1))),
    pinToTop:!!col.pinToTop, showAllTab:!!col.showAllTab,
    viewMode:text(col.viewMode||'FOLLOW_LAYOUT',40),
    focusGlowEnabled:col.focusGlowEnabled!==false,
    folders:(Array.isArray(col.folders)?col.folders:[]).slice(0,200).map((f,fi)=>({
      id:text(f.id||('folder-'+ci+'-'+fi),160), name:text(f.title||f.name||('Folder '+(fi+1))),
      hideTitle:!!f.hideTitle, tileShape:text(f.tileShape||'POSTER',40).toUpperCase(),
      focusGlowEnabled:f.focusGlowEnabled!==false, focusGifEnabled:!!f.focusGifEnabled,
      coverImageUrl:image(f.coverImageUrl||f.poster||f.image||f.cover),
      titleLogoUrl:image(f.titleLogoUrl), heroBackdropUrl:image(f.heroBackdropUrl||f.backdrop),
      focusGifUrl:image(f.focusGifUrl),
      sources:(Array.isArray(f.sources)?f.sources:[]).map(source).filter(Boolean)
    }))
  })).filter(c=>c.folders.length)};
}
async function manifest(force=false){
  const now=Date.now(); if(!force&&cache&&now-cache.at<TTL_MS)return cache.value;
  try{
    const stat=await fs.stat(FILE); if(!stat.isFile()||stat.size>8*1024*1024) throw new Error('invalid file');
    const raw=JSON.parse(await fs.readFile(FILE,'utf8')); const value=normalize(raw);
    cache={at:now,value}; return value;
  }catch(err){
    if(err instanceof UpstreamServiceError)throw err;
    throw new UpstreamServiceError('Could not load local Collections file.',{statusCode:502,code:'COLLECTIONS_FILE_UNAVAILABLE'});
  }
}

async function catalog(type,id,extra={}){ return vod.catalog(type,id,extra); }

function tmdbHeaders(){
  const token=String(process.env.TMDB_API_READ_ACCESS_TOKEN||'').trim();
  return token?{Authorization:'Bearer '+token,Accept:'application/json'}:{Accept:'application/json'};
}
async function tmdbGet(endpoint){
  const key=String(process.env.TMDB_API_KEY||'').trim();
  const token=String(process.env.TMDB_API_READ_ACCESS_TOKEN||'').trim();
  if(!key&&!token) throw new UpstreamServiceError('TMDB credentials are not configured.',{statusCode:503,code:'TMDB_NOT_CONFIGURED'});
  const u=new URL('https://api.themoviedb.org'+endpoint);
  if(key&&!token)u.searchParams.set('api_key',key);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);timer.unref?.();
  try{
    const r=await fetch(u,{headers:tmdbHeaders(),signal:controller.signal});
    if(!r.ok)throw new Error('TMDB HTTP '+r.status);
    return await r.json();
  }catch(err){throw new UpstreamServiceError('Could not load TMDB collection.',{statusCode:502,code:'TMDB_COLLECTION_FAILED'});}
  finally{clearTimeout(timer)}
}
function tmdbMeta(item,forcedType=''){
  const type=String(item.media_type||forcedType||'movie').toLowerCase()==='tv'?'series':String(item.media_type||forcedType||'movie').toLowerCase();
  if(!['movie','series'].includes(type)||!item.id)return null;
  return {id:'tmdb:'+item.id,type,name:item.title||item.name||'',poster:item.poster_path?'https://image.tmdb.org/t/p/w500'+item.poster_path:'',background:item.backdrop_path?'https://image.tmdb.org/t/p/original'+item.backdrop_path:'',description:item.overview||'',releaseInfo:String(item.release_date||item.first_air_date||'').slice(0,4)};
}
async function resolveTmdbSource(s){
  const kind=String(s.tmdbSourceType||'').toUpperCase(),id=encodeURIComponent(String(s.tmdbId||''));
  if(!id)return [];
  if(kind==='COLLECTION'){
    const body=await tmdbGet('/3/collection/'+id);
    return (body.parts||[]).map(x=>tmdbMeta(x,'movie')).filter(Boolean);
  }
  if(kind==='LIST'){
    const body=await tmdbGet('/4/list/'+id+'?page=1');
    return (body.results||[]).map(x=>tmdbMeta(x)).filter(Boolean);
  }
  return [];
}
async function resolveFolder(folderId){
  const m=await manifest(), folder=m.collections.flatMap(c=>c.folders).find(f=>f.id===folderId);
  if(!folder)throw new UpstreamServiceError('Collection folder not found.',{statusCode:404,code:'COLLECTION_FOLDER_NOT_FOUND'});
  const settled=await Promise.allSettled((folder.sources||[]).map(async s=>{
    if(s.provider==='addon'&&s.id&&['movie','series'].includes(s.type)){
      const body=await vod.catalog(s.type,s.id,s.genre&&s.genre.toLowerCase()!=='all'?{genre:s.genre}:{});
      return Array.isArray(body.metas)?body.metas:(Array.isArray(body.metasDetailed)?body.metasDetailed:[]);
    }
    if(s.provider==='tmdb')return resolveTmdbSource(s);
    return [];
  }));
  const metas=[],seen=new Set();
  for(const row of settled){if(row.status!=='fulfilled')continue;for(const meta of row.value){const k=String(meta.type||'movie')+'|'+String(meta.id||'');if(!meta.id||seen.has(k))continue;seen.add(k);metas.push(meta);}}
  if(!metas.length&&settled.some(x=>x.status==='rejected')){const first=settled.find(x=>x.status==='rejected');throw first.reason;}
  return {metas};
}
async function rawFile(){return JSON.parse(await fs.readFile(FILE,'utf8'));}
async function saveOrder(order){
  const raw=await rawFile(); if(!Array.isArray(raw))throw new Error('Invalid Collections file');
  const colOrder=Array.isArray(order?.collectionIds)?order.collectionIds.map(String):[];
  const rank=new Map(colOrder.map((id,i)=>[id,i]));
  raw.sort((a,b)=>(rank.has(String(a.id))?rank.get(String(a.id)):99999)-(rank.has(String(b.id))?rank.get(String(b.id)):99999));
  const folders=order&&typeof order.folders==='object'?order.folders:{};
  for(const col of raw){const ids=Array.isArray(folders[col.id])?folders[col.id].map(String):[];if(!ids.length||!Array.isArray(col.folders))continue;const r=new Map(ids.map((id,i)=>[id,i]));col.folders.sort((a,b)=>(r.has(String(a.id))?r.get(String(a.id)):99999)-(r.has(String(b.id))?r.get(String(b.id)):99999));}
  const tmp=FILE+'.tmp-'+process.pid;await fs.writeFile(tmp,JSON.stringify(raw,null,2)+'\n','utf8');await fs.rename(tmp,FILE);cache=null;return manifest(true);
}
module.exports={manifest,catalog,resolveFolder,saveOrder};

