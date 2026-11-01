// Picks which EXISTING bullets (from the user's bullet bank) are most
// relevant to a posting. Ollama is only ever allowed to return ids from the
// closed set it was given — anything else (a made-up id, invented text) is
// rejected. This is a selection problem, never a generation-of-facts problem:
// the model cannot add an experience that isn't already in bullets.js's bank.
//
// Falls back to keyword/tag overlap (no AI) when Ollama is unavailable, so
// resume generation never hard-depends on a local model being up.

'use strict';

const ollama = require('./ollama');

function keywordScore(bullet, jobText) {
  const text = (jobText || '').toLowerCase();
  const tags = bullet.tags || [];
  return tags.reduce((n, t) => n + (text.includes(String(t).toLowerCase()) ? 1 : 0), 0);
}

// Deterministic fallback: rank by tag-overlap with the job title+description,
// take the top N per section (at least one per section when available).
function keywordSelect(bullets, jobText, perSection) {
  const bySection = new Map();
  for (const b of bullets) {
    if (!bySection.has(b.section)) bySection.set(b.section, []);
    bySection.get(b.section).push(b);
  }
  const picked = [];
  for (const [, items] of bySection) {
    const ranked = [...items].sort((a, b) => keywordScore(b, jobText) - keywordScore(a, jobText));
    picked.push(...ranked.slice(0, perSection));
  }
  return picked;
}

/**
 * selectBullets({ bullets, jobTitle, jobDescription, perSection }) ->
 *   { items: [bullet,...], usedAI: boolean }
 * `bullets` must be the flat list from bullets.allBullets() — every returned
 * item is one of these objects, unmodified (ids/text are never rewritten
 * here; see rewordBullet for the separate, explicitly-bounded wording pass).
 */
async function selectBullets({ bullets, jobTitle, jobDescription, perSection = 4 }) {
  const jobText = `${jobTitle || ''}\n${jobDescription || ''}`;
  const validIds = new Set(bullets.map((b) => b.id));

  const avail = await ollama.checkAvailable().catch(() => ({ available: false }));
  if (!avail.available) {
    return { items: keywordSelect(bullets, jobText, perSection), usedAI: false };
  }

  const catalog = bullets.map((b) => `${b.id} [${b.section}] (${(b.tags || []).join(', ')}): ${b.text}`).join('\n');
  const prompt =
    `Job title: ${jobTitle || '(unknown)'}\n` +
    `Job description (may be partial):\n${(jobDescription || '(none provided)').slice(0, 4000)}\n\n` +
    `Candidate's existing resume bullets (id [section] (tags): text):\n${catalog}\n\n` +
    'Return ONLY a JSON array of the ids (strings) of the bullets most relevant to this job, ' +
    `most relevant first, at most ${perSection} per section. Do not invent ids. Do not include any text other than the JSON array.`;

  let out;
  try {
    out = await ollama.generate({
      system: 'You select from a given list only. You never invent new ids or text. You respond with nothing but a JSON array of strings.',
      prompt,
      temperature: 0.1,
    });
  } catch {
    return { items: keywordSelect(bullets, jobText, perSection), usedAI: false };
  }

  let ids;
  try {
    const match = out.match(/\[[\s\S]*\]/);
    ids = JSON.parse(match ? match[0] : out);
  } catch {
    return { items: keywordSelect(bullets, jobText, perSection), usedAI: false };
  }
  if (!Array.isArray(ids)) return { items: keywordSelect(bullets, jobText, perSection), usedAI: false };

  // Safety: drop anything that isn't a real id from the bank — this is the
  // actual fabrication guard, not the prompt wording.
  const seen = new Set();
  const items = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    items.push(bullets.find((b) => b.id === id));
  }
  if (!items.length) return { items: keywordSelect(bullets, jobText, perSection), usedAI: false };
  return { items, usedAI: true };
}

module.exports = { selectBullets, keywordSelect };
