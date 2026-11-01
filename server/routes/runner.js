// Dashboard Start/Pause/Stop controls for the continuous apply runner.
// "Pause" reuses the existing /api/jobs/pause|resume fence (unchanged); this
// route only controls whether the background loop exists at all.

const express = require('express');
const router = express.Router();
const runner = require('../services/apply_runner');
const { getDefaultProfile } = require('./profiles');

function resolveProfileId(req) {
  const raw = req.body?.profile_id ?? req.query?.profile_id;
  if (raw != null && raw !== '') return Number(raw);
  const p = getDefaultProfile();
  return p ? p.id : null;
}

router.get('/status', (req, res) => {
  res.json(runner.getStatus());
});

router.post('/start', (req, res) => {
  const profileId = resolveProfileId(req);
  if (!profileId) return res.status(400).json({ error: 'no_profile', hint: 'complete onboarding first' });
  try {
    runner.startRunner(profileId);
    res.json(runner.getStatus());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/stop', (req, res) => {
  runner.stopRunner();
  res.json(runner.getStatus());
});

// One-shot, non-continuous dry run — the recommended first step before ever
// starting the live continuous runner above. Never claims or submits.
router.post('/dry-run', (req, res) => {
  const profileId = resolveProfileId(req);
  if (!profileId) return res.status(400).json({ error: 'no_profile', hint: 'complete onboarding first' });
  try {
    runner.runDryRunOnce(profileId);
    res.json(runner.getStatus());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
