# inputs/prompt.txt Examples

In **agent mode** (the recommended path — see README §3) you can just paste one of these as your message and the agent writes `inputs/prompt.txt` and runs the build. Or drop one in as `inputs/prompt.txt` yourself and run `npm run demo` (app-only build + QA, stops at `build-qa` for fast iteration). Use `npm run demo:full` when you're ready to render the final MP4.

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
- Verification decision reveal (status: success)
- Watchlist / PEP screening: clear
- Data match confirmation (name, DOB, address)
- Success / account approved screen

Voice: confident and authoritative, conversational not robotic.
Add a zoom effect on the verification-success reveal.
Show a callout badge with the verification status.
```

---

## Mode B: Enhance an existing recording

```
I have a rough screen recording of the Plaid Identity Verification flow in inputs/videos/idv-rough.mp4.
My voice narration covers the full flow but is unpolished.

Polish it:
- Replace my voice with a professional ElevenLabs voice
- Improve the narration script based on Plaid's official messaging
- Add animated overlays: a verification-result badge on the decision reveal, lower-thirds for product name
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
- "Voice" instructions carry through to ElevenLabs stability/style settings (default `style` is `0.45`)
- Visual effect requests ("zoom", "badge", "lower-third") are captured in overlay-plan.json — note they're **opt-in**: the default render is clean (MoviePy, pointer/click-ripple only; set `REMOTION_POINTER_ONLY=false` for cinematic overlays)
- You don't need to specify mode — Claude infers it (`scratch` / `enhance` / `hybrid`) from what files are present and what you describe
- Use **approved, product-accurate** language: e.g. **Trust Index is Plaid Protect only — never Plaid IDV** (IDV verdicts are `active` / `success` / `failed` / `pending_review`). See [`CLAUDE.md`](../CLAUDE.md) critical gotchas.
