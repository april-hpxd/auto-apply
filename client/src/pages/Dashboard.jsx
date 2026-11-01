import React, { useEffect, useState } from 'react';
import { apiFetch } from '../api.js';

export default function Dashboard({ profile }) {
  const [jobs, setJobs] = useState([]);
  const [pauseState, setPauseState] = useState(null);
  const [runnerState, setRunnerState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('pending');

  async function refresh() {
    try {
      const [jr, pr, rr] = await Promise.all([
        apiFetch(`/api/jobs?profile_id=${profile.id}`),
        apiFetch('/api/jobs/paused'),
        apiFetch('/api/runner/status'),
      ]);
      setJobs(await jr.json());
      setPauseState(await pr.json());
      setRunnerState(await rr.json());
    } catch { /* transient */ }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  async function togglePause() {
    setBusy(true);
    await apiFetch(pauseState?.paused ? '/api/jobs/resume' : '/api/jobs/pause', { method: 'POST' }).catch(() => {});
    await refresh();
    setBusy(false);
  }

  async function startRunner() {
    if (!window.confirm(
      'This starts LIVE applying: the runner will claim, fill, and SUBMIT real applications ' +
      'from your queue, continuously, until you click Stop. Run a dry run first if you haven\'t ' +
      'already. Continue?'
    )) return;
    setBusy(true);
    await apiFetch('/api/runner/start', { method: 'POST', body: JSON.stringify({ profile_id: profile.id }) }).catch(() => {});
    await refresh();
    setBusy(false);
  }

  async function stopRunner() {
    setBusy(true);
    await apiFetch('/api/runner/stop', { method: 'POST' }).catch(() => {});
    await refresh();
    setBusy(false);
  }

  async function dryRun() {
    setBusy(true);
    await apiFetch('/api/runner/dry-run', { method: 'POST', body: JSON.stringify({ profile_id: profile.id }) }).catch(() => {});
    await refresh();
    setBusy(false);
  }

  const needsReview = jobs.filter((j) => j.status === 'failed' && j.submitted_at);

  const counts = jobs.reduce((acc, j) => { acc[j.status] = (acc[j.status] || 0) + 1; return acc; }, {});
  const shown = jobs.filter((j) => (filter === 'all' ? true : j.status === filter));

  return (
    <div className="page">
      <h1>Queue</h1>
      <div className="stat-grid">
        {['pending', 'in_progress', 'done', 'failed'].map((s) => (
          <div className="stat" key={s}>
            <div className="n">{counts[s] || 0}</div>
            <div className="lbl">{s.replace('_', ' ')}</div>
          </div>
        ))}
      </div>

      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button className="btn secondary" onClick={dryRun} disabled={busy || runnerState?.running}>
          Dry run queue
        </button>
        {!runnerState?.enabled ? (
          <button className="btn danger" onClick={startRunner} disabled={busy || !runnerState}>Start (live)</button>
        ) : (
          <>
            <button className={'btn' + (pauseState?.paused ? '' : ' secondary')} onClick={togglePause} disabled={busy || !pauseState}>
              {pauseState?.paused ? 'Resume' : 'Pause'}
            </button>
            <button className="btn danger" onClick={stopRunner} disabled={busy}>Stop</button>
          </>
        )}
        <span className="muted small">
          {!runnerState?.enabled
            ? 'Stopped. "Dry run queue" fills forms without submitting — do this first. "Start (live)" claims + fills + submits, continuously, until stopped.'
            : pauseState?.paused
              ? 'Paused — the runner stays on but will not claim new roles until resumed.'
              : runnerState?.running
                ? 'Running an apply session now.'
                : 'Running — waiting for pending roles (checks every 2 min).'}
        </span>
      </div>

      {runnerState?.dryRunResult && (
        <div className="card">
          <strong>Dry run: {runnerState.dryRunResult.status}</strong>
          {runnerState.dryRunResult.tail && (
            <pre className="muted small" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>
              {runnerState.dryRunResult.tail}
            </pre>
          )}
        </div>
      )}

      {needsReview.length > 0 && (
        <div className="card" style={{ borderColor: '#d97706' }}>
          <strong>{needsReview.length} role(s) need human review</strong>
          <div className="muted small">
            Submit was clicked but success wasn't confirmed (e.g. CAPTCHA, unsupported form, or an
            unexpected page) — these are NOT retried automatically. Check the Notes column below.
          </div>
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {['pending', 'in_progress', 'done', 'failed', 'skipped', 'all'].map((s) => (
            <button
              key={s}
              className={'btn secondary'}
              style={filter === s ? { background: '#eef1fb' } : {}}
              onClick={() => setFilter(s)}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
        <table>
          <thead>
            <tr><th>Company</th><th>Role</th><th>Status</th><th>Notes</th></tr>
          </thead>
          <tbody>
            {shown.map((j) => (
              <tr key={j.id}>
                <td>{j.company}</td>
                <td>{j.role_url ? <a href={j.role_url} target="_blank" rel="noreferrer">{j.role_title}</a> : j.role_title}</td>
                <td><span className={'badge ' + j.status}>{j.status}</span>{j.submitted_at ? <span className="muted small"> submitted</span> : null}</td>
                <td className="small muted">{(j.error || j.notes || '').slice(0, 140)}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={4} className="muted">Nothing here. Run <code>node scripts/scout.js</code> to find roles.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
