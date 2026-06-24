#!/usr/bin/env node
/**
 * One-off: render a short ElevenLabs sample to verify acronym pronunciation + the
 * outcome-style narration, using the SAME ACRONYM_MAP/normalization + TTS settings
 * as scripts/generate-voiceover.js. Writes out/voiceover-sample.mp3.
 *   node scripts/scratch/render-voiceover-sample.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
const OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_192';

// --- verbatim from generate-voiceover.js (period spell-out + EWA expansion) ---
const ACRONYM_MAP = {
  'ACH': 'A.C.H.', 'API': 'A.P.I.', 'IDV': 'I.D.V.', 'OTP': 'O.T.P.', 'KYC': 'K.Y.C.',
  'MFA': 'M.F.A.', 'IAV': 'I.A.V.', 'EAV': 'E.A.V.', 'AML': 'A.M.L.', 'PEP': 'P.E.P.',
  'SSN': 'S.S.N.', 'CTA': 'C.T.A.', 'TLS': 'T.L.S.', 'SDK': 'S.D.K.', 'CRA': 'C.R.A.',
  'FDIC': 'F.D.I.C.', 'NMLS': 'N.M.L.S.', 'DTC': 'D.T.C.', 'ACATS': 'A.C.A.T.S.',
  'EWA': 'Earned Wage Access',
};
function expandAcronyms(text) {
  let t = text;
  for (const [acr, exp] of Object.entries(ACRONYM_MAP)) {
    t = t.replace(new RegExp(`\\b${acr}(s)?\\b`, 'g'), (_, plural) => exp + (plural && exp.includes('.') ? 's' : ''));
  }
  return t;
}

// Raw narration (as a freshly-generated, outcome-style script would read it).
const RAW = "Once she links her bank, the API returns her verified income, easily clearing the loan threshold. " +
  "Plaid Signal flags a low-risk transaction, cleared to ACCEPT. With EWA and a quick CRA check, her Gold Savings " +
  "checking account is connected and ready to fund.";

(async () => {
  if (!API_KEY) { console.error('ELEVENLABS_API_KEY missing'); process.exit(1); }
  const text = expandAcronyms(RAW);
  console.log('RAW :', RAW);
  console.log('TTS :', text);
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=${OUTPUT_FORMAT}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        voice_settings: { stability: 0.75, similarity_boost: 0.90, use_speaker_boost: true },
      }),
    }
  );
  if (!res.ok) { console.error('TTS failed:', res.status, (await res.text()).slice(0, 200)); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  const outDir = path.join(process.cwd(), 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'voiceover-sample.mp3');
  fs.writeFileSync(outPath, buf);
  console.log(`✓ wrote ${outPath} (${Math.round(buf.length / 1024)} KB)`);
})();
