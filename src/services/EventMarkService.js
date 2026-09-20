'use strict';

/**
 * EventMarkService.js
 *
 * Picks the badge for an event that isn't team-vs-team: a race, a fight card, a
 * tournament round. Those resolve no crests, so the card fell back to the title
 * in plain text — only 15 of 778 events, but they are the ugliest 15.
 *
 * A series mark is preferred over a sport icon, and a sport icon over nothing.
 * Every URL here was fetched and confirmed to return a real image; a mark that
 * 404s later costs the card its badge and nothing else, because the route falls
 * back to the plain card when no candidate loads.
 */

const ESPN = 'https://a.espncdn.com';

// Series marks, matched against the event title. Ordered: the first hit wins,
// so more specific patterns come first ("moto2" before a generic "motogp").
const SERIES = [
  { re: /\bformula\s*1\b|\bf1\b|grand prix\b/i, kicker: 'FORMULA 1', mark: `${ESPN}/i/teamlogos/leagues/500/f1.png` },
  { re: /\bmoto\s*gp\b|\bmoto[23]\b/i, kicker: 'MOTOGP', mark: `${ESPN}/redesign/assets/img/icons/ESPN-icon-motogp.png` },
  { re: /\bnascar\b|truck series|cup series|xfinity/i, kicker: 'NASCAR', mark: `${ESPN}/i/espn/misc_logos/500/nascar.png` },
  { re: /\bnhra\b|drag racing/i, kicker: 'NHRA', mark: `${ESPN}/i/espn/misc_logos/500/nhra.png` },
  { re: /\bufc\b|dana white/i, kicker: 'UFC', mark: `${ESPN}/i/teamlogos/leagues/500/ufc.png` },
  { re: /\bpfl\b/i, kicker: 'PFL', mark: `${ESPN}/i/teamlogos/leagues/500/pfl.png` },
  { re: /\bwwe\b|smackdown|monday night raw/i, kicker: 'WWE', mark: `${ESPN}/i/teamlogos/leagues/500/wwe.png` },
  { re: /\baew\b|all elite/i, kicker: 'AEW', mark: `${ESPN}/i/teamlogos/leagues/500/aew.png` },
];

// Whatever the sport is, when no series matched. No kicker goes with these: the
// card must not label an event with a series it only guessed at.
const SPORT_ICONS = {
  mma: `${ESPN}/i/espn/misc_logos/500/boxing.png`,
  motorsport: `${ESPN}/redesign/assets/img/icons/ESPN-icon-nascar.png`,
  rugby: `${ESPN}/redesign/assets/img/icons/ESPN-icon-rugby.png`,
  football: `${ESPN}/redesign/assets/img/icons/ESPN-icon-soccer.png`,
};

/**
 * { mark, mark2, kicker } for an event, or null when there is nothing to show.
 *
 * mark2 is the sport icon behind a series mark, so a series logo that fails to
 * load still leaves the card a badge rather than dropping to bare text.
 */
function markFor(title, category, league) {
  const haystack = `${title || ''} ${league || ''}`;
  const sport = SPORT_ICONS[category] || null;

  for (const s of SERIES) {
    if (s.re.test(haystack)) {
      return { mark: s.mark, mark2: sport, kicker: s.kicker };
    }
  }
  return sport ? { mark: sport, mark2: null, kicker: null } : null;
}

module.exports = { markFor, SERIES, SPORT_ICONS };
