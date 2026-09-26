'use strict';

const { StremioServiceClient, UpstreamServiceError } = require('./StremioServiceClient');
let sourceClient = null;

const TTL_MS = Math.max(60_000, Number(process.env.COLLECTIONS_TTL_MS) || 10 * 60_000);
let cache = null;

function sourceUrl() {
  const raw = String(process.env.NUVIO_COLLECTIONS_URL || '').trim();
  if (!raw) throw new UpstreamServiceError('Collections source is not configured.', { statusCode:503, code:'COLLECTIONS_NOT_CONFIGURED' });
  let url;
  try { url = new URL(raw); } catch (_) { throw new UpstreamServiceError('Collections source URL is invalid.', { statusCode:503, code:'INVALID_COLLECTIONS_URL' }); }
  if (!['http:','https:'].includes(url.protocol)) throw new UpstreamServiceError('Collections source must use HTTP or HTTPS.', { statusCode:503, code:'INVALID_COLLECTIONS_URL' });
  return url;
}
function text(v,max=240){ return String(v||'').trim().slice(0,max); }
function image(v){ const s=text(v,2000); if(!s)return ''; try{const u=new URL(s);return ['http:','https:'].includes(u.protocol)?u.toString():''}catch(_){return ''} }
function refsFrom(node, out=[]){
  if(!node||typeof node!=='object') return out;
  const type=text(node.type||node.contentType,40).toLowerCase();
  const id=text(node.catalogId||node.catalog_id||node.catalog,500);
  if(id && ['movie','series'].includes(type)) out.push({type,id,name:text(node.name||node.title||id),addonId:text(node.addonId||node.addon_id,500)});
  for(const value of Object.values(node)) if(value&&typeof value==='object') refsFrom(value,out);
  return out;
}
function normalize(raw){
  const root=raw&&typeof raw==='object'?raw:{};
  // Xperience exposes ordinary Stremio catalogs rather than a nested Nuvio
  // collections document. Treat every directly loadable home catalog as a
  // discovery collection and pair movie/series catalogs with the same name.
  if (Array.isArray(root.catalogs)) {
    const groups = new Map();
    for (const cat of root.catalogs) {
      if (!cat || !cat.id || !['movie','series'].includes(String(cat.type||'').toLowerCase())) continue;
      if (cat.showInHome === false) continue;
      const required = (Array.isArray(cat.extra) ? cat.extra : []).filter(x=>x&&x.isRequired).map(x=>String(x.name||''));
      if (required.length) continue;
      const name=text(cat.name||cat.id);
      const key=name.toLowerCase();
      if (!groups.has(key)) groups.set(key,{id:'xperience-'+key.replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),name,description:'',poster:'',backdrop:'',layout:'rows',catalogs:[]});
      groups.get(key).catalogs.push({type:String(cat.type).toLowerCase(),id:String(cat.id),name,addonId:text(root.id,500),source:'xperience'});
    }
    return { name:text(root.name||root.title||'Collections'), collections:[...groups.values()] };
  }
  const source=Array.isArray(root.collections)?root.collections:Array.isArray(root.folders)?root.folders:Array.isArray(root.items)?root.items:[];
  const collections=source.slice(0,100).map((item,index)=>{
    const refs=[]; const seen=new Set();
    for(const ref of refsFrom(item)){const k=ref.type+'|'+ref.id;if(!seen.has(k)){seen.add(k);refs.push(ref)}}
    return {
      id:text(item.id||item.slug||('collection-'+index),160),
      name:text(item.name||item.title||('Collection '+(index+1))),
      description:text(item.description||item.subtitle,800),
      poster:image(item.poster||item.image||item.cover||item.logo),
      backdrop:image(item.backdrop||item.background||item.hero),
      layout:text(item.viewMode||item.layout||item.tileShape||'rows',40),
      catalogs:refs.slice(0,100)
    };
  }).filter(x=>x.name&&x.catalogs.length);
  // Some manifests are themselves a catalog-bearing collection.
  if(!collections.length){const refs=refsFrom(root);if(refs.length)collections.push({id:'featured',name:text(root.name||'Collections'),description:text(root.description,800),poster:image(root.poster||root.image||root.logo),backdrop:image(root.backdrop||root.background),layout:'rows',catalogs:refs});}
  return { name:text(root.name||root.title||'Collections'), collections };
}
async function fetchJson(url){
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),12000); timer.unref?.();
  try{
    const response=await fetch(url,{headers:{Accept:'application/json','User-Agent':'AIOPlay/Collections'},redirect:'follow',signal:controller.signal});
    if(!response.ok) throw new UpstreamServiceError('Collections source returned an error.',{statusCode:502,code:'COLLECTIONS_HTTP_ERROR'});
    const textBody=await response.text(); if(Buffer.byteLength(textBody,'utf8')>4*1024*1024) throw new UpstreamServiceError('Collections source is too large.',{statusCode:502,code:'COLLECTIONS_TOO_LARGE'});
    return JSON.parse(textBody);
  }catch(err){if(err instanceof UpstreamServiceError)throw err;throw new UpstreamServiceError('Could not load Collections source.',{statusCode:502,code:'COLLECTIONS_UNAVAILABLE'});}
  finally{clearTimeout(timer)}
}
async function manifest(force=false){
  const now=Date.now(); if(!force&&cache&&now-cache.at<TTL_MS)return cache.value;
  const value=normalize(await fetchJson(sourceUrl())); cache={at:now,value}; return value;
}
function xperienceClient(){
  const url=sourceUrl().toString();
  if(!sourceClient || sourceClient._collectionsUrl!==url){
    sourceClient=new StremioServiceClient(url,{serviceName:'Xperience Collections',manifestTtlMs:TTL_MS});
    sourceClient._collectionsUrl=url;
  }
  return sourceClient;
}
async function catalog(type,id,extra={}){
  // These catalog IDs belong to Xperience itself, so fetch them from that
  // manifest's resource base. Playback/details still remain AIOPlay-owned.
  return xperienceClient().catalog(type,id,extra);
}
module.exports={manifest,catalog};
