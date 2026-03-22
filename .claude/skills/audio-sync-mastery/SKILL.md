---
name: audio-sync-mastery
description: ElevenLabs voice settings, SSML text pre-processing, sync-map speed/freeze/normal modes, and when to use each
---

# Audio Sync Mastery

## ElevenLabs Voice Settings (do not change without documented reason)

```javascript
voice_settings: {
  stability:         0.75,  // MUST stay at 0.75 — lower values cause stutter/freeze artifacts
  similarity_boost:  0.90,  // high fidelity to reference voice
  style:             0.2,
  use_speaker_boost: true,
}
```

**Critical**: `stability: 0.75` was chosen after experiencing stutter artifacts with lower values. The report-suggested value of 0.4 has been explicitly rejected. Do NOT lower stability.

- Model: `eleven_multilingual_v2` (or `ELEVENLABS_MODEL_ID` env override)
- Output format: `mp3_44100_192` — 192kbps 44.1kHz (highest MP3 quality ElevenLabs supports)
- Voice: `ELEVENLABS_VOICE_ID` env var (default: George / `JBFqnCBsd6RMkjVDRZzb`)

## Narration Pre-Processing (`normalizeNarration`)

Applied in `generate-voiceover.js` before each ElevenLabs API call.

### Acronym Expansion

Acronyms are expanded to letter-by-letter for correct TTS pronunciation:

| Input | Expanded |
|---|---|
| ACH | A C H |
| API | A P I |
| IDV | I D V |
| OTP | O T P |
| KYC | K Y C |
| MFA | M F A |
| SSN | S S N |
| AML | A M L |

### SSML Breaks for Reveal Moments

`eleven_multilingual_v2` supports SSML `<break>` tags inline.
A 0.4s break is injected before reveal phrases (ACCEPT, approved, verified, authorized)
when the step is detected as a reveal moment.

```
"Signal score 12. ACCEPT" → "Signal score 12. <break time="0.4s"/>ACCEPT"
```

Reveal detection patterns: ACCEPT, approved, verified, score \d, in under \d, instant, authorized, confirmed.

## Sync Map — Speed, Freeze, Normal Modes

The sync map (`sync-map.json`, edited in `SYNC_MAP_S` in `ScratchComposition.jsx`) controls
how processed video time maps to composition time.

### When to use each mode

| Mode | When to use | Effect |
|---|---|---|
| `speed` | Screen transitions too slow / silent gap in UI | Video plays faster, narration stays at 1× |
| `freeze` | Audio narrating while screen is static / loading | Video holds one frame, narration continues |
| `normal` | 1:1 default outside any sync entry | Identity mapping |

### Sync map entry format

```javascript
// In SYNC_MAP_S (ScratchComposition.jsx) or sync-map.json:
{ compStart: 13.0, compEnd: 37.0, videoStart: 13.0, mode: 'speed', speed: 1.3 }
{ compStart: 37.0, compEnd: 47.5, videoStart: 47.5, mode: 'freeze' }
```

All times are in **seconds** on the **composition timeline** (= processed video time when
`CUT_START_S` is set past video end, which is the normal pipeline state).

### Practical examples

**Plaid Link speed-up** (avoid 30s of loading time in video):
```javascript
// wf-link-launch spans processed 13.0→44.2s (31.2s raw). Speed to 1.3×:
{ compStart: 13.0, compEnd: 37.0, videoStart: 13.0, mode: 'speed', speed: 1.3 }
// After speed-up, re-sync freeze to align remaining steps:
{ compStart: 37.0, compEnd: 47.5, videoStart: 47.5, mode: 'freeze' }
```

**API response panel freeze** (narrate while loading spinner is visible):
```javascript
{ compStart: 52.0, compEnd: 55.0, videoStart: 56.0, mode: 'freeze' }
// Holds the "loaded" frame for 3s while narration describes the result
```

### Do NOT speed-up the wf-link-launch step

The Plaid Link step already uses `speed: 1.3`. Adding further speed-up distorts the
real Plaid SDK UX. Only adjust the `compEnd` and `freeze` window.

## Voiceover Placement Pipeline

1. **record** stage writes `step-timing.json` (raw recording timestamps per step)
2. **post-process** stage writes `processed-step-timing.json` (cut-adjusted timestamps)
3. **voiceover** stage remaps timings → composition coordinates using sync map
4. Clips placed at `step.startMs + voiceoverStartOffsetMs` in composition time

### voiceoverStartOffsetMs

Add to any step in `demo-script.json` to delay narration start:
```json
{ "id": "reveal-step", "voiceoverStartOffsetMs": 1500, "narration": "..." }
```
Use when the reveal element animates in after step transition (give viewer 1–2s to see it first).

## Audio QA — Stutter/Freeze Detection

Per-clip detection runs before render (`audio-qa` stage in orchestrator):
- Uses `ffmpeg silencedetect noise=-40dB:d=0.15`
- Stutter threshold: internal silence ≥ 0.15s → clip deleted and regenerated
- Freeze threshold: ≥ 0.5s silence → clip deleted and regenerated
- Stitched `voiceover.mp3` rebuilt after any regeneration

If a clip keeps failing audio QA, check:
1. The narration text for unusual punctuation or all-caps words that confuse TTS
2. Whether `normalizeNarration` is expanding an acronym unexpectedly
3. The `stability` setting (must remain 0.75)

## Resync Audio Stage

Run after editing `sync-map.json` without re-recording:
```bash
npm run demo:from:resync-audio
# or
npm run resync-audio
```
This re-runs voiceover timing placement using the updated sync map without regenerating MP3 clips.
