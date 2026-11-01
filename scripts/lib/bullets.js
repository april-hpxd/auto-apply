// User-curated "bullet bank" — the ONLY source of resume content. Nothing in
// this pipeline invents experience: Ollama may select/rank/reword bullets
// that live here, never add facts that aren't already in this file or the
// profile record. Edit data/resume_bullets.json by hand (or point
// RESUME_BULLETS_FILE elsewhere) before generating a tailored resume.
//
// Shape: { header: { summary }, sections: [ { title, items: [ { id, text,
//   tags: [keyword,...] } ] } ] }
// `tags` are plain keywords (e.g. "python", "bioinformatics") used to help
// the tailor pick relevant items before Ollama ever sees them — the model
// only re-ranks/lightly rewords within the given set, it never adds items.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = process.env.RESUME_BULLETS_FILE || path.join(__dirname, '..', '..', 'data', 'resume_bullets.json');

const TEMPLATE = {
  $comment: 'Fill this in with YOUR real experience. Every bullet must be true — the generator only selects and lightly rewords existing bullets, it never invents new ones. "tags" are free-text keywords used to match bullets to a job posting.',
  header: { summary: 'One or two true sentences about who you are professionally.' },
  sections: [
    {
      title: 'Experience',
      items: [
        { id: 'exp1', text: 'Example: Built a data pipeline processing 10k records/day using Python and PostgreSQL.', tags: ['python', 'data engineering', 'sql'] },
      ],
    },
    {
      title: 'Projects',
      items: [
        { id: 'proj1', text: 'Example: Developed a bioinformatics tool for variant calling from genomic sequence data.', tags: ['bioinformatics', 'genomics', 'python'] },
      ],
    },
    {
      title: 'Skills',
      items: [
        { id: 'skill1', text: 'Python, R, SQL, pandas, scikit-learn', tags: ['python', 'r', 'sql', 'data science'] },
      ],
    },
  ],
};

function ensureExists(filePath = DEFAULT_PATH) {
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(TEMPLATE, null, 2));
  return true;
}

function load(filePath = DEFAULT_PATH) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `resume bullet bank not found at ${filePath}. Run "node scripts/generate.js --init-bullets" ` +
      'to create a template, then fill it in with your real experience before generating anything.'
    );
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!data.sections || !Array.isArray(data.sections)) throw new Error('resume_bullets.json: missing "sections" array');
  return data;
}

// Flat list of every bullet, each tagged with its section title — this is the
// closed set the tailor is allowed to choose from.
function allBullets(bank) {
  const out = [];
  for (const section of bank.sections) {
    for (const item of section.items || []) out.push({ ...item, section: section.title });
  }
  return out;
}

module.exports = { DEFAULT_PATH, ensureExists, load, allBullets };
