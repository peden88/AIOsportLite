'use strict';

const assert = require('assert');
const { manifest } = require('../src/manifest');
const {
  RETAINED_EVENT_CATEGORIES,
  isRetainedEventCategory,
  shouldKeepMatch
} = require('../src/sportsPolicy');

const catalogIds = manifest.catalogs.map(c => c.id);
const expected = [
  'nuvio_sports_live',
  'nuvio_sports_football',
  'nuvio_sports_motorsport',
  'nuvio_sports_mma',
  'nuvio_sports_rugby',
  'nuvio_sports_channel_entertainment',
  'nuvio_sports_channel_movies',
  'nuvio_sports_channel_documentary',
  'nuvio_sports_channel_kids',
  'nuvio_sports_channel_sport_uk',
  'nuvio_sports_channel_sport_us',
  'nuvio_sports_channel_sport_international',
  'nuvio_sports_upcoming',
  'nuvio_sports_teams'
];

assert.deepStrictEqual(catalogIds, expected);
assert.deepStrictEqual(RETAINED_EVENT_CATEGORIES, ['football', 'motorsport', 'mma', 'rugby']);
for (const sport of RETAINED_EVENT_CATEGORIES) assert.strictEqual(isRetainedEventCategory(sport), true);
for (const removed of ['basketball', 'baseball', 'hockey', 'american_football', 'cricket', 'college', 'golf', 'tennis', 'darts', 'other']) {
  assert.strictEqual(isRetainedEventCategory(removed), false, removed);
}
assert.strictEqual(shouldKeepMatch({ category: 'football', date: Date.now() }), true);
assert.strictEqual(shouldKeepMatch({ category: 'basketball', date: Date.now() }), false);
assert.strictEqual(shouldKeepMatch({ category: 'networks', date: 0 }), true);

console.log('AIOSport Lite sport policy OK');
