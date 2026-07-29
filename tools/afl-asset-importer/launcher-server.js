#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4317;
const clients = new Set();
let running = false;
let lastStatus = 'Ready';

function sendEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

function log(line) {
  const text = String(line).replace(/\r/g, '');
  process.stdout.write(text);
  sendEvent('log', { text });
}

function runCommand(command, args, label) {
  return new Promise((resolve, reject) => {
    lastStatus = label;
    sendEvent('status', { running: true, text: label });
    const child = spawn(command, args, { cwd: HERE, shell: process.platform === 'win32' });
    child.stdout.on('data', d => log(d));
    child.stderr.on('data', d => log(d));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${label} failed with exit code ${code}`)));
  });
}

async function runImport(options) {
  if (running) throw new Error('An import is already running.');
  running = true;
  try {
    log('\n=== AFL Asset Importer ===\n');
    if (!fs.existsSync(path.join(HERE, 'node_modules'))) {
      await runCommand('npm', ['install'], 'Installing importer components…');
    }
    const marker = path.join(HERE, '.chromium-installed');
    if (!fs.existsSync(marker)) {
      await runCommand('npx', ['playwright', 'install', 'chromium'], 'Installing browser engine…');
      fs.writeFileSync(marker, new Date().toISOString());
    }
    const args = ['import-assets.js'];
    args.push(options.mode === 'players' ? '--players' : options.mode === 'logos' ? '--logos' : '--all');
    if (options.club && options.club !== 'ALL') args.push(`--club=${options.club}`);
    if (options.force) args.push('--force');
    if (options.headed) args.push('--headed');
    if (options.dryRun) args.push('--dry-run');
    await runCommand('node', args, 'Downloading and converting assets…');
    lastStatus = 'Import complete';
    sendEvent('done', { ok: true, text: 'Import complete. Files are in the game assets folder.' });
  } catch (error) {
    lastStatus = 'Import failed';
    log(`\nERROR: ${error.message}\n`);
    sendEvent('done', { ok: false, text: error.message });
  } finally {
    running = false;
    sendEvent('status', { running: false, text: lastStatus });
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(path.join(HERE, 'importer-ui.html')));
    return;
  }
  if (req.url === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*'
    });
    res.write(`event: status\ndata: ${JSON.stringify({ running, text: lastStatus })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.url === '/api/run' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const options = JSON.parse(body || '{}');
        if (running) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Importer is already running.' }));
          return;
        }
        runImport(options);
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
    return;
  }
  if (req.url === '/api/open-assets' && req.method === 'POST') {
    const assetPath = path.resolve(HERE, '../../assets');
    const command = process.platform === 'win32' ? `explorer "${assetPath}"` : process.platform === 'darwin' ? `open "${assetPath}"` : `xdg-open "${assetPath}"`;
    exec(command);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`AFL Asset Importer UI: http://127.0.0.1:${PORT}`);
  const url = `http://127.0.0.1:${PORT}`;
  const command = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(command);
});
