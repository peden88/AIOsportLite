/* AIOPlay trickplay client: background manifest polling + sprite math. */
(()=>{'use strict';
let manifest=null,key='',timer=null,generation=0;
function reset(){generation++;clearTimeout(timer);timer=null;manifest=null;key=''}
async function start(sessionId){
 reset();if(!sessionId)return null;const gen=generation;
 try{const r=await fetch('/api/v1/playback/'+encodeURIComponent(sessionId)+'/trickplay',{method:'POST'});const d=await r.json().catch(()=>({}));if(gen!==generation)return null;if(!r.ok&&r.status!==202)return null;if(d.status==='ready'&&d.manifest){key=d.key;manifest=d.manifest;return manifest}if(d.key){key=d.key;poll(sessionId,d.key,gen)}}
 catch(_){}return null
}
async function poll(sessionId,k,gen){if(gen!==generation)return;try{const r=await fetch('/api/v1/playback/'+encodeURIComponent(sessionId)+'/trickplay/'+encodeURIComponent(k),{cache:'no-store'});const d=await r.json().catch(()=>({}));if(gen!==generation)return;if(r.ok&&d.status==='ready'&&d.manifest){key=k;manifest=d.manifest;window.dispatchEvent(new CustomEvent('aioplay:trickplay-ready',{detail:manifest}));return}}catch(_){}timer=setTimeout(()=>poll(sessionId,k,gen),2500)}
function frameAt(seconds,m=manifest){if(!m||!Number.isFinite(Number(seconds)))return null;const interval=Math.max(1,Number(m.interval)||1),count=Math.max(1,Number(m.frameCount)||1),per=Math.max(1,Number(m.framesPerSheet)||25);const frame=Math.max(0,Math.min(count-1,Math.floor(Number(seconds)/interval))),sheet=Math.floor(frame/per),cell=frame%per,col=cell%(Number(m.columns)||5),row=Math.floor(cell/(Number(m.columns)||5));const item=m.sheets?.[sheet];return item?{url:item.url,x:col*(Number(m.tileWidth)||240),y:row*(Number(m.tileHeight)||135),width:Number(m.tileWidth)||240,height:Number(m.tileHeight)||135,frame,sheet}:null}
window.AIOTrickplay=Object.freeze({start,reset,frameAt,get manifest(){return manifest}});
})();