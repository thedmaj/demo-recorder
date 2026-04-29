# inputs/prompt.txt Examples

Drop one of these as `inputs/prompt.txt` and run `npm run demo` (app-only build + QA, stops at `build-qa` for fast iteration). Use `npm run demo:full` when you're ready to render the final MP4.

---

## Mode A: Build from scratch

```
Build a demo for Plaid Identity Verification targeting technical decision-makers at fintech companies.

Persona: Marcus Chen, CTO at NovaPay, onboarding a new customer named Leslie Knope from Smith & Cedar.

Show these steps:
- Welcome screen with Plaid IDV branding
- Document capture (driver's license front and back)
- Selfie / liveness check
- Backend verification in progress
- Trust Index score reveal (aim for 91/100)
- Watchlist clear result
- Data match confirmation (name, DOB, address)
- Success / account approved screen

Voice: confident and authoritative, conversational not robotic.
Add a zoom effect on the Trust Index score reveal.
Show a callout badge with the Trust Index value.
```

---

## Mode B: Enhance an existing recording

```
I have a rough screen recording of the Plaid Identity Verification flow in inputs/videos/idv-rough.mp4.
My voice narration covers the full flow but is unpolished.

Polish it:
- Replace my voice with a professional ElevenLabs voice
- Improve the narration script based on Plaid's official messaging
- Add animated overlays: Trust Index badge on the score reveal, lower-thirds for product name
- Add a zoom punch when the verification result appears

Keep the timing close to my original pacing.
```

---

## Mode C: Hybrid (combine existing recording + Claude-built sections)

```
Build a demo for Plaid Instant Auth targeting consumer lending companies.

Persona: Sarah Johnson at QuickCredit, applying for a personal loan.

Use intro.mp4 from inputs/videos/ as the opening (it shows the problem statement and
the loan application form). Then build and record the Instant Auth bank connection steps:
- Institution search
- Credentials entry
- Account selection
- Data sharing confirmation
- Return to QuickCredit with verified account data

Voice: warm but professional.
Combine both parts into one polished 2-minute video.
Add a callout showing the account balance returned by the API.
```

---

## Tips
- Be specific about what steps to show — Claude uses this to structure the demo-script.json
- Mentioning a video file by name (e.g., "intro.mp4") triggers hybrid mode for that segment
- "Voice" instructions carry through to ElevenLabs stability/style settings
- Visual effect requests ("zoom", "badge", "lower-third") go into overlay-plan.json
- You don't need to specify mode — Claude infers it from what files are present and what you describe
