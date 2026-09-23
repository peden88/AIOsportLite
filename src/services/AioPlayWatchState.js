'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

const FILE = path.join(DATA_DIR, 'aioplay-watch-state.json');
let store = null;
function clean(v,max=512){return String(v==null?'':v).replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,max)}
function type(v){const x=clean(v,24).toLowerCase();return x==='series'||x==='tv'||x==='episode'?'series':'movie'}
function load(){if(store)return store;try{store=JSON.parse(fs.readFileSync(FILE,'utf8'))}catch(_){store={version:1,users:{}}}if(!store.users)store.users={};return store}
function save(){fs.mkdirSync(DATA_DIR,{recursive:true});const t=FILE+'.tmp';fs.writeFileSync(t,JSON.stringify(load(),null,2),{mode:0o600});fs.renameSync(t,FILE)}
function bucket(uid){const id=clean(uid,128);if(!id)throw new Error('Missing user id.');const s=load();if(!s.users[id])s.users[id]={items:{}};if(!s.users[id].items)s.users[id].items={};return s.users[id].items}
function key(t,id,season,episode){let k=type(t)+'|'+clean(id);if(type(t)==='series'&&season!=null&&episode!=null)k+='|'+Number(season)+'|'+Number(episode);return k}
function list(uid){return Object.values(bucket(uid)).sort((a,b)=>b.updatedAt-a.updatedAt)}
function setWatched(uid,input){const id=clean(input.id||input.contentId);if(!id)return null;const row={id,type:type(input.type||input.contentType),season:Number.isFinite(Number(input.season))?Number(input.season):null,episode:Number.isFinite(Number(input.episode))?Number(input.episode):null,watched:Boolean(input.watched),updatedAt:Date.now()};bucket(uid)[key(row.type,id,row.season,row.episode)]=row;save();return row}
module.exports={list,setWatched};
