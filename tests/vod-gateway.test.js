'use strict';

const http = require('http');
const assert = require('assert');

let server;
let base;
const seen = [];

function send(res, body, status = 200) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

server = http.createServer((req, res) => {
  seen.push(req.url);
  const u = new URL(req.url, 'http://local.test');
  const p = u.pathname;

  if (p === '/metadata/profile/manifest.json') {
    return send(res, {
      id: 'mock.metadata',
      version: '1.0.0',
      resources: ['catalog', 'meta'],
      types: ['movie', 'series'],
      catalogs: [
        {
          type: 'movie',
          id: 'popular',
          name: 'Popular Movies',
          extra: [
            { name: 'genre', options: ['Action', 'Drama'] },
            { name: 'skip' }
          ]
        },
        {
          type: 'movie',
          id: 'search.movie',
          name: 'Search Movies',
          extra: [{ name: 'search', isRequired: true }]
        },
        {
          type: 'series',
          id: 'search.series',
          name: 'Search Series',
          extra: [{ name: 'search', isRequired: true }]
        }
      ]
    });
  }

  if (p === '/metadata/profile/catalog/movie/popular.json') {
    return send(res, { metas: [{ id: 'tt0133093', type: 'movie', name: 'The Matrix' }] });
  }

  if (p === '/metadata/profile/catalog/movie/search.movie/search=Matrix.json') {
    return send(res, { metas: [{ id: 'tt0133093', type: 'movie', name: 'The Matrix' }] });
  }

  if (p === '/metadata/profile/catalog/series/search.series/search=Matrix.json') {
    return send(res, { metas: [{ id: 'tt10813940', type: 'series', name: 'The Matrix-ish Series' }] });
  }

  if (p === '/metadata/profile/meta/movie/tt0133093.json') {
    return send(res, { meta: { id: 'tt0133093', type: 'movie', name: 'The Matrix', poster: 'https://img.test/matrix.jpg' } });
  }

  if (p === '/streams/profile/manifest.json') {
    return send(res, {
      id: 'mock.streams.web',
      version: '1.0.0',
      resources: ['stream'],
      types: ['movie', 'series'],
      catalogs: []
    });
  }

  if (p === '/streams-app/profile/manifest.json') {
    return send(res, {
      id: 'mock.streams.app',
      version: '1.0.0',
      resources: ['stream'],
      types: ['movie', 'series'],
      catalogs: []
    });
  }

  if (p === '/streams/profile/stream/movie/tt0133093.json') {
    return send(res, {
      streams: [
        {
          name: '[ERROR] This is a notice, not playback',
          externalUrl: 'https://github.com/Viren070/AIOStreams',
          streamData: { type: 'error' }
        },
        {
          name: 'Statistics',
          externalUrl: 'https://github.com/Viren070/AIOStreams',
          streamData: { type: 'statistic' }
        },
        {
          name: 'SECRET PROVIDER A',
          title: 'Best ranked release',
          url: '/api/v1/debrid/playback/owned-chain',
          behaviorHints: {
            proxyHeaders: { request: { Referer: 'https://origin.test/' } }
          }
        },
        {
          name: 'SECRET PROVIDER B',
          title: 'Second ranked release',
          url: '/api/v1/debrid/playback/second-owned-chain'
        },
        {
          name: 'External page must never autoplay',
          externalUrl: 'https://example.test/watch-page'
        },
        {
          name: 'Torrent only',
          infoHash: 'deadbeef'
        }
      ]
    });
  }

  if (p === '/streams-app/profile/stream/movie/tt0133093.json') {
    return send(res, {
      streams: [
        {
          name: 'APP PROVIDER',
          title: 'App-specific release',
          url: '/api/v1/debrid/playback/app-owned-chain'
        }
      ]
    });
  }

  send(res, { error: 'not found', path: p }, 404);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;

  process.env.VOD_ENABLED = 'true';
  process.env.AIOMETADATA_MANIFEST_URL = base + '/metadata/profile/manifest.json?tag=family';
  process.env.AIOSTREAMS_MANIFEST_URL = base + '/streams/profile/manifest.json?profile=global';
  process.env.AIOSTREAMS_APP_MANIFEST_URL = base + '/streams-app/profile/manifest.json?profile=app';

  const vod = require('../src/services/VodGateway');
  const opaque = require('../src/services/OpaquePlayback');
  vod._resetForTests();

  console.log('--- VOD catalogs from one global AIOMetadata manifest');
  const descriptors = await vod.catalogs();
  assert.strictEqual(descriptors.catalogs.length, 3);
  assert.deepStrictEqual(descriptors.catalogs[0].genres, ['Action', 'Drama']);
  assert.strictEqual(descriptors.catalogs[1].searchable, true);
  assert.deepStrictEqual(descriptors.catalogs[1].requiredExtras, ['search']);

  const catalog = await vod.catalog('movie', 'popular', {});
  assert.strictEqual(catalog.metas[0].id, 'tt0133093');

  console.log('--- VOD search and metadata');
  const search = await vod.search('Matrix');
  assert.strictEqual(search.metas.length, 2);
  assert.ok(search.metas.some(x => x.id === 'tt0133093'));
  assert.ok(search.metas.some(x => x.id === 'tt10813940'));

  const meta = await vod.meta('movie', 'tt0133093');
  assert.strictEqual(meta.meta.name, 'The Matrix');

  console.log('--- AIOStreams ranked playback remains opaque');
  const candidates = await vod.playbackCandidates('movie', 'tt0133093');
  assert.strictEqual(candidates.length, 2);
  assert.ok(!JSON.stringify(candidates).includes('github.com/Viren070/AIOStreams'));
  assert.strictEqual(candidates[0].url, base + '/api/v1/debrid/playback/owned-chain');
  assert.strictEqual(candidates[0].behaviorHints.proxyHeaders.request.Referer, 'https://origin.test/');
  assert.strictEqual(candidates[1].url, base + '/api/v1/debrid/playback/second-owned-chain');
  assert.ok(!JSON.stringify(candidates).includes('example.test/watch-page'));
  assert.ok(!JSON.stringify(candidates).includes('SECRET PROVIDER'));
  assert.ok(!JSON.stringify(candidates).includes('Best ranked release'));

  console.log('--- Android playback can use a separate AIOStreams config');
  const appCandidates = await vod.playbackCandidates('movie', 'tt0133093', 'app');
  assert.strictEqual(appCandidates.length, 1);
  assert.strictEqual(appCandidates[0].url, base + '/api/v1/debrid/playback/app-owned-chain');
  assert.ok(!JSON.stringify(appCandidates).includes('APP PROVIDER'));

  const first = opaque.startOpaquePlayback('vod', 'movie:tt0133093', candidates);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.playback.url, base + '/api/v1/debrid/playback/owned-chain');
  assert.ok(!JSON.stringify(first).includes('SECRET PROVIDER'));

  const next = opaque.nextPlayback(first.sessionId);
  assert.strictEqual(next.ok, true);
  assert.strictEqual(next.playback.url, base + '/api/v1/debrid/playback/second-owned-chain');
  const done = opaque.nextPlayback(first.sessionId);
  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.exhausted, true);

  console.log('--- end-to-end VOD probe');
  const probe = await vod.probe();
  assert.strictEqual(probe.ok, true);
  assert.strictEqual(probe.content.type, 'movie');
  assert.strictEqual(probe.content.id, 'tt0133093');
  assert.strictEqual(probe.content.title, 'The Matrix');
  assert.strictEqual(probe.streams.playable, 2);
  assert.ok(!JSON.stringify(probe).includes('SECRET PROVIDER'));
  assert.ok(!JSON.stringify(probe).includes('/api/v1/debrid/playback/owned-chain'));

  console.log('--- VOD diagnostics never expose manifest URLs');
  const diagnostic = await vod.diagnostics();
  assert.strictEqual(diagnostic.vodEnabled, true);
  assert.strictEqual(diagnostic.metadata.reachable, true);
  assert.strictEqual(diagnostic.streams.reachable, true);
  assert.strictEqual(diagnostic.metadata.id, 'mock.metadata');
  assert.strictEqual(diagnostic.streams.id, 'mock.streams');
  assert.ok(!JSON.stringify(diagnostic).includes('/metadata/profile/manifest.json'));
  assert.ok(!JSON.stringify(diagnostic).includes('/streams/profile/manifest.json'));

  console.log('--- configured manifest query is preserved upstream');
  assert.ok(seen.some(x => x === '/metadata/profile/manifest.json?tag=family'));
  assert.ok(seen.some(x => x === '/metadata/profile/catalog/movie/popular.json?tag=family'));
  assert.ok(seen.some(x => x === '/streams/profile/stream/movie/tt0133093.json?profile=global'));
  assert.ok(seen.some(x => x === '/streams-app/profile/stream/movie/tt0133093.json?profile=app'));

  console.log('VOD gateway integration tests passed');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  if (server) server.close();
});
