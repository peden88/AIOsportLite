/**
 * manifest.js — AIOPlay Stremio / Nuvio compatibility manifest.
 *
 * Live-event catalogs intentionally retain Football, Racing, MMA and Rugby.
 * 24/7 television is split into focused catalogs; removed categories are not
 * published.
 */

const { addonBuilder } = require('stremio-addon-sdk');

const manifest = {
  id: 'community.aiosportlite',
  version: '1.6.0-lite.1',
  name: 'AIOPlay',
  description:
    'Self-hosted AIOPlay gateway for live events and curated television, with first-party Movies and Series ' +
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

    { type: 'tv', id: 'nuvio_sports_channel_entertainment', name: '🎭 Entertainment', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_channel_movies', name: '🎬 Movies', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_channel_documentary', name: '📚 Documentaries', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_channel_kids', name: '🧒 Kids', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_channel_sport_uk', name: '🇬🇧 Sport UK', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_channel_sport_us', name: '🇺🇸 Sport United States', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_channel_sport_international', name: '🌍 Sport International', extra: [{ name: 'search', isRequired: false }] },

    { type: 'tv', id: 'nuvio_sports_upcoming', name: '⏱️ Upcoming', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_teams', name: '⭐ Your Teams', extra: [{ name: 'search', isRequired: false }] }
  ],

  config: [
    { key: 'teams', title: 'Favorite Teams (comma separated)', type: 'text' },
    { key: 'sports', title: 'Enabled Sports (comma separated)', type: 'text', default: 'all' },
    { key: 'timezone', title: 'Timezone', type: 'text', default: 'UTC' },
    { key: 'timeFormat', title: 'Clock format (12 or 24)', type: 'text', default: '12' }
  ],

  idPrefixes: ['nuvio_sport_'],

  behaviorHints: {
    adult: false,
    p2p: false,
    configurable: true
  },
};

const builder = new addonBuilder(manifest);
const SEARCH_TWIN_SUFFIX = '__search';

module.exports = { builder, manifest, SEARCH_TWIN_SUFFIX };
