// Continuous apply runner: lets the dashboard Start/Stop a background loop
// that periodically spawns `scripts/apply.js --queue` so discovery and
// application keep running without a human re-typing the CLI command.
//
// Deliberately does NOT touch apply.js's claim/fence/answer logic — this is
// pure orchestration around the existing, battle-tested one-shot script.
// Safety layering:
//   - "Stop" (enabled=false): the loop never spawns apply.js at all.
//   - "Pause" (the pre-existing app_state 'paused' flag in routes/jobs.js):
//     apply.js's own claim loop sees an empty/paused queue and exits
//     immediately — no code path here needs to know about pause explicitly.
//   - Only one apply.js process runs at a time (per server process); the loop
//     waits for the previous spawn to exit before considering a new one.
//   - A CAPTCHA, unsupported form, or ambiguous question never gets answered
//     here either — those still surface as 'failed'/'skipped' queue rows for
//     a human to review in the dashboard (unchanged from the existing
//     fail-safe behavior in scripts/lib/*.js and answers.js).

const { spawn, exec } = require('child_process');
const path = require('path');
const db = require('../db');

const APPLY_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'apply.js');
const CWD = path.join(__dirname, '..', '..');
const POLL_INTERVAL_MS = 2 * 60 * 1000; // don't hammer ATS sites
const MAX_PER_RUN = 20;

let enabled = false;
let currentChild = null;
let lastRunAt = 0;
let lastResult = null;
let pollTimer = null;
let dryRunResult = null;

function isPaused() {
  const row = db.prepare("SELECT value FROM app_state WHERE key = 'paused'").get();
  return row?.value === '1';
}

function pendingCount(profileId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM job_queue jq
    WHERE profile_id = ? AND status = 'pending' AND submitted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM company_policy p
        WHERE p.profile_id = jq.profile_id AND p.company_key = jq.company_key
          AND (p.policy = 'blocked' OR p.reopen_after IS NULL OR p.reopen_after > datetime('now'))
      )
  `).get(profileId).n;
}

function tick(profileId) {
  if (!enabled || currentChild || isPaused()) return;
  if (pendingCount(profileId) === 0) return; // scout_watcher handles rediscovery

  const args = [APPLY_SCRIPT, '--queue', '--max', String(MAX_PER_RUN), '--profile-id', String(profileId)];
  console.log(`[apply_runner] spawning: node ${args.join(' ')}`);
  lastRunAt = Date.now();
  currentChild = spawn(process.execPath, args, { cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  currentChild.stdout.on('data', (d) => { stdout += d; process.stdout.write(`[apply_runner] ${d}`); });
  currentChild.stderr.on('data', (d) => { stderr += d; process.stderr.write(`[apply_runner] ${d}`); });

  currentChild.on('exit', (code) => {
    lastResult = { code, at: new Date().toISOString(), tail: (stdout + stderr).trim().split('\n').slice(-10).join('\n') };
    currentChild = null;
  });
  currentChild.on('error', (e) => {
    lastResult = { code: null, at: new Date().toISOString(), tail: `spawn error: ${e.message}` };
    currentChild = null;
  });
}

function startRunner(profileId) {
  if (!profileId) throw new Error('startRunner: profileId is required');
  enabled = true;
  if (!pollTimer) {
    pollTimer = setInterval(() => tick(profileId), POLL_INTERVAL_MS);
    tick(profileId); // don't wait a full interval for the first attempt
  }
}

// Stops scheduling new runs. If an apply.js run is mid-flight, it is killed —
// on Windows this uses taskkill /t to also take down any child Chromium
// process tree Playwright spawned, not just the Node process.
function stopRunner() {
  enabled = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (currentChild) {
    const pid = currentChild.pid;
    if (process.platform === 'win32') {
      exec(`taskkill /pid ${pid} /t /f`, () => {});
    } else {
      try { currentChild.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }
}

function getStatus() {
  return {
    enabled,
    running: !!currentChild,
    paused: isPaused(),
    lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
    lastResult,
    dryRunResult,
  };
}

// One-shot, non-continuous dry run over currently pending roles — fills forms
// and screenshots them WITHOUT claiming or submitting anything (same
// --dry-run flag as the documented CLI usage). This is the recommended first
// step before ever enabling the continuous live runner above. Refuses to
// start if the live runner (or another dry run) is already using the browser.
function runDryRunOnce(profileId) {
  if (currentChild) throw new Error('an apply session is already running — stop it first');
  const args = [APPLY_SCRIPT, '--queue', '--dry-run', '--max', String(MAX_PER_RUN), '--profile-id', String(profileId)];
  console.log(`[apply_runner] dry run: node ${args.join(' ')}`);
  dryRunResult = { status: 'running', startedAt: new Date().toISOString() };
  currentChild = spawn(process.execPath, args, { cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  currentChild.stdout.on('data', (d) => { stdout += d; process.stdout.write(`[apply_runner:dry-run] ${d}`); });
  currentChild.stderr.on('data', (d) => { stderr += d; process.stderr.write(`[apply_runner:dry-run] ${d}`); });

  currentChild.on('exit', (code) => {
    dryRunResult = { status: 'done', code, finishedAt: new Date().toISOString(), tail: (stdout + stderr).trim().split('\n').slice(-30).join('\n') };
    currentChild = null;
  });
  currentChild.on('error', (e) => {
    dryRunResult = { status: 'error', finishedAt: new Date().toISOString(), tail: `spawn error: ${e.message}` };
    currentChild = null;
  });
  return dryRunResult;
}

module.exports = { startRunner, stopRunner, getStatus, runDryRunOnce };
