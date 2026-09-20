// Lite Football catalog/detail regression tests. No network calls.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosportlite-fixtures-'));
const { asValue } = require('awilix');
const homeAway = require('../src/services/HomeAwayService');
const container = require('../src/container');
const catalog = require('../src/catalog');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};

const DAY = 86400000;
const NOW = Date.now();
const KICK = NOW + 3 * DAY;
const iso = ms => new Date(ms).toISOString();
const CREST = 'https://a.espncdn.com/i/teamlogos/soccer/500';

const EVENT = {
  date: iso(KICK),
  uid: 's:600~l:700~e:1001',
  competitions: [{
    venue: { fullName: 'Emirates Stadium' },
    status: { type: { state: 'pre' } },
    broadcasts: [{ names: ['Sky Sports'] }],
    competitors: [
      { homeAway: 'home', team: { displayName: 'Arsenal', shortDisplayName: 'Arsenal', logo: `${CREST}/scoreboard/359.png` } },
      { homeAway: 'away', team: { displayName: 'Chelsea', shortDisplayName: 'Chelsea', logo: `${CREST}/scoreboard/363.png` } }
    ]
  }]
};

homeAway._seed([EVENT], 'soccer/all');
homeAway._persist();

const preview = (m, conf = {}) => catalog._mapMatchToMetaPreview(m, conf);
const lineFrom = (desc, mark) => (String(desc).split('\n').find(l => l.startsWith(mark)) || '');
const fixture = date => ({
  id: 'provider-match',
  title: 'Chelsea vs Arsenal',
  category: 'football',
  date: String(date),
  sources: [{ source: 'x' }]
});

console.log('--- Football card enrichment');
const card = preview(fixture(KICK + 40 * 60000));
t(iso(KICK), card.released, 'ESPN corrects a large provider kickoff drift');
t('📡 On Sky Sports', lineFrom(card.description, '📡'), 'Football card carries the network line');
t(true, /Chelsea @ Arsenal/.test(card.name), 'Football card is oriented visitor @ home');

console.log('--- Lite catalogs');
const serve = list => container.register({
  cacheService: asValue({ getMatches: () => (list || []).map(m => ({ ...m })) }),
  cronService: asValue({ ensureFresh() {} })
});
const tab = async (name, conf = {}, list = []) => {
  serve(list);
  const res = await catalog.handleCatalog('tv', `nuvio_sports_${name}`, {}, conf, { revalidate: false });
  return res.metas;
};

(async () => {
  const football = await tab('football', {}, [fixture(KICK)]);
  t(1, football.length, 'Football tab returns Football fixtures');

  const basketball = await tab('basketball', {}, [{ ...fixture(KICK), id: 'b1', category: 'basketball' }]);
  t(1, basketball.length, 'generic handler remains defensive for legacy direct calls');

  const teams = await tab('teams', { teams: 'Arsenal' }, []);
  const pending = teams.filter(m => String(m.description).includes('⏳ No streams listed yet'));
  t(1, pending.length, 'Your Teams can surface a scheduled Football fixture with no stream yet');
  t('📡 On Sky Sports', lineFrom((pending[0] || {}).description, '📡'), 'scheduled team fixture retains broadcast metadata');

  const noTeams = await tab('teams', {}, []);
  t(0, noTeams.length, 'Your Teams stays empty until configured');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
