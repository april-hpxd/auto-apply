// Renders a resume PDF from the profile + a set of ALREADY-SELECTED bullets
// (see tailor.js). This module does not call any AI and does not invent
// content — it is pure templating, using Playwright (already a project
// dependency) to print HTML to PDF.

'use strict';

const fs = require('fs');
const path = require('path');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHtml({ profile, summary, sections }) {
  const contactParts = [profile.email, profile.phone, profile.locationFull, profile.linkedin, profile.github, profile.website]
    .filter(Boolean).map(esc).join(' &nbsp;|&nbsp; ');

  const sectionsHtml = sections.map(({ title, items }) => `
    <section>
      <h2>${esc(title)}</h2>
      <ul>${items.map((b) => `<li>${esc(b.text)}</li>`).join('')}</ul>
    </section>`).join('\n');

  const eduHtml = profile.school ? `
    <section>
      <h2>Education</h2>
      <p><strong>${esc(profile.school)}</strong> — ${esc(profile.degree)}${profile.discipline ? ', ' + esc(profile.discipline) : ''}
      ${profile.eduStartYear || profile.eduEndYear ? ` (${esc(profile.eduStartYear)}–${esc(profile.eduEndYear)})` : ''}</p>
    </section>` : '';

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; margin: 40px 56px; font-size: 11pt; line-height: 1.45; }
  h1 { font-size: 20pt; margin: 0 0 4px; }
  .contact { font-size: 9.5pt; color: #444; margin-bottom: 16px; }
  h2 { font-size: 12pt; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid #999; margin: 18px 0 6px; padding-bottom: 2px; }
  ul { margin: 4px 0; padding-left: 18px; }
  li { margin-bottom: 4px; }
  .summary { margin: 8px 0 4px; }
</style></head>
<body>
  <h1>${esc(profile.name)}</h1>
  <div class="contact">${contactParts}</div>
  ${summary ? `<p class="summary">${esc(summary)}</p>` : ''}
  ${eduHtml}
  ${sectionsHtml}
</body></html>`;
}

/**
 * generateResumePdf({ profile, summary, sections, outPath }) -> outPath
 * `sections` = [{ title, items: [{ text }] }] — items come straight from
 * tailor.js's selection, unmodified.
 */
async function generateResumePdf({ profile, summary, sections, outPath }) {
  const html = renderHtml({ profile, summary, sections });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'Letter', margin: { top: '0', bottom: '0', left: '0', right: '0' } });
  } finally {
    await browser.close();
  }
  return outPath;
}

module.exports = { renderHtml, generateResumePdf };
