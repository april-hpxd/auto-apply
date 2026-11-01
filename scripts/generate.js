#!/usr/bin/env node
// Generates a tailored resume PDF + draft cover letter for ONE role, written
// to generated/<company>-<role>/ for human review. This is a review-only
// artifact generator — it never touches the queue, the claim protocol, or
// apply.js. Nothing here is auto-attached to a submission; you decide
// whether to point a profile's resume_path at a generated PDF (via the web
// UI's resume upload) before applying.
//
// Usage:
//   node scripts/generate.js --init-bullets
//     Creates data/resume_bullets.json from a template if it doesn't exist.
//
//   node scripts/generate.js --company "Acme" --role-title "Data Scientist Intern" \
//     [--description-file path.txt] [--profile-id N] [--no-cover-letter]
//     Generates generated/Acme-Data_Scientist_Intern/{resume.pdf,cover_letter.txt}
//
// All resume content comes from data/resume_bullets.json (your own words,
// edited by hand) — the AI only selects/ranks which of YOUR bullets are most
// relevant per job; it never invents experience. See lib/tailor.js and
// lib/bullets.js for the fabrication guards.

'use strict';

const fs = require('fs');
const path = require('path');
const api = require('./lib/api');
const bullets = require('./lib/bullets');
const tailor = require('./lib/tailor');
const { generateResumePdf } = require('./lib/resume_pdf');
const { draftCoverLetter } = require('./lib/coverletter_gen');

function parseArgs(argv) {
  const out = { initBullets: false, company: null, roleTitle: null, descriptionFile: null, profileId: null, coverLetter: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--init-bullets') out.initBullets = true;
    else if (a === '--company') out.company = argv[++i];
    else if (a === '--role-title') out.roleTitle = argv[++i];
    else if (a === '--description-file') out.descriptionFile = argv[++i];
    else if (a === '--profile-id') out.profileId = Number(argv[++i]);
    else if (a === '--no-cover-letter') out.coverLetter = false;
  }
  return out;
}

function slug(s) {
  return String(s || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'untitled';
}

(async () => {
  const args = parseArgs(process.argv);

  if (args.initBullets) {
    const created = bullets.ensureExists();
    console.log(created
      ? `Created ${bullets.DEFAULT_PATH} — edit it with YOUR real experience before generating anything.`
      : `${bullets.DEFAULT_PATH} already exists — left untouched.`);
    return;
  }

  if (!args.company || !args.roleTitle) {
    console.error('Usage: node scripts/generate.js --company "X" --role-title "Y" [--description-file path.txt] [--profile-id N] [--no-cover-letter]');
    console.error('   or: node scripts/generate.js --init-bullets');
    process.exit(2);
  }

  const bank = bullets.load(); // throws with a clear message if not set up yet
  const flat = bullets.allBullets(bank);

  let profile;
  try { profile = await api.fetchProfile(args.profileId); }
  catch (e) { console.error('ABORT:', e.message); process.exit(2); }

  const jobDescription = args.descriptionFile ? fs.readFileSync(args.descriptionFile, 'utf8') : '';

  const { items, usedAI } = await tailor.selectBullets({
    bullets: flat,
    jobTitle: args.roleTitle,
    jobDescription,
  });
  console.log(`Selected ${items.length} bullet(s) (${usedAI ? 'Ollama-ranked' : 'keyword-ranked fallback'}).`);

  const bySection = new Map();
  for (const b of items) {
    if (!bySection.has(b.section)) bySection.set(b.section, []);
    bySection.get(b.section).push(b);
  }
  const sections = [...bySection.entries()].map(([title, its]) => ({ title, items: its }));

  const outDir = path.join(__dirname, '..', 'generated', `${slug(args.company)}-${slug(args.roleTitle)}`);
  fs.mkdirSync(outDir, { recursive: true });

  const resumePath = path.join(outDir, 'resume.pdf');
  await generateResumePdf({ profile, summary: bank.header?.summary, sections, outPath: resumePath });
  console.log('Resume written:', resumePath);

  if (args.coverLetter) {
    try {
      const letter = await draftCoverLetter({
        profile, bulletBank: bank,
        jobTitle: args.roleTitle, company: args.company, jobDescription,
      });
      const letterPath = path.join(outDir, 'cover_letter.txt');
      fs.writeFileSync(letterPath, letter);
      console.log('Cover letter draft written:', letterPath, '— REVIEW BEFORE USE.');
    } catch (e) {
      console.error('Cover letter skipped:', e.message);
    }
  }

  console.log('\nThese are DRAFTS. Review both files before attaching/sending anything.');
})();
