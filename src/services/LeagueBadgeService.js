/**
 * Which competition a fixture belongs to, worked out from the crests rather
 * than from what a feed called it.
 *
 * Most feeds name no league at all — every rugby fixture arrives with an empty
 * league field, and ESPN's scoreboard only covers a fraction of the soccer
 * calendar — but the crests always know. Leicester Tigers resolve out of the
 * Premiership table, the Rabbitohs out of the NRL, and a club side out of its
 * own division. The competition two crests share is the fixture's competition.
 *
 * This is the fallback path. When ESPN's scoreboard names the competition for a
 * specific fixture that is better evidence and wins, because two clubs sharing a
 * league table says nothing about which of their several competitions they are
 * meeting in today.
 */

const { BASE_URL } = require('../config');

const INDEX = require('./data/espn-crest-competitions.json');
const CRESTS = INDEX.crests || {};
const COMPETITIONS = INDEX.competitions || {};

/**
 * Reduce a crest URL to the key the index is built on. Must stay in step with
 * crestKey() in scripts/build-espn-teams.js.
 */
function crestKey(url) {
  const s = String(url || '');
  const m = /\/teamlogos\/([^/]+)\/(?:teams\/)?\d+(?:\/scoreboard)?\/([^/?#]+?)\.(?:png|svg|jpg)/i.exec(s);
  if (m) return `${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
  const other = /\/([^/?#]+)\.(?:png|svg|jpg)(?:[?#]|$)/i.exec(s);
  return other ? other[1].toLowerCase() : '';
}

/**
 * Competitions the two sides could be meeting in, most likely first.
 *
 * Two Premier League clubs share their league and three cups. Without the
 * fixture itself to go on the league is the better guess: they play each other
 * there every season and in a given cup almost never.
 */
function rankOf(slug) {
  if (/^(fifa\.|club\.friendly)/.test(slug)) return 3;
  if (/^(uefa|conmebol|concacaf|caf|afc)\./.test(slug)) return 2;
  // Club rugby outranks the cups and the international game, the same way a
  // domestic league outranks a continental cup in soccer.
  if (/^rugby-(champions|challenge|six-nations|championship|international|test|nations|lions|tri-nations|wwc)$/.test(slug)) return 2;
  return 1;
}

/**
 * The competition both crests belong to, or null when they share none.
 */
function competitionFor(aLogo, bLogo) {
  const a = CRESTS[crestKey(aLogo)];
  const b = CRESTS[crestKey(bLogo)];

  // One side unknown. An opponent with no crest at all is not evidence of a
  // different competition, so a side that plays in exactly one is still an
  // answer: a Serie B club against an opponent ESPN has never listed is playing
  // Serie B. A side that plays in several is not -- which of them this fixture
  // is would be a guess.
  if (!a || !b) {
    const known = a || b;
    return known && known.length === 1 ? known[0] : null;
  }

  let best = null;
  let bestRank = Infinity;
  for (const slug of a) {
    if (!b.includes(slug)) continue;
    const r = rankOf(slug);
    if (r < bestRank) { best = slug; bestRank = r; }
  }
  return best;
}

/**
 * Competitions whose own mark this addon serves, because ESPN publishes none
 * worth showing. Every rugby competition's ESPN "crest" is the same generic
 * ball pictogram.
 */
const BUNDLED = {
  'rugby-league': 'rugby-league.png',
  'rugby-prem': 'rugby-prem.png',
  'rugby-top14': 'rugby-top14.png',
  'rugby-champions': 'rugby-champions.png',
  'rugby-urc': 'rugby-urc.png',
  'rugby-six-nations': 'rugby-six-nations.png',
  'rugby-super': 'rugby-super.png',
  // The three defunct Super Rugby formats still carry the competition's mark.
  'rugby-super-aotearoa': 'rugby-super.png',
  'rugby-super-au': 'rugby-super.png',
  'rugby-super-tt': 'rugby-super.png',
  // Test rugby under one governing mark: World Rugby runs the World Cup, and a
  // Fiji-Canada test belongs to no competition narrower than that.
  'rugby-international': 'rugby-international.png',
  'rugby-test': 'rugby-international.png',
  'rugby-nations': 'rugby-international.png',
  'rugby-championship': 'rugby-international.png',
  'rugby-lions': 'rugby-international.png',
  'rugby-tri-nations': 'rugby-international.png',
  'rugby-wwc': 'rugby-international.png'

};

/**
 * A sport's own mark, for an event whose competition could not be named. Most
 * come from the icon set the card marks already use, so a motorsport or MMA
 * event -- which has no competition and no two crests to work one out from --
 * gets its sport in the corner rather than nothing.
 */
const SPORT_MARK = {
  ...require('./EventMarkService').SPORT_ICONS,
  football: `${BASE_URL}/marks/soccer.png`
};

/**
 * ESPN answers some competitions with a sport pictogram rather than a badge —
 * the same rugby ball for all four rugby competitions. That is the fallback
 * this module exists to improve on, so it is not accepted as a league crest.
 */
function isRealCrest(url) {
  return !!url && !/\/icons\/ESPN-icon-/i.test(url);
}

/**
 * The badge for a competition: this addon's own mark where there is one, else
 * ESPN's crest, else nothing.
 */
function badgeForCompetition(slug) {
  if (!slug) return null;
  if (BUNDLED[slug]) return `${BASE_URL}/marks/${BUNDLED[slug]}`;
  const crest = COMPETITIONS[slug];
  return isRealCrest(crest) ? crest : null;
}

/** The mark for a sport, when the competition is unknown. */
function sportMark(category) {
  return SPORT_MARK[category] || null;
}

module.exports = {
  competitionFor,
  badgeForCompetition,
  sportMark,
  crestKey,
  BUNDLED,
  SPORT_MARK
};
