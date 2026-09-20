'use strict';

const registry = require('../src/services/AppServiceRegistry');
const playback = require('../src/services/OpaquePlayback');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};

const saved = {
  VOD_ENABLED: process.env.VOD_ENABLED,
  AIOMETADATA_MANIFEST_URL: process.env.AIOMETADATA_MANIFEST_URL,
  AIOSTREAMS_MANIFEST_URL: process.env.AIOSTREAMS_MANIFEST_URL,
  AIOSPORT_MANIFEST_URL: process.env.AIOSPORT_MANIFEST_URL,
  SPORTS_ENABLED: process.env.SPORTS_ENABLED
};
const restore = () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

try {
  delete process.env.VOD_ENABLED;
  delete process.env.AIOMETADATA_MANIFEST_URL;
  delete process.env.AIOSTREAMS_MANIFEST_URL;
  delete process.env.AIOSPORT_MANIFEST_URL;
  delete process.env.SPORTS_ENABLED;

  console.log('--- app-wide service registry');
  let boot = registry.publicBootstrap();
  t(true, boot.services.sports.enabled, 'sports is enabled by default');
  t(false, boot.services.vod.enabled, 'VOD stays off until both app-wide services are configured and enabled');
  t(false, boot.playback.exposeStreamChoices, 'first-party clients never expose stream choices');
  t(false, boot.playback.exposeProviderNames, 'first-party clients never expose provider names');
  t('server', boot.playback.selectionOwner, 'the server owns playback selection');
  t(false, JSON.stringify(boot).includes('manifestUrl'), 'bootstrap never leaks manifest URLs');

  process.env.VOD_ENABLED = 'true';
  process.env.AIOMETADATA_MANIFEST_URL = 'https://metadata.example.test/config/manifest.json';
  process.env.AIOSTREAMS_MANIFEST_URL = 'https://streams.example.test/config/manifest.json';
  boot = registry.publicBootstrap();
  t(true, boot.services.metadata.enabled, 'AIOMetadata is globally enabled by its one manifest URL');
  t(true, boot.services.streams.enabled, 'AIOStreams is globally enabled by its one manifest URL');
  t(true, boot.services.vod.enabled, 'VOD activates only when both global services exist');
  t(true, boot.contentTypes.includes('movie') && boot.contentTypes.includes('series'), 'VOD capabilities appear without a per-user addon list');
  t('https://streams.example.test/config/manifest.json', registry.manifestUrl('streams'), 'backend can read the private AIOStreams manifest URL');

  process.env.AIOMETADATA_MANIFEST_URL = 'javascript:alert(1)';
  boot = registry.publicBootstrap();
  t(false, boot.services.metadata.enabled, 'non-http manifest URLs are rejected');
  t(false, boot.services.vod.enabled, 'invalid metadata URL disables VOD');

  console.log('--- opaque playback target');
  t('abc123', playback._normaliseSportsId('nuvio_sport_abc123'), 'canonical catalog ids are not double-prefixed');
  t('abc123', playback._normaliseSportsId('abc123'), 'raw sports ids remain accepted');
  const target = playback._opaqueTarget({
    name: 'Provider Secret',
    title: 'Source 1 1080p',
    score: 999,
    _source: 'private-provider',
    url: 'https://cdn.example.test/live.m3u8',
    behaviorHints: {
      proxyHeaders: {
        request: {
          Referer: 'https://origin.example.test/',
          'User-Agent': 'Player'
        }
      }
    }
  });
  t('direct', target.kind, 'client receives only playback kind');
  t('https://cdn.example.test/live.m3u8', target.url, 'client receives only the selected playback URL');
  t('https://origin.example.test/', target.requestHeaders.Referer, 'required playback headers survive');
  const serialized = JSON.stringify(target);
  t(false, serialized.includes('Provider Secret'), 'provider display name is stripped');
  t(false, serialized.includes('Source 1'), 'stream title is stripped');
  t(false, serialized.includes('private-provider'), 'internal source id is stripped');
  t(false, serialized.includes('999'), 'ranking score is stripped');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} finally {
  restore();
}
