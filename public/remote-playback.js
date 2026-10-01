/* AIOPlay remote playback abstraction. Cast transport is loaded lazily and
   never changes local playback unless the user explicitly connects. */
(()=>{'use strict';
const listeners=new Set();let state={mode:'local',available:false,connected:false,device:'',position:0,duration:0,paused:true};
let context=null,castContext=null,remotePlayer=null,remoteController=null,initialized=false;
function emit(patch={}){state={...state,...patch};listeners.forEach(fn=>{try{fn({...state})}catch(_){}});return state}
function subscribe(fn){listeners.add(fn);fn({...state});return()=>listeners.delete(fn)}
function setContext(next){context=next?{...next}:null}
function loadCastSdk(){if(window.cast?.framework)return Promise.resolve(true);return new Promise(resolve=>{let done=false;const finish=v=>{if(done)return;done=true;resolve(v)};window.__onGCastApiAvailable=ok=>finish(!!ok);const old=document.querySelector('script[data-aioplay-cast]');if(old){setTimeout(()=>finish(!!window.cast?.framework),5000);return}const s=document.createElement('script');s.src='https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';s.async=true;s.dataset.aioplayCast='1';s.onerror=()=>finish(false);document.head.appendChild(s);setTimeout(()=>finish(!!window.cast?.framework),8000)})}
async function init(){if(initialized)return state;initialized=true;const ok=await loadCastSdk();if(!ok||!window.cast?.framework){emit({available:false});return state}
 try{castContext=cast.framework.CastContext.getInstance();castContext.setOptions({receiverApplicationId:chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,autoJoinPolicy:chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED});remotePlayer=new cast.framework.RemotePlayer();remoteController=new cast.framework.RemotePlayerController(remotePlayer);
 const sync=()=>emit({available:true,connected:!!remotePlayer.isConnected,mode:remotePlayer.isConnected?'cast':'local',device:remotePlayer.displayName||'',position:Number(remotePlayer.currentTime||0),duration:Number(remotePlayer.duration||0),paused:!!remotePlayer.isPaused});
 ['IS_CONNECTED_CHANGED','CURRENT_TIME_CHANGED','DURATION_CHANGED','IS_PAUSED_CHANGED','DISPLAY_NAME_CHANGED'].forEach(k=>{const e=cast.framework.RemotePlayerEventType[k];if(e)remoteController.addEventListener(e,sync)});sync()}catch(_){emit({available:false})}return state}
async function requestSession(){await init();if(!castContext)throw new Error('Google Cast is unavailable in this browser.');await castContext.requestSession();return state}
async function load(media){if(!castContext)throw new Error('Cast is not initialised.');const session=castContext.getCurrentSession();if(!session)throw new Error('Choose a Cast device first.');const url=String(media?.url||context?.url||'');if(!url)throw new Error('No remote playback URL is available.');
 const info=new chrome.cast.media.MediaInfo(url,String(media?.contentType||context?.contentType||'video/mp4'));const meta=new chrome.cast.media.GenericMediaMetadata();meta.title=String(media?.title||context?.title||'AIOPlay');meta.subtitle=String(media?.subtitle||context?.subtitle||'');const image=String(media?.image||context?.image||'');if(image)meta.images=[new chrome.cast.Image(image)];info.metadata=meta;info.streamType=chrome.cast.media.StreamType.BUFFERED;
 const req=new chrome.cast.media.LoadRequest(info);req.currentTime=Math.max(0,Number(media?.position||context?.position||0));req.autoplay=true;await session.loadMedia(req);emit({mode:'cast',connected:true});return state}
function playPause(){if(remoteController)remoteController.playOrPause()}
function seek(seconds){if(!remotePlayer||!remoteController)return;remotePlayer.currentTime=Math.max(0,Number(seconds)||0);remoteController.seek()}
function stop(){try{castContext?.endCurrentSession(true)}catch(_){}emit({mode:'local',connected:false,device:'',position:0,duration:0,paused:true})}
window.AIORemote=Object.freeze({init,subscribe,setContext,requestSession,load,playPause,seek,stop,get state(){return {...state}}});
})();