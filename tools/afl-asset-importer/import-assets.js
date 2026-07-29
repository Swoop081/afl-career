#!/usr/bin/env node
import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '../..');
const DATA_FILE = path.join(PROJECT, 'data.js');
const PLAYER_DIR = path.join(PROJECT, 'assets/players');
const LOGO_DIR = path.join(PROJECT, 'assets/team-logos');
const REPORT_FILE = path.join(HERE, 'asset-import-report.json');
const MAP_FILE = path.join(PROJECT, 'asset-map.js');
const OVERRIDES_FILE = path.join(HERE, 'overrides.json');

const CLUBS = {
  ADE: { name: 'Adelaide Crows', slugs: ['adelaide-crows', 'adelaide'] },
  BRI: { name: 'Brisbane Lions', slugs: ['brisbane-lions', 'brisbane'] },
  CAR: { name: 'Carlton', slugs: ['carlton'] },
  COL: { name: 'Collingwood', slugs: ['collingwood'] },
  ESS: { name: 'Essendon', slugs: ['essendon'] },
  FRE: { name: 'Fremantle', slugs: ['fremantle'] },
  GEE: { name: 'Geelong Cats', slugs: ['geelong-cats', 'geelong'] },
  GCS: { name: 'Gold Coast Suns', slugs: ['gold-coast-suns', 'gold-coast'] },
  GWS: { name: 'GWS Giants', slugs: ['gws-giants', 'greater-western-sydney', 'gws'] },
  HAW: { name: 'Hawthorn', slugs: ['hawthorn'] },
  MEL: { name: 'Melbourne', slugs: ['melbourne'] },
  NTH: { name: 'North Melbourne', slugs: ['north-melbourne'] },
  PTA: { name: 'Port Adelaide', slugs: ['port-adelaide'] },
  RIC: { name: 'Richmond', slugs: ['richmond'] },
  STK: { name: 'St Kilda', slugs: ['st-kilda'] },
  SYD: { name: 'Sydney Swans', slugs: ['sydney-swans', 'sydney'] },
  WCE: { name: 'West Coast Eagles', slugs: ['west-coast-eagles', 'west-coast'] },
  WBD: { name: 'Western Bulldogs', slugs: ['western-bulldogs'] }
};

const args = new Set(process.argv.slice(2));
const importPlayers = args.has('--players') || args.has('--all') || (!args.has('--logos'));
const importLogos = args.has('--logos') || args.has('--all');
const dryRun = args.has('--dry-run');
const force = args.has('--force');
const headed = args.has('--headed');
const clubFilterArg = process.argv.find(v => v.startsWith('--club='));
const clubFilter = clubFilterArg ? clubFilterArg.split('=')[1].toUpperCase() : null;

function slugify(value) {
  return value.normalize('NFKD').replace(/[’']/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function absoluteUrl(url, base = 'https://www.afl.com.au') {
  try { return new URL(url, base).href; } catch { return null; }
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

async function readPlayers() {
  const source = await fs.readFile(DATA_FILE, 'utf8');
  const match = source.match(/const REAL_PLAYERS\s*=\s*(\[[\s\S]*?\]);\s*const POSITIONS/);
  if (!match) throw new Error('Could not locate REAL_PLAYERS in data.js');
  return vm.runInNewContext(match[1], Object.create(null));
}

async function fetchBuffer(url, referer = 'https://www.afl.com.au/') {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      'referer': referer,
      'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function saveWebp(url, destination, options) {
  if (dryRun) return;
  const bytes = await fetchBuffer(url);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await sharp(bytes, { density: 300 })
    .resize(options)
    .webp({ quality: 86, alphaQuality: 95, effort: 5 })
    .toFile(destination);
}

async function discoverPlayerLinks(page) {
  const cache = new Map();
  const pages = [
    'https://www.afl.com.au/stats/players',
    ...Object.values(CLUBS).flatMap(c => c.slugs.map(s => `https://www.afl.com.au/clubs/${s}/players`))
  ];
  for (const url of pages) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 1600); await sleep(350); }
      const links = await page.locator('a[href*="/players/"]').evaluateAll(nodes => nodes.map(a => ({ href: a.href, text: (a.textContent || '').trim() })));
      for (const item of links) {
        const m = item.href.match(/\/players\/\d+\/([^/?#]+)/);
        if (!m) continue;
        const key = slugify(item.text || m[1]);
        cache.set(key, item.href.split('?')[0]);
        cache.set(slugify(m[1]), item.href.split('?')[0]);
      }
    } catch (error) {
      console.warn(`Discovery skipped ${url}: ${error.message}`);
    }
  }
  return cache;
}

async function searchProfile(page, player, linkCache) {
  const override = overrides.players?.[player.name];
  if (override?.profileUrl) return override.profileUrl;
  const target = slugify(player.name);
  if (linkCache.has(target)) return linkCache.get(target);
  for (const [key, url] of linkCache) {
    if (key.includes(target) || target.includes(key)) return url;
  }
  const query = encodeURIComponent(`site:afl.com.au/players/ "${player.name}" AFL`);
  try {
    await page.goto(`https://www.google.com/search?q=${query}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const hrefs = await page.locator('a[href]').evaluateAll(nodes => nodes.map(a => a.href));
    return hrefs.find(href => /afl\.com\.au\/players\/\d+\//.test(href))?.split('&')[0] || null;
  } catch { return null; }
}

async function pickPortrait(page, player) {
  await page.waitForTimeout(1000);
  const candidates = await page.locator('img').evaluateAll((imgs, playerName) => imgs.map(img => ({
    src: img.currentSrc || img.src || '',
    srcset: img.getAttribute('srcset') || '',
    alt: img.alt || '',
    width: img.naturalWidth || img.width || 0,
    height: img.naturalHeight || img.height || 0,
    cls: img.className || ''
  })).filter(x => x.src), player.name);
  const nameWords = slugify(player.name).split('-');
  function largestSrc(c) {
    const set = c.srcset.split(',').map(v => v.trim().split(/\s+/)).map(([url, size]) => ({ url, size: parseInt(size) || 0 })).sort((a,b) => b.size-a.size);
    return set[0]?.url || c.src;
  }
  const scored = candidates.map(c => {
    const hay = `${c.src} ${c.alt} ${c.cls}`.toLowerCase();
    let score = 0;
    if (nameWords.every(w => hay.includes(w))) score += 100;
    if (/player|headshot|portrait|profile/.test(hay)) score += 40;
    if (/hero|card/.test(hay)) score += 12;
    if (/logo|icon|sponsor|ticket|banner/.test(hay)) score -= 80;
    if (c.height >= c.width) score += 15;
    score += Math.min(30, Math.sqrt(c.width * c.height) / 100);
    return { ...c, url: absoluteUrl(largestSrc(c), page.url()), score };
  }).filter(c => c.url && !c.url.startsWith('data:')).sort((a,b) => b.score-a.score);
  return scored[0] || null;
}

async function pickLogo(page, club) {
  await page.waitForTimeout(700);
  const candidates = await page.locator('img, source').evaluateAll(nodes => nodes.map(n => ({
    src: n.currentSrc || n.src || n.getAttribute('src') || '',
    srcset: n.getAttribute('srcset') || '',
    alt: n.alt || '',
    width: n.naturalWidth || n.width || 0,
    height: n.naturalHeight || n.height || 0,
    cls: n.className || ''
  })).filter(x => x.src || x.srcset));
  const words = slugify(club.name).split('-').filter(w => w.length > 2);
  return candidates.map(c => {
    const raw = c.srcset ? c.srcset.split(',').pop().trim().split(/\s+/)[0] : c.src;
    const url = absoluteUrl(raw, page.url());
    const hay = `${url} ${c.alt} ${c.cls}`.toLowerCase();
    let score = words.reduce((n,w) => n + (hay.includes(w) ? 20 : 0), 0);
    if (/logo|crest|club/.test(hay)) score += 60;
    if (/sponsor|afl-logo|competition/.test(hay)) score -= 60;
    if (Math.abs(c.width-c.height) < Math.max(c.width,c.height)*0.45) score += 10;
    return { url, score };
  }).filter(x => x.url && !x.url.startsWith('data:')).sort((a,b) => b.score-a.score)[0] || null;
}

async function main() {
  const players = (await readPlayers()).filter(p => !clubFilter || p.club === clubFilter);
  const overridesRaw = await fs.readFile(OVERRIDES_FILE, 'utf8').catch(() => '{}');
  globalThis.overrides = JSON.parse(overridesRaw);
  await fs.mkdir(PLAYER_DIR, { recursive: true });
  await fs.mkdir(LOGO_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-AU' });
  const page = await context.newPage();
  const report = { startedAt: new Date().toISOString(), dryRun, players: [], logos: [] };
  const playerMap = {};
  const logoMap = {};

  let linkCache = new Map();
  if (importPlayers) {
    console.log('Discovering AFL player profile links…');
    linkCache = await discoverPlayerLinks(page);
    console.log(`Discovered ${new Set(linkCache.values()).size} profile URLs.`);
    for (let index = 0; index < players.length; index++) {
      const player = players[index];
      const slug = slugify(player.name);
      const relative = `assets/players/${player.club}/${slug}.webp`;
      const destination = path.join(PROJECT, relative);
      playerMap[`${player.club}:${player.name}`] = relative;
      if (!force && await exists(destination)) {
        report.players.push({ name: player.name, club: player.club, status: 'skipped-existing', file: relative });
        continue;
      }
      process.stdout.write(`[${index+1}/${players.length}] ${player.name}… `);
      try {
        const profileUrl = await searchProfile(page, player, linkCache);
        if (!profileUrl) throw new Error('profile not found');
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        const portrait = await pickPortrait(page, player);
        if (!portrait || portrait.score < 20) throw new Error('portrait not confidently identified');
        await saveWebp(portrait.url, destination, { width: 640, height: 800, fit: 'contain', withoutEnlargement: true, background: { r:0,g:0,b:0,alpha:0 } });
        report.players.push({ name: player.name, club: player.club, status: dryRun ? 'dry-run' : 'saved', profileUrl, sourceUrl: portrait.url, file: relative });
        console.log(dryRun ? 'found' : 'saved');
      } catch (error) {
        report.players.push({ name: player.name, club: player.club, status: 'failed', error: error.message });
        console.log(`FAILED (${error.message})`);
      }
      await sleep(700);
    }
  }

  if (importLogos) {
    const clubs = Object.entries(CLUBS).filter(([code]) => !clubFilter || code === clubFilter);
    for (const [code, club] of clubs) {
      const relative = `assets/team-logos/${code.toLowerCase()}.webp`;
      const destination = path.join(PROJECT, relative);
      logoMap[code] = relative;
      if (!force && await exists(destination)) {
        report.logos.push({ club: code, status: 'skipped-existing', file: relative });
        continue;
      }
      process.stdout.write(`Logo ${club.name}… `);
      try {
        const override = overrides.logos?.[code];
        let sourceUrl = override?.imageUrl || null;
        let pageUrl = override?.pageUrl || `https://www.afl.com.au/clubs/${club.slugs[0]}`;
        if (!sourceUrl) {
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          const logo = await pickLogo(page, club);
          if (!logo || logo.score < 20) throw new Error('logo not confidently identified');
          sourceUrl = logo.url;
        }
        await saveWebp(sourceUrl, destination, { width: 512, height: 512, fit: 'contain', withoutEnlargement: true, background: { r:0,g:0,b:0,alpha:0 } });
        report.logos.push({ club: code, status: dryRun ? 'dry-run' : 'saved', sourceUrl, file: relative });
        console.log(dryRun ? 'found' : 'saved');
      } catch (error) {
        report.logos.push({ club: code, status: 'failed', error: error.message });
        console.log(`FAILED (${error.message})`);
      }
      await sleep(700);
    }
  }

  await browser.close();
  report.finishedAt = new Date().toISOString();
  report.summary = {
    playersSaved: report.players.filter(x => ['saved','dry-run','skipped-existing'].includes(x.status)).length,
    playersFailed: report.players.filter(x => x.status === 'failed').length,
    logosSaved: report.logos.filter(x => ['saved','dry-run','skipped-existing'].includes(x.status)).length,
    logosFailed: report.logos.filter(x => x.status === 'failed').length
  };
  await fs.writeFile(REPORT_FILE, JSON.stringify(report, null, 2));
  const mapJs = `// Generated by tools/afl-asset-importer/import-assets.js\nconst AFL_PLAYER_PHOTOS=${JSON.stringify(playerMap,null,2)};\nconst AFL_TEAM_LOGOS=${JSON.stringify(logoMap,null,2)};\n`;
  await fs.writeFile(MAP_FILE, mapJs);
  console.log(`\nReport: ${path.relative(PROJECT, REPORT_FILE)}`);
  console.log(`Asset map: ${path.relative(PROJECT, MAP_FILE)}`);
  console.log(report.summary);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
