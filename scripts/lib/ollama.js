// Thin client for a local Ollama server. Everything here is additive and
// OPTIONAL — nothing in the claim/fence/submit pipeline depends on it.
//
// Scope boundary (do not widen without re-reading answers.js's safety notes):
//   - Resume/cover-letter drafting: fine. Output is a draft a human reviews
//     before it's attached/sent — never auto-submitted.
//   - Classifying an ambiguous free-text screening question as
//     "needs human review" vs "safe to skip": fine, it only ever downgrades
//     to a warning, never answers the question itself.
//   - Yes/no eligibility, immigration, or demographic answers: NEVER. Those
//     stay on the deterministic, auditable policy in lib/answers.js. An LLM
//     is non-deterministic and unauditable — exactly wrong for a question
//     where a false claim can end a work-authorization case.
//
// No API keys, no network calls beyond localhost — everything stays on-device.

'use strict';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

class OllamaUnavailableError extends Error {}

// Quick reachability + model-presence check. Callers should treat failure as
// "skip the AI-assisted step, fall back to the deterministic path" — never
// as "block the pipeline."
async function checkAvailable({ timeoutMs = 3000 } = {}) {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { available: false, reason: `HTTP ${r.status}` };
    const data = await r.json();
    const models = (data.models || []).map((m) => m.name);
    const hasModel = models.some((m) => m === OLLAMA_MODEL || m.startsWith(OLLAMA_MODEL.split(':')[0] + ':'));
    if (!hasModel) {
      return { available: false, reason: `model ${OLLAMA_MODEL} not pulled (have: ${models.join(', ') || 'none'})`, models };
    }
    return { available: true, models };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

// One-shot generation. `system` + `prompt` in, plain text out. Deterministic-
// leaning defaults (low temperature) since this drafts factual content
// (resume bullets, cover letters) rather than creative text.
async function generate({ system, prompt, model = OLLAMA_MODEL, temperature = 0.3, timeoutMs = 180000 }) {
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        system,
        stream: false,
        options: { temperature },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new OllamaUnavailableError(`Ollama unreachable at ${OLLAMA_URL}: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new OllamaUnavailableError(`Ollama generate failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.response || '').trim();
}

module.exports = { OLLAMA_URL, OLLAMA_MODEL, OllamaUnavailableError, checkAvailable, generate };
