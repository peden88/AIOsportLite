'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aioplay-progress-'));
const progress = require('../src/services/AioPlayProgress');

let pass = 0, fail = 0;
function t(condition, label) {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? 'PASS' : '*** FAIL'}  ${label}`);
}

function movie(overrides = {}) {
  return {
    contentId: 'tt-movie-1',
    contentType: 'movie',
    name: 'Movie One',
    videoId: 'tt-movie-1',
    position: 30_000,
    duration: 100_000,
    lastWatched: 1000,
    progressPercent: 30,
    ...overrides
  };
}

function episode(overrides = {}) {
  return {
    contentId: 'tt-show-1',
    contentType: 'series',
    name: 'Show One',
    videoId: 'tt-show-1:1:2',
    season: 1,
    episode: 2,
    episodeTitle: 'Episode Two',
    position: 50_000,
    duration: 100_000,
    lastWatched: 2000,
    progressPercent: 50,
    ...overrides
  };
}

console.log('--- per-user progress store');
let result = progress.upsert('user-a', [movie(), episode()]);
t(result.accepted === 2, 'valid movie and episode progress are stored');
t(progress.list('user-a').length === 2, 'stored rows are returned to the same user');
t(progress.list('user-b').length === 0, 'progress is isolated between users');

console.log('--- newest update wins');
progress.upsert('user-a', movie({ position: 10_000, lastWatched: 900, progressPercent: 10 }));
let savedMovie = progress.list('user-a').find(item => item.contentId === 'tt-movie-1');
t(savedMovie.position === 30_000, 'older device updates cannot overwrite newer progress');
progress.upsert('user-a', movie({ position: 70_000, lastWatched: 3000, progressPercent: 70 }));
savedMovie = progress.list('user-a').find(item => item.contentId === 'tt-movie-1');
t(savedMovie.position === 70_000, 'newer progress replaces the previous position');

console.log('--- Continue Watching thresholds');
progress.upsert('user-a', movie({
  contentId: 'tt-finished',
  videoId: 'tt-finished',
  name: 'Finished',
  position: 95_000,
  duration: 100_000,
  lastWatched: 4000,
  progressPercent: 95
}));
const continueRows = progress.list('user-a', { continueOnly: true });
t(continueRows.some(item => item.contentId === 'tt-movie-1'), 'in-progress movie is in Continue Watching');
t(continueRows.some(item => item.contentId === 'tt-show-1'), 'in-progress episode is in Continue Watching');
t(!continueRows.some(item => item.contentId === 'tt-finished'), 'completed item is excluded from Continue Watching');

console.log('--- persistence');
progress._resetForTests();
t(progress.list('user-a').length === 3, 'progress survives module reset and reload from disk');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
