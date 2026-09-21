/**
 * manifest.js — AIOPlay Stremio / Nuvio compatibility manifest.
 *
 * Event catalogs are intentionally limited to Football, Rugby, Racing and MMA.
 * The separate Channels catalog remains available for 24/7 television feeds.
 */

const { addonBuilder } = require('stremio-addon-sdk');
const { GENRES } = require('./channelGenres');

const manifest = {
  // Its own id, not upstream's. Sharing 'community.nuvio.live-sports' made the
  // two addons look like one to anything that keys installed addons by id.
  id: 'community.aiosportlite',
  version: '1.6.0-lite.1',
  name: 'AIOPlay',
  description:
    'Self-hosted AIOPlay gateway for live events and 24/7 channels, with first-party Movies and Series ' +
    'support through configured services.',
  logo: '/aioplay-brand.webp',

  types: ['tv'],
  resources: ['catalog', 'meta', 'stream'],

  catalogs: [
    { type: 'tv', id: 'nuvio_sports_live', name: '🔴 Live Now', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_football', name: '⚽ Football', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_motorsport', name: '🏎️ Racing', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_mma', name: '🥊 MMA', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_rugby', name: '🏉 Rugby', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_channels', name: '📺 Channels', extra: [{ name: 'genre', options: GENRES, isRequired: false }, { name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_upcoming', name: '⏱️ Upcoming', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_teams', name: '⭐ Your Teams', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_local', name: '📍 Local', extra: [{ name: 'search', isRequired: false }] }
  ],

  config: [
    { key: 'teams', title: 'Favorite Teams (comma separated)', type: 'text' },
    { key: 'markets', title: 'Local channels: your cities (comma separated)', type: 'text' },
    { key: 'sports', title: 'Enabled Sports (comma separated)', type: 'text', default: 'all' },
    {
      key: 'timezone',
      title: 'Timezone',
      type: 'text',
      default: 'UTC'
    },
    {
      key: 'timeFormat',
      title: 'Clock format (12 or 24)',
      type: 'text',
      default: '12'
    }
  ],

  idPrefixes: ['nuvio_sport_'],

  behaviorHints: {
    adult: false,
    p2p: false,
    configurable: true
  },
};

const builder = new addonBuilder(manifest);

// A tab kept off the home board is published twice, and the second copy wears
// this suffix. Both ids mean the same category; see the manifest route in
// index.js for why one catalog cannot cover all three surfaces at once.
const SEARCH_TWIN_SUFFIX = '__search';

module.exports = { builder, manifest, SEARCH_TWIN_SUFFIX };
