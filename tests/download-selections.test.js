'use strict';
const assert=require('node:assert/strict');
const service=require('../src/services/DownloadSelections');
const vod=require('../src/services/VodGateway');
const original=vod.rawPlaybackCandidates,originalClient=vod._clientFor;
(async()=>{
  vod.rawPlaybackCandidates=async()=>[
    {url:'https://example.org/a.mp4',name:'AIOStreams 4K',title:'Movie\nHDR',description:'Audio: English\nSubtitles: English',behaviorHints:{videoSize:1024}},
    {url:'https://example.org/b.m3u8',name:'HLS',title:'HLS'},
    {url:'',name:'info',title:'No sources'}
  ];
  vod._clientFor=()=>({absolutizePlaybackUrl:u=>u});
  const result=await service.options('user-a','movie','tt1234567');
  assert.equal(result.candidates.length,1);
  assert.equal(result.candidates[0].title,'Movie\nHDR');
  assert.equal(result.candidates[0].description,'Audio: English\nSubtitles: English');
  assert.equal(service._sessions.get(result.selectionId).candidates[0].target,'https://example.org/a.mp4');
  await assert.rejects(()=>service.select('user-b',result.selectionId,0,'test'),/expired or unavailable/);
  await assert.rejects(()=>service.select('user-a',result.selectionId,100,'test'),/Invalid download option/);
  vod.rawPlaybackCandidates=original;vod._clientFor=originalClient;
  console.log('DownloadSelections contract tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
