const assert=require('assert');const fs=require('fs');const vm=require('vm');const path=require('path');
const store=new Map();let calls=0;let resolveFetch;
const context={window:{},localStorage:{setItem:(k,v)=>store.set(k,v),getItem:k=>store.get(k)||null,removeItem:k=>store.delete(k)},AbortController,Date,JSON,console,setTimeout,clearTimeout,fetch:async()=>{calls++;return new Promise(r=>{resolveFetch=()=>r({ok:true,status:200,json:async()=>({ok:true})})})}};
vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/data-layer.js'),'utf8'),context);
const D=context.window.AIOData;
(async()=>{
 assert.equal(D.canonicalMediaKey({type:'movie',imdbId:'TT123'}),'movie:imdb:tt123');
 assert.equal(D.canonicalMediaKey({type:'tv',tmdbId:42}),'series:tmdb:42');
 assert.equal(D.canonicalPersonKey({id:9,name:'Actor'}),'person:tmdb:9');
 assert.equal(D.dedupe([{type:'movie',id:'a'},{type:'movie',id:'a'}]).length,1);
 D.saveSnapshot('x',{value:7},60000);assert.equal(D.loadSnapshot('x').value,7);D.clearSnapshot('x');assert.equal(D.loadSnapshot('x'),null);
 const a=D.requestJson('/same',{key:'same'});const b=D.requestJson('/same',{key:'same'});assert.equal(calls,1);resolveFetch();assert.deepEqual(await a,{ok:true});assert.deepEqual(await b,{ok:true});
 console.log('data-layer behavior passed');
})().catch(err=>{console.error(err);process.exit(1)});