'use strict';

/**
 * AIOSport Lite sport policy.
 *
 * Keep this list deliberately small. Providers may still return mixed-sport
 * payloads, but only these event categories are allowed to enter the Lite
 * catalog. 24/7 channels are retained independently as `networks`.
 */
const RETAINED_EVENT_CATEGORIES = Object.freeze([
  'football',
  'motorsport',
  'mma',
  'rugby'
]);

const RETAINED_EVENT_SET = new Set(RETAINED_EVENT_CATEGORIES);

function isRetainedEventCategory(category) {
  return RETAINED_EVENT_SET.has(String(category || '').toLowerCase());
}

function kickoffMs(match) {
  if (!match) return 0;
  const raw = match.date != null && match.date !== '' ? match.date : match.timestamp;
  if (raw == null || raw === '') return 0;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isChannelLike(match) {
  return !!match && (match.category === 'networks' || kickoffMs(match) <= 0);
}

function shouldKeepMatch(match) {
  return isChannelLike(match) || isRetainedEventCategory(match && match.category);
}

module.exports = {
  RETAINED_EVENT_CATEGORIES,
  isRetainedEventCategory,
  kickoffMs,
  isChannelLike,
  shouldKeepMatch
};
