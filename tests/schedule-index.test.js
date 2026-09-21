// Lite Football schedule-index regression tests. No network calls.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosportlite-schedule-'));
const homeAway = require('../src/services/HomeAwayService');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};

const INDEX_FILE = path.join(process.env.DATA_DIR, 'homeaway.json');
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const jobs = homeAway._plan(NOW);
const forBoard = b => jobs.filter(j => j.board === b);
const days = js => js.filter(j => j.dates.length === 8).map(j => j.dates);
const months = js => js.filter(j => j.dates.length === 6).map(j => j.dates);

console.log('--- Lite refresh plan');
t(true, jobs.every(j => j.board === 'soccer/all'), 'Lite asks ESPN only for association-football scoreboards');
t(true, jobs.every(j => !j.dates.includes('-')), 'no job uses the retired ESPN date-range form');
t(11, days(forBoard('soccer/all')).length, 'busy soccer board is fetched a day at a time near kickoff');
t('20260914', days(forBoard('soccer/all'))[0], 'daily window starts yesterday');
t('20260924', days(forBoard('soccer/all'))[10], 'daily window runs nine days ahead');
t(['202609', '202610', '202611'], months(forBoard('soccer/all')), '70-day horizon is covered by month');
t(14, jobs.length, 'one board needs only three monthly plus eleven daily requests');
t(['202612', '202701', '202702', '202703'],
  months(homeAway._plan(Date.UTC(2026, 11, 31, 12, 0, 0)).filter(j => j.board === 'soccer/all')),
  'new-year horizon crosses months correctly');

console.log('--- one event, many keys, one record');
const CREST = 'https://a.espncdn.com/i/teamlogos/soccer/500';
const ARSENAL_CHELSEA = {
  date: '2026-09-20T17:00:00Z',
  uid: 's:600~l:700~e:401671789',
  __boardLogo: 'https://a.espncdn.com/i/leaguelogos/soccer/500/eng.1.png',
  competitions: [{
    venue: { fullName: 'Emirates Stadium' },
    status: { type: { state: 'pre' } },
    broadcasts: [{ names: ['Sky Sports', 'Sky Sports'] }],
    geoBroadcasts: [{ media: { shortName: 'TNT Sports' } }],
    competitors: [
      { homeAway: 'home', team: { displayName: 'Arsenal', shortDisplayName: 'Arsenal', abbreviation: 'ARS', logo: `${CREST}/scoreboard/359.png` } },
      { homeAway: 'away', team: { displayName: 'Chelsea', shortDisplayName: 'Chelsea', abbreviation: 'CHE', logo: `${CREST}/scoreboard/363.png` } }
    ]
  }]
};
const CITY_LIVERPOOL = {
  date: '2026-09-20T20:00:00Z',
  uid: 's:600~l:700~e:401671790',
  competitions: [{
    venue: { fullName: 'Etihad Stadium' },
    status: { type: { state: 'in' } },
    broadcasts: [{ names: ['BBC One', 'BBC Two', 'ITV1', 'Sky Sports'] }],
    competitors: [
      { homeAway: 'home', team: { displayName: 'Manchester City', shortDisplayName: 'Man City', abbreviation: 'MCI' } },
      { homeAway: 'away', team: { displayName: 'Liverpool', shortDisplayName: 'Liverpool', abbreviation: 'LIV' } }
    ]
  }]
};

const seeded = homeAway._seed([ARSENAL_CHELSEA, CITY_LIVERPOOL], 'soccer/all');
t(2, seeded.events, 'two events are two records');
t(true, seeded.keys > 10, 'name and crest variants create multiple lookup keys');

homeAway._persist();
const saved = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
t(2, saved.v, 'persisted index has the current shape version');
t(2, saved.events.length, 'events are stored once');
t(seeded.keys, saved.keys.length, 'keys point into shared records');

console.log('--- home/away and fixture details');
const KICK = Date.parse(ARSENAL_CHELSEA.date);
const ARS = `${CREST}/359.png`;
const CHE = `${CREST}/363.png`;
const sides = o => o && { away: o.away, home: o.home };
t({ away: 'Chelsea', home: 'Arsenal' }, sides(homeAway.orient('Chelsea', 'Arsenal', CHE, ARS, 'football', KICK)), 'football crest pair orients correctly');
t({ away: 'Chelsea', home: 'Arsenal' }, sides(homeAway.orient('Arsenal', 'Chelsea', ARS, CHE, 'football', KICK)), 'orientation is independent of caller order');
t(null, homeAway.orient('Arsenal', 'Chelsea', ARS, CHE, 'american_football', KICK), 'removed American Football has no scoreboard board');
t(null, homeAway.orient('Arsenal', 'Chelsea', ARS, CHE, 'football', null), 'undated fixture is refused');

const d = homeAway.details('Chelsea', 'Arsenal', CHE, ARS, 'football', KICK);
t(['Sky Sports', 'TNT Sports'], d.net, 'networks are deduplicated');
t('Emirates Stadium', d.venue, 'venue is retained');
t('pre', d.status, 'status is retained');
t(KICK, d.start, 'ESPN kickoff is retained');

homeAway._seed([ARSENAL_CHELSEA], 'soccer/all');
homeAway._persist();
homeAway._seed([], 'soccer/all');
homeAway._restore();
t({ away: 'Chelsea', home: 'Arsenal' }, sides(homeAway.orient('Chelsea', 'Arsenal', CHE, ARS, 'football', KICK)), 'persisted Lite index restores correctly');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
