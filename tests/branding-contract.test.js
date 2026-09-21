'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(condition, label) {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? 'PASS' : '*** FAIL'}  ${label}`);
}

const root = path.join(__dirname, '..');
const pages = [
  'public/index.html',
  'public/login.html',
  'public/users.html',
  'public/services.html',
  'public/dashboard.html',
  'public/configure.html'
];

console.log('--- AIOPlay branding contract');
t(fs.existsSync(path.join(root, 'public', 'aioplay-brand.webp')), 'approved in-app/web brand artwork exists');
t(fs.existsSync(path.join(root, 'public', 'aioplay-launcher.webp')), 'approved TV launcher/banner artwork exists');

for (const rel of pages) {
  const html = fs.readFileSync(path.join(root, rel), 'utf8');
  t(html.includes('AIOPlay'), rel + ' identifies the first-party product as AIOPlay');
  t(html.includes('/aioplay-brand.webp'), rel + ' uses the approved AIOPlay brand artwork');
  t(!html.includes('/brand/aioplay-mark.svg'), rel + ' no longer uses the interim SVG placeholder');
  t(!html.includes('AIOSport Lite'), rel + ' contains no visible AIOSport Lite product name');
  t(!html.includes('<title>AIOSports'), rel + ' contains no legacy AIOSports page title');
  t(!html.includes('>AIOSports<'), rel + ' contains no legacy AIOSports display label');
  t(!html.includes('Support AIOSports'), rel + ' contains no legacy AIOSports support label');
}

const manifest = require('../src/manifest').manifest;
t(manifest.name === 'AIOPlay', 'compatibility manifest uses AIOPlay as its visible name');
t(manifest.logo === '/aioplay-brand.webp', 'compatibility manifest uses approved AIOPlay artwork');
t(manifest.id === 'community.aiosportlite', 'technical addon id remains stable for compatibility');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
