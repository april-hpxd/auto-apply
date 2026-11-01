// Drafts a cover letter grounded ONLY in facts already in the profile
// (background/positioning text, school, current role, bullet bank) and the
// job posting's own title/company/description. The model is explicitly told
// not to invent facts, but — unlike tailor.js's bullet selection — there is
// no hard programmatic guard against a hallucinated detail in free-text
// prose, so the output is always a DRAFT for human review before it is sent
// anywhere, never auto-attached to a submission.

'use strict';

const ollama = require('./ollama');

const SYSTEM = `You write concise, professional cover letters (250-350 words).
Rules you must follow:
- Use ONLY the facts given to you below (profile summary, bullet bank, job info). Never invent employers, dates, titles, metrics, or skills not present in the input.
- Do not state or imply any claim about visa status, sponsorship, work authorization, or immigration status — leave that entirely out of the letter.
- No generic filler like "I am a perfect fit" without a concrete, given reason.
- Plain prose, no markdown, no bullet points, no placeholder brackets.
- End with a simple sign-off using the candidate's name.`;

async function draftCoverLetter({ profile, bulletBank, jobTitle, company, jobDescription }) {
  const avail = await ollama.checkAvailable();
  if (!avail.available) {
    throw new ollama.OllamaUnavailableError(`Ollama not ready (${avail.reason}) — cover letter drafting needs it. Run "ollama serve" and "ollama pull ${ollama.OLLAMA_MODEL}".`);
  }

  const bulletText = (bulletBank.sections || [])
    .flatMap((s) => (s.items || []).map((i) => `- ${i.text}`))
    .join('\n');

  const prompt = `Candidate name: ${profile.name}
Candidate summary: ${bulletBank.header?.summary || profile.background || '(none given)'}
Candidate background notes: ${profile.positioning || '(none given)'}
Candidate's true experience bullets (use only what's relevant, do not add to this list):
${bulletText}

Target role: ${jobTitle} at ${company}
Job description (may be partial): ${(jobDescription || '(not provided)').slice(0, 4000)}

Write the cover letter now.`;

  const text = await ollama.generate({ system: SYSTEM, prompt, temperature: 0.4 });
  return text;
}

module.exports = { draftCoverLetter };
