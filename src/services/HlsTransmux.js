'use strict';
const crypto=require('crypto'),childProcess=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const sessions=new Map(),byPlayback=new Map();
function safeHeaders(t){const h=t&&t.requestHeaders&&typeof t.requestHeaders==='object'?t.requestHeaders:{};return Object.entries(h).filter(([k])=>!/^(?:host|content-length|range)$/i.test(k)).map(([k,v])=>String(k)+': '+String(v)).join('\r\n');}
function stop(id){const token=byPlayback.get(String(id||''));if(!token)return false;const s=sessions.get(token);byPlayback.delete(String(id||''));sessions.delete(token);if(s){try{s.process.kill('SIGKILL');}catch(_){}try{fs.rmSync(s.dir,{recursive:true,force:true});}catch(_){}}return true;}
async function start(id,target){
 stop(id);if(!target||!target.url)throw new Error('No media source is available.');
 const m=target.playbackMeta||{},video=String(m.codec||'').toUpperCase();
 const audio=String(m.audio||'').toUpperCase();
 const copyVideo=!video||/(?:H264|AVC)/.test(video);
 const copyAudio=/(?:^|\s|\/)(?:AAC)(?:\s|\/|$)/.test(audio);
 const fullTranscode=!copyVideo;
 const token=crypto.randomUUID(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'aioplay-hls-')),playlist=path.join(dir,'index.m3u8');
 const args=['-hide_banner','-loglevel','warning'];const headers=safeHeaders(target);if(headers)args.push('-headers',headers+'\r\n');
 args.push('-i',String(target.url),'-map','0:v:0','-map','0:a:0?');
 if(copyVideo) args.push('-c:v','copy');
 else args.push('-c:v','libx264','-preset',String(process.env.AIOPLAY_TRANSCODE_PRESET||'veryfast'),'-crf',String(process.env.AIOPLAY_TRANSCODE_CRF||'21'),'-pix_fmt','yuv420p','-profile:v','high','-level','4.1');
 if(copyAudio) args.push('-c:a','copy');
 else args.push('-c:a','aac','-b:a',String(process.env.AIOPLAY_AUDIO_BITRATE||'192k'),'-ac','2');
 args.push('-max_muxing_queue_size','2048');
 args.push('-f','hls','-hls_time','4','-hls_list_size','8','-hls_flags','delete_segments+append_list+independent_segments','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename',path.join(dir,'seg-%06d.m4s'),playlist);
 const proc=childProcess.spawn('ffmpeg',args,{stdio:['ignore','ignore','pipe']});const s={token,playbackId:String(id),dir,process:proc,createdAt:Date.now()};sessions.set(token,s);byPlayback.set(String(id),token);
 const deadline=Date.now()+12000;while(Date.now()<deadline){if(fs.existsSync(playlist)&&fs.statSync(playlist).size>20)return{token,mode:fullTranscode?'transcode':(copyAudio?'remux':'audio-transcode')};if(proc.exitCode!==null){stop(id);throw new Error('AIOPlay-compatible HLS could not be created from this source.');}await new Promise(r=>setTimeout(r,120));}
 stop(id);throw new Error('Timed out preparing AIOPlay-compatible playback.');
}
function serve(req,res){const s=sessions.get(String(req.params.token||''));if(!s)return res.status(404).send('Playback session expired.');const name=String(req.params.file||'');if(!/^(?:index\.m3u8|init\.mp4|seg-\d+\.m4s)$/.test(name))return res.status(404).end();const file=path.join(s.dir,name);if(!fs.existsSync(file))return res.status(404).end();if(name.endsWith('.m3u8'))res.type('application/vnd.apple.mpegurl');else if(name.endsWith('.mp4'))res.type('video/mp4');else res.type('video/iso.segment');res.setHeader('Cache-Control','no-store');return res.sendFile(file);}
module.exports={start,stop,serve,_sessions:sessions};
