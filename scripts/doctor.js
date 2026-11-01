#!/usr/bin/env node
// Environment self-check: verifies every prerequisite and reports what's
// missing with the exact fix. Run any time things look off.
//
//   npm run doctor

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch { /* deps not installed yet */ }
const API = process.env.JOBS_API || `http://localhost:${process.env.PORT || 3001}`;
const CDP_PORT = process.env.CDP_PORT || '9222';

let failures = 0;

function ok(msg) { console.log(`  ✅ ${msg}`); }
function warn(msg, fix) {
  console.log(`  ⚠️  ${msg}`);
  if (fix) console.log(`     fix: ${fix}`);
}
function fail(msg, fix) {
  failures++;
  console.log(`  ❌ ${msg}`);
  if (fix) console.log(`     fix: ${fix}`);
}

async function main() {
  console.log('\nRequired\n────────');

  // Node version (node:sqlite needs >= 22.5)
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 5)) ok(`Node ${process.versions.node} (need >= 22.5)`);
  else fail(`Node ${process.versions.node} is too old (need >= 22.5 for built-in node:sqlite)`, 'nvm install 22 && nvm use 22');

  // node:sqlite actually loads
  try { require('node:sqlite'); ok('node:sqlite module available'); }
  catch { fail('node:sqlite module missing', 'upgrade Node to >= 22.5'); }

  // Server deps
  if (fs.existsSync(path.join(ROOT, 'node_modules', 'express'))) ok('server dependencies installed');
  else fail('server dependencies missing', 'npm run setup   (or: npm install)');

  // Client deps
  if (fs.existsSync(path.join(ROOT, 'client', 'node_modules', 'react'))) ok('client dependencies installed');
  else fail('client dependencies missing', 'npm run setup   (or: cd client && npm install)');

  // Playwright package
  let playwrightOk = false;
  try { require.resolve('playwright'); playwrightOk = true; ok('playwright package installed'); }
  catch { fail('playwright package missing (appliers cannot run)', 'npm run setup   (or: npm install)'); }

  console.log('\nBrowser (need at least ONE of these two)\n────────────────────────────────────────');

  // Real Chrome with CDP open?
  let cdpUp = false;
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const v = await res.json();
      cdpUp = true;
      ok(`Chrome reachable on CDP :${CDP_PORT} (${v.Browser || 'unknown version'})`);
    }
  } catch { /* not running */ }
  if (!cdpUp) warn(`no Chrome listening on CDP :${CDP_PORT}`, 'see README "Browser" for the launch command (optional if the bundled Chromium below is installed)');

  // Bundled Chromium? Check it actually LAUNCHES, not just that the files
  // exist — a corrupted/incomplete download can pass the file-exists check
  // but fail at launch (seen on Windows: "side-by-side configuration is
  // incorrect" from a Chromium build missing its SxS assembly layout).
  let bundledOk = false;
  if (playwrightOk) {
    try {
      const { chromium } = require('playwright');
      const exe = chromium.executablePath();
      if (exe && fs.existsSync(exe)) {
        // headless:false on purpose — apply.js's fallback browser runs headed
        // (launchPersistentContext), and some Windows setups can launch this
        // binary headless but fail headed with a "side-by-side configuration
        // is incorrect" error. A headless-only check would miss that.
        const browser = await chromium.launch({ headless: false, timeout: 15000 });
        await browser.close();
        bundledOk = true;
        ok('Playwright bundled Chromium downloaded and launches (headed)');
      } else {
        warn('Playwright bundled Chromium not downloaded', 'npx playwright install chromium');
      }
    } catch (e) {
      const msg = e.message.split('\n')[0];
      const sxsHint = /side-by-side/i.test(e.message)
        ? ' This looks like a known Windows issue with this Chrome-for-Testing build (not your code) — real Chrome via CDP is unaffected and is the recommended option anyway (README "Browser").'
        : '';
      warn(
        `Playwright bundled Chromium downloaded but FAILED to launch headed (${msg}).${sxsHint}`,
        'try: npx playwright install chromium --force   — if that doesn\'t fix it, launch real Chrome with CDP instead (README "Browser"); the appliers prefer CDP automatically whenever it is reachable'
      );
    }
  }
  if (!cdpUp && !bundledOk) fail('NO working browser available — the appliers cannot run', 'either launch Chrome with CDP (README "Browser") or run: npx playwright install chromium --force');

  console.log('\nOllama (optional — resume/cover-letter drafting)\n─────────────────────────────────────────────────');
  try {
    const ollama = require('./lib/ollama');
    const status = await ollama.checkAvailable();
    if (status.available) ok(`Ollama reachable at ${ollama.OLLAMA_URL}, model ${ollama.OLLAMA_MODEL} ready`);
    else warn(`Ollama not ready: ${status.reason}`, `install from https://ollama.com, run "ollama serve", then "ollama pull ${ollama.OLLAMA_MODEL}"`);
  } catch (e) { warn(`could not check Ollama: ${e.message}`); }

  console.log('\nServer & profile\n────────────────');

  // Server up?
  let serverUp = false;
  try {
    const res = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2000) });
    const d = await res.json();
    // Distinguish this app from anything else squatting the port.
    if (res.ok && d.status === 'ok' && !('env' in d)) {
      serverUp = true;
      ok(`server responding at ${API}` + (d.passwordProtected ? ' (password protected)' : ''));
    } else {
      fail(`something else is listening at ${API} (not this app)`, 'stop it, or set PORT in .env / JOBS_API for the scripts');
    }
  } catch {
    warn(`server not running at ${API}`, 'npm run dev   (or: npm start)');
  }

  // Profile + intake state (only meaningful if the server is up and open)
  if (serverUp) {
    try {
      const headers = process.env.APP_PASSWORD ? { Authorization: `Bearer ${process.env.APP_PASSWORD}` } : {};
      const res = await fetch(`${API}/api/profiles/default`, { headers, signal: AbortSignal.timeout(2000) });
      if (res.status === 404) {
        warn('no profile yet', 'open the web UI and complete the onboarding wizard');
      } else if (res.status === 401) {
        warn('server is password-protected; set APP_PASSWORD in the environment for scripts', 'set it in your shell (export APP_PASSWORD=... on macOS/Linux, $env:APP_PASSWORD="..." in PowerShell) — must match the server\'s .env');
      } else if (res.ok) {
        const p = await res.json();
        if (p.intake?.complete && p.intake_completed_at) ok(`profile "${p.first_name} ${p.last_name}" ready (intake complete)`);
        else warn(`profile "${p.first_name} ${p.last_name}" intake incomplete: missing ${JSON.stringify(p.intake?.missing || [])}`, 'finish the onboarding wizard in the web UI');
      }
    } catch { warn('could not check profile state'); }
  }

  // .env
  console.log('\nConfig\n──────');
  if (fs.existsSync(path.join(ROOT, '.env'))) ok('.env present');
  else warn('.env missing (defaults will be used)', 'cp .env.example .env');
  if (fs.existsSync(path.join(ROOT, 'config', 'boards.json'))) ok('config/boards.json present');
  else fail('config/boards.json missing — the scout has nothing to scan', 'restore it from the repo');

  console.log(failures
    ? `\n${failures} problem(s) found — fix the ❌ items above.\n`
    : '\nAll required checks passed. ⚠️  items are optional or next steps.\n');
  process.exit(failures ? 1 : 0);
}

main();
