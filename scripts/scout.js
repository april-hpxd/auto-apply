#!/usr/bin/env node
// Role scout: polls the Ashby posting API and Greenhouse boards API for the
// boards in config/boards.json, filters titles/locations, and bulk-inserts
// candidates into the server queue (which owns ALL dedup decisions).
//
// Replaces eight copy-paste scout scripts from the original repo, including
// the ones that read the SQLite file directly — every candidate now goes
// through POST /api/jobs/bulk so dedup, squatter-resurrection, and company
// policy are applied in one place.
//
// Usage:
//   node scripts/scout.js [--dry-run] [--profile-id N] [--config path.json]
//
// Prints one parseable line per bulk POST ("bulk: added=X resurrected=Y
// skipped=Z") — the server's queue-drain watcher sums these.

'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ARGS = (() => {
  const out = {
    dryRun: false,
    apiBase: process.env.JOBS_API || `http://localhost:${process.env.PORT || 3001}`,
    profileId: null,
    config: path.join(__dirname, '..', 'config', 'boards.json'),
  };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--api-base') out.apiBase = process.argv[++i];
    else if (a === '--profile-id') out.profileId = Number(process.argv[++i]);
    else if (a === '--config') out.config = process.argv[++i];
  }
  return out;
})();

const CONFIG = JSON.parse(fs.readFileSync(ARGS.config, 'utf8'));
const RELEVANT = new RegExp(CONFIG.filters.relevant, 'i');
const DISQUALIFY = new RegExp(CONFIG.filters.disqualify, 'i');
const US_ONLY = CONFIG.filters.usOnly !== false;

const NONUS_RE = /(india|bangalore|bengaluru|hyderabad|pune|london|united kingdom|\buk\b|paris|france|berlin|munich|germany|canada|toronto|vancouver|singapore|poland|krakow|warsaw|romania|ireland|dublin|tel aviv|israel|amsterdam|netherlands|spain|madrid|barcelona|portugal|lisbon|sydney|australia|tokyo|japan|korea|brazil|mexico|emea|apac|zurich|switzerland)/i;
const US_RE = /(united states|usa|remote|san francisco|new york|seattle|bay area|mountain view|palo alto|nyc|sunnyvale|austin|boston|los angeles|chicago|denver|atlanta|\bus\b|california|washington|texas|colorado|, ca|, ny|, wa|, tx)/i;

function shouldKeep(title) {
  return !!title && !DISQUALIFY.test(title) && RELEVANT.test(title);
}

// Best-effort "will not sponsor" detector, run against posting description
// text when available. This NEVER drops a candidate — F-1/OPT eligibility is
// too consequential to guess silently (same principle as answers.js: skip +
// surface, don't fabricate). It only annotates notes so a human (or the
// sponsorship-aware answer policy at apply time) can see it before applying.
const NO_SPONSORSHIP_RE = /will not sponsor|does not sponsor|unable to sponsor|no (visa |work )?sponsorship( is)? (available|provided|offered)|not (able|eligible) to (provide|offer) (visa )?sponsorship|cannot sponsor|without sponsorship now or (in the future|ever)|must be (a )?(us citizen|authorized to work in the (us|united states) without (need for )?sponsorship)/i;

function sponsorshipFlag(text) {
  if (!text) return null;
  return NO_SPONSORSHIP_RE.test(text) ? 'description mentions no visa sponsorship' : null;
}

function locationOk(loc) {
  if (!US_ONLY) return true;
  if (!loc) return true; // no location info — let a human judge at apply time
  if (NONUS_RE.test(loc)) return false;
  return US_RE.test(loc) || !/,/.test(loc);
}

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.APP_PASSWORD) h.Authorization = `Bearer ${process.env.APP_PASSWORD}`;
  return h;
}

// Chunked bulk POST (large batches have 500'd before). Diagnostics to stderr;
// the parseable bulk lines too — stdout stays clean for piping.
async function postBulk(jobs, label) {
  if (!jobs.length) return;
  if (ARGS.dryRun) {
    console.error(`[dry-run] ${label}: would POST ${jobs.length} candidate(s)`);
    for (const j of jobs) console.error(`  - ${j.company}: ${j.role_title}`);
    return;
  }
  for (let i = 0; i < jobs.length; i += 25) {
    const chunk = jobs.slice(i, i + 25);
    try {
      const res = await fetch(`${ARGS.apiBase}/api/jobs/bulk`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ profile_id: ARGS.profileId ?? undefined, jobs: chunk }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error(`${label}: bulk POST failed ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
        continue;
      }
      console.error(`${label} bulk: added=${data.added} resurrected=${data.resurrected} skipped=${data.skipped}`);
    } catch (e) {
      console.error(`${label}: bulk POST error ${e.message}`);
    }
  }
}

// ── Ashby posting API ───────────────────────────────────────────────────────
function ashbyLocationOk(j) {
  const country = j.address?.postalAddress?.addressCountry || '';
  if (/united states|usa|^us$/i.test(country)) return true;
  const sec = (j.secondaryLocations || []).some((l) =>
    /united states|usa|^us$/i.test(l.address?.postalAddress?.addressCountry || ''));
  if (sec) return true;
  return locationOk(j.location || country || '');
}

async function scoutAshbyBoard(slug) {
  let data;
  try {
    const r = await fetch('https://api.ashbyhq.com/posting-api/job-board/' + encodeURIComponent(slug), {
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) { console.error(`ashby/${slug}: HTTP ${r.status}`); return []; }
    data = await r.json();
  } catch (e) {
    console.error(`ashby/${slug}: ${e.message}`);
    return [];
  }
  const companyName = data?.jobs?.[0]?.organizationName
    || slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const out = [];
  for (const j of data.jobs || []) {
    if (!j.isListed) continue;
    if (!shouldKeep(j.title)) continue;
    if (US_ONLY && !ashbyLocationOk(j)) continue;
    const sponsorNote = sponsorshipFlag(j.descriptionPlain);
    out.push({
      company: companyName,
      role_title: j.title,
      role_url: j.jobUrl || `https://jobs.ashbyhq.com/${slug}/${j.id}`,
      ats: 'ashby',
      notes: `scouted via ashby posting api (${j.location || 'no location'})` + (sponsorNote ? ` | ${sponsorNote}` : ''),
    });
  }
  return out;
}

// ── Greenhouse boards API ───────────────────────────────────────────────────
// The list endpoint has no description text; fetch per-job detail (only for
// candidates that already passed title/location filters) to check for
// explicit no-sponsorship language.
async function fetchGreenhouseDescription(token, jobId) {
  try {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${jobId}?content=true`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return (data.content || '').replace(/<[^>]+>/g, ' ');
  } catch {
    return null;
  }
}

async function scoutGreenhouseBoard(token, companyName) {
  let data;
  try {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) { console.error(`greenhouse/${token}: HTTP ${r.status}`); return []; }
    data = await r.json();
  } catch (e) {
    console.error(`greenhouse/${token}: ${e.message}`);
    return [];
  }
  const out = [];
  for (const j of data.jobs || []) {
    if (!shouldKeep(j.title)) continue;
    if (US_ONLY && !locationOk(j.location?.name || '')) continue;
    const description = await fetchGreenhouseDescription(token, j.id);
    const sponsorNote = sponsorshipFlag(description);
    out.push({
      company: companyName,
      role_title: j.title,
      role_url: j.absolute_url,
      ats: 'greenhouse',
      notes: `scouted via greenhouse boards api (${j.location?.name || 'no location'})` + (sponsorNote ? ` | ${sponsorNote}` : ''),
    });
  }
  return out;
}

(async () => {
  let total = 0;

  for (const slug of CONFIG.ashby || []) {
    const jobs = await scoutAshbyBoard(slug);
    total += jobs.length;
    await postBulk(jobs, `ashby/${slug}`);
  }

  for (const [token, name] of Object.entries(CONFIG.greenhouse || {})) {
    const jobs = await scoutGreenhouseBoard(token, name);
    total += jobs.length;
    await postBulk(jobs, `greenhouse/${token}`);
  }

  console.error(`scout complete: ${total} candidate(s) matched filters` + (ARGS.dryRun ? ' (dry run — nothing posted)' : ''));
})();
