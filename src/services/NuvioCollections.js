'use strict';

const fs = require('fs/promises');
const { UpstreamServiceError } = require('./StremioServiceClient');
const vod = require('./VodGateway');

const FILE = String(process.env.NUVIO_COLLECTIONS_FILE || '/data/COLLECTIONS.json').trim();
const TTL_MS = Math.max(5_000, Number(process.env.COLLECTIONS_TTL_MS) || 30_000);
let cache = null;

function text(v,max=500){ return String(v||'').trim().slice(0,max); }
function image(v){ const s=text(v,2000); if(!s)return ''; try{const u=new URL(s);return ['http:','https:'].includes(u.protocol)?u.toString():''}catch(_){return ''} }
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
module.exports={manifest,catalog};
