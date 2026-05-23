# Template Library

> **Eleven reusable slide templates for the Plaid deck system.**
> Each template includes: when to use it, layout description, copy-paste skeleton, and design notes. Templates compose — you can put a stat callout inside a comparison slide, or a quote block inside a customer-proof slide.

Templates by purpose:

| Template | Purpose |
|---|---|
| **T1 — Title** | Open the deck. Single dominant headline, holo background. |
| **T2 — Section divider** | Mark a new section. Big serif numeral + section name. |
| **T3 — Statement** | One headline, one body paragraph, lots of breathing room. |
| **T4 — Big-number trio** | Three hero stats side-by-side. |
| **T5 — Three-column body** | Three columns of equal-weight content with mono eyebrows. |
| **T6 — Before / after split** | Two-panel comparison (raw → enriched, before → after, etc.) |
| **T7 — Comparison table** | Four rows of "old way → new way" with mint arrows. |
| **T8 — Step flow** | Three sequential cards (process, workflow, evolution). |
| **T9 — Architecture diagram** | One block on top → many cards on the bottom, connected by SVG. |
| **T10 — Customer proof** | Hero stat + pull quote + supporting logos. |
| **T11 — CTA / next steps** | Three action cards based on audience segment. |

---

## T1 — Title slide

**When to use:** the first slide. Also a one-off "act break" inside long decks.

**Layout:**
- `.holo` background
- Optional small mono "tease" text above the headline (e.g. a raw data fragment, a quote, a date)
- Massive headline in Bowery Street 500, 110–140px, with an italicized accent
- Subtitle in Plaid Sans 42px
- Bottom-row split: detail on the left, deck metadata on the right

**Skeleton:**

```html
<section class="holo" data-label="01 Title">
  <div class="frame" style="padding-top:140px;">
    <img class="chrome-logo" src="assets/logos/plaid-horizontal-dark.png" alt="Plaid" />

    <div class="mono-block" style="font-size:30px; color:rgba(2,37,68,0.55); margin-bottom:64px;">
      OPTIONAL_DATA_TEASE_OR_QUOTE
    </div>

    <h1 style="font-family:var(--font-display); font-weight:500; font-size:140px;
               line-height:0.98; letter-spacing:-0.025em; margin:0; max-width:1500px;">
      Primary headline<br/>
      with an <em style="font-style:italic; font-weight:400;">italicized accent.</em>
    </h1>

    <p style="margin-top:80px; font-family:var(--font-sans); font-size:42px;
              color:rgba(2,37,68,0.76); max-width:1200px;">
      Subtitle that explains what the deck is about in one sentence.
    </p>

    <div style="margin-top:120px; display:flex; justify-content:space-between; align-items:flex-end;">
      <div style="font-family:var(--font-mono); font-size:26px; color:rgba(2,37,68,0.78); line-height:1.6;">
        Left-side mono detail<br/>
        such as JSON or attribution
      </div>
      <div style="font-family:var(--font-sans); font-size:24px; color:rgba(2,37,68,0.55);
                  letter-spacing:0.14em; text-transform:uppercase; font-weight:500;">
        Company · YYYY · &nbsp;Deck type
      </div>
    </div>
  </div>
</section>
```

**Design notes:**
- No eyebrow, no page-number footer on the title slide.
- The italicized phrase should be the **emotional payoff** of the title, not the subject. ("From bank data to *financial intelligence.*", not "*From* bank data to financial intelligence.")
- Padding-top is intentionally inflated to 140px to push the headline to the optical center.

---

## T2 — Section divider

**When to use:** between major sections of a long deck. Gives the audience a "here's where we are" beat. Use sparingly — 3–5 section dividers in a 20-slide deck.

**Layout:**
- `.holo` background, or solid mint (`#42F0CD`) with dark text
- Giant Bowery Street numeral (200–280px) as a graphic element
- Section name as a 60–80px headline
- One-sentence orienting paragraph

**Skeleton:**

```html
<section class="holo" data-label="NN Section X">
  <div class="frame" style="justify-content:center; align-items:flex-start;">
    <img class="chrome-logo" src="assets/logos/plaid-horizontal-dark.png" alt="" />

    <div style="display:flex; align-items:baseline; gap:48px;">
      <div style="font-family:var(--font-display); font-weight:500; font-size:280px;
                  line-height:0.85; color:var(--plaid-blue-600); letter-spacing:-0.03em;">
        02
      </div>
      <div style="max-width:1100px;">
        <div style="font-family:var(--font-mono); font-size:24px; color:var(--plaid-blue-700);
                    letter-spacing:0.18em; text-transform:uppercase; margin-bottom:20px;">
          Section
        </div>
        <h2 style="font-family:var(--font-display); font-weight:500; font-size:96px;
                   line-height:1.0; letter-spacing:-0.025em; margin:0 0 32px;">
          Section name<br/>
          with <em style="font-style:italic; font-weight:400;">italic accent.</em>
        </h2>
        <p style="font-family:var(--font-sans); font-size:30px; line-height:1.4;
                  color:rgba(2,37,68,0.78); margin:0;">
          One sentence that orients the audience to what's coming next.
        </p>
      </div>
    </div>
  </div>
</section>
```

---

## T3 — Statement slide

**When to use:** a single big idea that deserves its own slide. The thesis statement, a definition, a quote you want to land hard.

**Layout:**
- Dark navy background, lots of empty space
- Eyebrow tag
- One large statement in Bowery Street 500, 84–120px, italic on the operative phrase
- Optional small attribution / source line below

**Skeleton:**

```html
<section data-label="NN Statement">
  <div class="frame" style="justify-content:center;">
    <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt="" />
    <div class="eyebrow-tag" style="margin-top:24px;">Section X — Section name</div>

    <h2 style="font-family:var(--font-display); font-weight:500; font-size:96px;
               line-height:1.1; letter-spacing:-0.022em; color:white; max-width:1600px; margin:0;">
      A single thesis statement that defines the<br/>
      <em style="font-style:italic; font-weight:400; color:var(--plaid-teal-500);">
        whole argument
      </em> in one sentence.
    </h2>

    <div style="margin-top:64px; font-family:var(--font-mono); font-size:24px;
                color:rgba(255,255,255,0.55); letter-spacing:0.08em;">
      — Optional attribution or source
    </div>

    <div class="chrome-foot">
      <span>NN / TOTAL &nbsp;·&nbsp; Section name</span>
    </div>
  </div>
</section>
```

---

## T4 — Big-number trio

**When to use:** three related stats that together tell a story. Lift / depth / breadth. Speed / cost / quality. Past / present / future.

**Layout:**
- Eyebrow + headline at top (max 1500px wide)
- Three equal-flex cards below, gap 32px
- Each card: mono eyebrow → giant Bowery Street number → body paragraph → small caption
- Middle card uses the accent treatment to indicate "the one you really care about"

**Skeleton:**

```html
<section data-label="NN Big numbers">
  <div class="frame">
    <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt="" />
    <div class="eyebrow-tag" style="margin-top:24px;">Section X — Section name</div>

    <h2 class="h-title">
      Headline. <span style="color:rgba(255,255,255,0.55);">Subhead in the same line.</span>
    </h2>

    <div style="display:flex; gap:32px; flex:1; min-height:0; align-items:stretch;">

      <!-- Card 1 (default) -->
      <div style="flex:1; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1);
                  border-radius:18px; padding:48px 44px; display:flex; flex-direction:column;
                  justify-content:space-between;">
        <div style="font-family:var(--font-mono); font-size:24px; color:var(--plaid-teal-500);
                    letter-spacing:0.16em; text-transform:uppercase;">
          Eyebrow
        </div>
        <div style="font-family:var(--font-display); font-weight:500; font-size:200px;
                    line-height:0.9; color:white; letter-spacing:-0.03em;">
          +10<span style="font-size:90px;">%</span>
        </div>
        <div>
          <p style="font-family:var(--font-sans); font-size:24px; margin:0;">
            One-sentence explanation of what this number is.
          </p>
          <p style="font-family:var(--font-sans); font-size:24px; color:rgba(255,255,255,0.55);
                    margin:8px 0 0;">
            Tiny caption / source.
          </p>
        </div>
      </div>

      <!-- Card 2 (accent — the highlighted one) -->
      <div style="flex:1; background:linear-gradient(160deg, rgba(66,240,205,0.14), rgba(11,123,188,0.06));
                  border:1px solid rgba(66,240,205,0.28); border-radius:18px; padding:48px 44px;
                  display:flex; flex-direction:column; justify-content:space-between;">
        <div style="font-family:var(--font-mono); font-size:24px; color:var(--plaid-teal-500);
                    letter-spacing:0.16em; text-transform:uppercase;">
          Eyebrow
        </div>
        <div style="font-family:var(--font-display); font-weight:500; font-size:200px;
                    line-height:0.9; color:var(--plaid-teal-500); letter-spacing:-0.03em;">
          +20<span style="font-size:90px;">%</span>
        </div>
        <div>
          <p style="font-family:var(--font-sans); font-size:24px; margin:0;">
            One-sentence explanation.
          </p>
          <p style="font-family:var(--font-sans); font-size:24px; color:rgba(255,255,255,0.55);
                    margin:8px 0 0;">
            Tiny caption.
          </p>
        </div>
      </div>

      <!-- Card 3 (default) -->
      <div style="flex:1; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1);
                  border-radius:18px; padding:48px 44px; display:flex; flex-direction:column;
                  justify-content:space-between;">
        <div style="font-family:var(--font-mono); font-size:24px; color:var(--plaid-teal-500);
                    letter-spacing:0.16em; text-transform:uppercase;">
          Eyebrow
        </div>
        <div style="font-family:var(--font-display); font-weight:500; font-size:200px;
                    line-height:0.9; color:white; letter-spacing:-0.03em;">
          12<span style="font-size:90px;">+</span>
        </div>
        <div>
          <p style="font-family:var(--font-sans); font-size:24px; margin:0;">
            One-sentence explanation.
          </p>
          <p style="font-family:var(--font-sans); font-size:24px; color:rgba(255,255,255,0.55);
                    margin:8px 0 0;">
            Tiny caption.
          </p>
        </div>
      </div>
    </div>

    <p style="font-family:var(--font-sans); font-size:26px; color:rgba(255,255,255,0.72);
              max-width:1500px; margin-top:36px;">
      Optional footer sentence that frames how to read the three numbers together.
    </p>

    <div class="chrome-foot"><span>NN / TOTAL &nbsp;·&nbsp; Section name</span></div>
  </div>
</section>
```

**Variants:**
- Two-up (split into two cards, more text in each)
- Five-up (smaller numbers, more rows of supporting text — see T5)

---

## T5 — Three-column body

**When to use:** parallel content that doesn't deserve hero numbers. "Three reasons," "three pillars," "three audiences."

**Layout:**
- Eyebrow + headline
- Three columns separated only by `gap`, divided from the headline by a top border
- Each column: numbered mono eyebrow → body paragraph
- Optional bottom strip (timeline, footer summary)

**Skeleton:**

```html
<section data-label="NN Three columns">
  <div class="frame">
    <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt="" />
    <div class="eyebrow-tag" style="margin-top:24px;">Section X — Section name</div>

    <h2 class="h-title">
      Three-part declarative headline.
    </h2>

    <div style="display:flex; gap:48px;">
      <div style="flex:1; display:flex; flex-direction:column; gap:24px;
                  padding:40px 40px 40px 0; border-top:1px solid rgba(255,255,255,0.18);">
        <div style="font-family:var(--font-mono); font-size:24px; color:var(--plaid-teal-500);
                    letter-spacing:0.16em; text-transform:uppercase;">01 — Label</div>
        <p style="font-family:var(--font-sans); font-size:30px; line-height:1.42; color:rgba(255,255,255,0.84);
                  margin:0;">Paragraph one.</p>
      </div>
      <div style="flex:1; display:flex; flex-direction:column; gap:24px;
                  padding:40px 40px 40px 0; border-top:1px solid rgba(255,255,255,0.18);">
        <div style="font-family:var(--font-mono); font-size:24px; color:var(--plaid-teal-500);
                    letter-spacing:0.16em; text-transform:uppercase;">02 — Label</div>
        <p style="font-family:var(--font-sans); font-size:30px; line-height:1.42; color:rgba(255,255,255,0.84);
                  margin:0;">Paragraph two.</p>
      </div>
      <div style="flex:1; display:flex; flex-direction:column; gap:24px;
                  padding:40px 40px 40px 0; border-top:1px solid rgba(255,255,255,0.18);">
        <div style="font-family:var(--font-mono); font-size:24px; color:var(--plaid-teal-500);
                    letter-spacing:0.16em; text-transform:uppercase;">03 — Label</div>
        <p style="font-family:var(--font-sans); font-size:30px; line-height:1.42; color:rgba(255,255,255,0.84);
                  margin:0;">Paragraph three.</p>
      </div>
    </div>

    <!-- Optional bottom strip: timeline, summary, etc. -->
    <div style="margin-top:auto; padding-top:48px;">
      <!-- e.g. a timeline, a summary callout, related metrics -->
    </div>

    <div class="chrome-foot"><span>NN / TOTAL &nbsp;·&nbsp; Section name</span></div>
  </div>
</section>
```

---

## T6 — Before / after split

**When to use:** showing transformation. Raw → enriched. Old way → new way. Manual → automated.

**Layout:**
- Top bar with eyebrow + label
- Headline with the "after" framing
- Two big panels side-by-side, separated by a center arrow column with a pill label
- Left panel: dark "before" with raw monospace evidence
- Right panel: white card with structured "after" output
- Bottom strip with one-line summary

**Skeleton:**

```html
<section data-label="NN Before / after">
  <div class="frame" style="padding:80px 100px 80px;">
    <div style="display:flex; align-items:baseline; gap:24px;">
      <img src="assets/logos/plaid-horizontal-white.png" alt="" style="height:24px; opacity:0.85;" />
      <span style="font-family:var(--font-mono); font-size:24px; color:rgba(255,255,255,0.5);
                   letter-spacing:0.16em; text-transform:uppercase;">Example — Topic</span>
    </div>

    <h2 class="h-title" style="margin-top:24px; margin-bottom:40px; font-size:64px;">
      <span style="color:rgba(255,255,255,0.55);">What looks like X</span><br/>
      is actually Y.
    </h2>

    <div style="display:flex; gap:32px; flex:1; min-height:0; align-items:stretch;">

      <!-- LEFT: raw / before -->
      <div style="flex:1; background:rgba(0,0,0,0.32); border:1px solid rgba(255,255,255,0.1);
                  border-radius:14px; padding:40px;">
        <div style="font-family:var(--font-mono); font-size:24px; color:rgba(255,255,255,0.45);
                    letter-spacing:0.14em; text-transform:uppercase; margin-bottom:32px;">
          Raw input
        </div>
        <div style="font-family:var(--font-mono); font-size:38px; color:white; line-height:1.35;">
          RAW_BEFORE_VALUE
        </div>
      </div>

      <!-- Center arrow column -->
      <div style="display:flex; flex-direction:column; justify-content:center; align-items:center;
                  width:64px; gap:12px;">
        <span style="display:inline-flex; align-items:center; height:36px; padding:0 16px;
                     border-radius:999px; background:rgba(66,240,205,0.14); color:var(--plaid-teal-500);
                     font-family:var(--font-sans); font-size:18px; font-weight:600;
                     letter-spacing:0.08em; text-transform:uppercase;">Transform</span>
        <svg width="60" height="60" viewBox="0 0 60 60" fill="none">
          <path d="M10 30 L48 30 M38 18 L50 30 L38 42" stroke="#42F0CD" stroke-width="2.5"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>

      <!-- RIGHT: structured / after -->
      <div style="flex:1.15; background:white; color:var(--plaid-ink-900); border-radius:14px;
                  padding:36px 40px;">
        <!-- Whatever structured output card markup looks like -->
        <div style="font-family:var(--font-mono); font-size:24px;">structured.fields = "here";</div>
      </div>
    </div>

    <div style="margin-top:36px; font-family:var(--font-sans); font-size:32px; color:white;">
      Closer sentence. <span style="color:var(--plaid-teal-500);">Punchline.</span>
    </div>
  </div>
</section>
```

---

## T7 — Comparison table

**When to use:** the "what you're really choosing" slide. Decision frame. Old way vs. new way listed line-by-line.

**Layout:**
- Eyebrow + headline
- Header row: muted-mono on left, mint-mono on right
- 3–5 rows, each: muted body on left, mint arrow center, white body on right
- Last row uses a horizontal mint gradient highlight + larger right-column type to land the punchline

**Skeleton:**

```html
<section data-label="NN Decision frame">
  <div class="frame">
    <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt="" />
    <div class="eyebrow-tag" style="margin-top:24px;">Section X — Close</div>

    <h2 class="h-title" style="font-size:78px;">
      What you're <em style="font-family:var(--font-display); font-weight:400; font-style:italic;">really</em> choosing.
    </h2>

    <div style="flex:1; min-height:0; display:flex; flex-direction:column;">
      <!-- Header -->
      <div style="display:flex; border-bottom:1px solid rgba(255,255,255,0.2); padding-bottom:16px;">
        <div style="flex:1; padding-right:24px; font-family:var(--font-mono); font-size:24px;
                    color:rgba(255,255,255,0.55); letter-spacing:0.14em; text-transform:uppercase;">
          Old way header
        </div>
        <div style="width:64px;"></div>
        <div style="flex:1; padding-left:24px; font-family:var(--font-mono); font-size:24px;
                    color:var(--plaid-teal-500); letter-spacing:0.14em; text-transform:uppercase;">
          New way header
        </div>
      </div>

      <!-- Rows -->
      <div style="flex:1; display:flex; flex-direction:column; justify-content:space-around; padding:8px 0;">
        <!-- Standard row -->
        <div style="display:flex; align-items:center; padding:18px 0;
                    border-bottom:1px solid rgba(255,255,255,0.08);">
          <div style="flex:1; padding-right:24px;">
            <p style="font-size:26px; color:rgba(255,255,255,0.7); margin:0;">Old-way statement.</p>
          </div>
          <div style="width:64px; text-align:center; color:var(--plaid-teal-500);
                      font-family:var(--font-mono); font-size:22px;">→</div>
          <div style="flex:1; padding-left:24px;">
            <p style="font-size:26px; color:white; font-weight:500; margin:0;">New-way statement.</p>
          </div>
        </div>

        <!-- ... repeat 2–4 standard rows ... -->

        <!-- Highlighted final row -->
        <div style="display:flex; align-items:center; padding:18px 0;
                    background:linear-gradient(90deg, transparent, rgba(66,240,205,0.06), transparent);">
          <div style="flex:1; padding-right:24px;">
            <p style="font-size:26px; color:rgba(255,255,255,0.7); margin:0;">Old-way punchline.</p>
          </div>
          <div style="width:64px; text-align:center; color:var(--plaid-teal-500);
                      font-family:var(--font-mono); font-size:22px;">→</div>
          <div style="flex:1; padding-left:24px;">
            <p style="font-size:30px; color:var(--plaid-teal-500); font-weight:600;
                      line-height:1.2; margin:0;">New-way punchline.</p>
          </div>
        </div>
      </div>
    </div>

    <div class="chrome-foot"><span>NN / TOTAL &nbsp;·&nbsp; Close</span></div>
  </div>
</section>
```

---

## T8 — Step flow (process / evolution)

**When to use:** sequential narrative. Three steps of a workflow, three stages of evolution, three layers of a stack.

**Layout:**
- Eyebrow + headline
- Three cards in a row, separated by mint `→` arrows
- Each card has a giant Bowery Street numeral (60–96px, mint at 40% opacity) at top-left
- Sans 600 subhead → mono eyebrow → body → optional mini-viz at bottom
- Optional big stat callout below the row

**Skeleton:**

```html
<section data-label="NN Step flow">
  <div class="frame">
    <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt="" />
    <div class="eyebrow-tag" style="margin-top:24px;">Section X — Section name</div>

    <h2 class="h-title">
      Step-flow headline. <span style="color:rgba(255,255,255,0.55);">Optional subhead.</span>
    </h2>

    <div style="display:flex; gap:24px; flex:1; min-height:0; align-items:stretch;">
      <!-- Step 1 -->
      <div style="flex:1; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1);
                  border-radius:16px; padding:36px 32px; display:flex; flex-direction:column; gap:20px;">
        <div style="font-family:var(--font-display); font-weight:500; font-size:72px;
                    color:rgba(66,240,205,0.4); line-height:1;">01</div>
        <div>
          <div style="font-family:var(--font-sans); font-weight:600; font-size:30px; color:white;">Step name</div>
          <div style="font-family:var(--font-mono); font-size:24px; color:var(--plaid-teal-500);
                      letter-spacing:0.12em; text-transform:uppercase; margin-top:8px;">Mono label</div>
        </div>
        <p style="font-family:var(--font-sans); font-size:22px; margin:0;">
          What happens in this step.
        </p>
        <!-- Optional mini-viz at bottom -->
      </div>

      <!-- Arrow -->
      <div style="align-self:center; color:rgba(66,240,205,0.6); font-size:32px;">→</div>

      <!-- Step 2 -->
      <div style="flex:1; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1);
                  border-radius:16px; padding:36px 32px; display:flex; flex-direction:column; gap:20px;">
        <!-- repeat structure -->
      </div>

      <div style="align-self:center; color:rgba(66,240,205,0.6); font-size:32px;">→</div>

      <!-- Step 3 -->
      <div style="flex:1; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1);
                  border-radius:16px; padding:36px 32px; display:flex; flex-direction:column; gap:20px;">
        <!-- repeat -->
      </div>
    </div>

    <!-- Optional big stat callout -->
    <div style="margin-top:40px; display:flex; align-items:baseline; gap:24px;">
      <div style="font-family:var(--font-display); font-weight:500; font-size:120px;
                  color:var(--plaid-teal-500); line-height:0.9; letter-spacing:-0.03em;">
        >95<span style="font-size:60px;">%</span>
      </div>
      <p style="font-family:var(--font-sans); font-size:28px; color:white; max-width:900px; margin:0;">
        Closing stat that quantifies the outcome of the flow.
      </p>
    </div>

    <div class="chrome-foot"><span>NN / TOTAL &nbsp;·&nbsp; Section name</span></div>
  </div>
</section>
```

---

## T9 — Architecture diagram

**When to use:** "one thing on top, many things below it." Foundation models, platforms, shared services, downstream effects.

**Layout:**
- Eyebrow + headline
- One block at the top (gradient blue→teal, 780px min-width, centered)
- SVG spine connecting top block to N cards below with arrowheads
- Row of 3–5 capability cards (each: mono eyebrow, sans 600 name, small caption)
- Optional footer takeaway sub

**Skeleton:**

```html
<section data-label="NN Architecture">
  <div class="frame" style="padding-top:72px; padding-bottom:64px;">
    <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt="" />
    <div class="eyebrow-tag" style="margin-top:24px;">Section X — Section name</div>

    <h2 class="h-title" style="font-size:60px;">
      One shared X. <span style="color:rgba(255,255,255,0.55);">N focused capabilities.</span>
    </h2>

    <div style="flex:1; min-height:0; display:flex; flex-direction:column; align-items:center; justify-content:center;">

      <!-- Top block -->
      <div style="background:linear-gradient(135deg, #07578D, #0B7BBC 50%, #42F0CD);
                  border-radius:18px; padding:32px 56px; box-shadow:0 16px 48px rgba(66,240,205,0.18);
                  min-width:780px; text-align:center;">
        <div style="font-family:var(--font-mono); font-size:24px; color:rgba(255,255,255,0.78);
                    letter-spacing:0.16em; text-transform:uppercase; margin-bottom:10px;">
          Core infrastructure
        </div>
        <div style="font-family:var(--font-sans); font-weight:600; font-size:40px; color:white;
                    letter-spacing:-0.01em;">
          Foundation name
        </div>
        <div style="font-family:var(--font-sans); font-size:24px; color:rgba(255,255,255,0.85); margin-top:6px;">
          One-line description.
        </div>
      </div>

      <!-- SVG spine connecting top to bottom -->
      <svg width="1400" height="160" viewBox="0 0 1400 160" style="margin-top:-2px;">
        <path d="M 700 0 L 700 60" stroke="rgba(66,240,205,0.55)" stroke-width="2" />
        <path d="M 140 60 L 1260 60" stroke="rgba(66,240,205,0.35)" stroke-width="2" />
        <path d="M 140 60 L 140 140" stroke="rgba(66,240,205,0.35)" stroke-width="2" />
        <path d="M 420 60 L 420 140" stroke="rgba(66,240,205,0.35)" stroke-width="2" />
        <path d="M 700 60 L 700 140" stroke="rgba(66,240,205,0.55)" stroke-width="2" />
        <path d="M 980 60 L 980 140" stroke="rgba(66,240,205,0.35)" stroke-width="2" />
        <path d="M 1260 60 L 1260 140" stroke="rgba(66,240,205,0.35)" stroke-width="2" />
        <g fill="rgba(66,240,205,0.55)">
          <polygon points="140,148 134,138 146,138" />
          <polygon points="420,148 414,138 426,138" />
          <polygon points="700,148 694,138 706,138" />
          <polygon points="980,148 974,138 986,138" />
          <polygon points="1260,148 1254,138 1266,138" />
        </g>
      </svg>

      <!-- Capability cards -->
      <div style="display:flex; gap:24px; width:1400px; justify-content:space-between; margin-top:-12px;">
        <div style="flex:1; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.12);
                    border-radius:14px; padding:24px 22px; display:flex; flex-direction:column; gap:8px;">
          <div style="font-family:var(--font-mono); font-size:24px; color:var(--plaid-teal-500);
                      letter-spacing:0.14em; text-transform:uppercase;">Label</div>
          <div style="font-family:var(--font-sans); font-weight:600; font-size:22px; color:white;">Name</div>
          <div style="font-family:var(--font-sans); font-size:24px; color:rgba(255,255,255,0.65);
                      line-height:1.4;">Caption.</div>
        </div>
        <!-- repeat 4 more times -->
      </div>
    </div>

    <p style="font-family:var(--font-sans); font-size:26px; color:rgba(255,255,255,0.78);
              max-width:1300px; margin-top:auto;">
      Footer takeaway sub. <em style="font-family:var(--font-display); font-weight:400; font-style:italic;
                                     color:var(--plaid-teal-500);">Italicized punchline.</em>
    </p>

    <div class="chrome-foot"><span>NN / TOTAL &nbsp;·&nbsp; Section name</span></div>
  </div>
</section>
```

---

## T10 — Customer proof

**When to use:** the customer story that anchors the deck. One marquee customer, deep — not five customers shallow.

**Layout:**
- `.light` (white) or `.cream` background for a warm interlude
- Eyebrow + headline framing the customer name + the arc
- Two-column body:
  - **Left (flex 1.35):** the story (a 3-stage arc card) + a row of 3–4 stat callouts
  - **Right (flex 1):** dark navy pull-quote card with attribution
- Bottom: "Also building on this" logo strip with 4–5 secondary customer names

**Skeleton:**

```html
<section class="light" data-label="NN Customer story">
  <div class="frame" style="padding:80px 100px 80px;">
    <img class="chrome-logo" src="assets/logos/plaid-horizontal-dark.png" alt="" />
    <div class="eyebrow-tag" style="margin-top:24px;">Section X — Proof</div>

    <h2 class="h-title" style="color:var(--plaid-ink-900); font-size:72px;">
      Customer name <em style="font-family:var(--font-display); font-weight:400; font-style:italic;
                              color:var(--plaid-blue-600);">arc verb.</em>
    </h2>
    <p style="font-family:var(--font-sans); color:rgba(2,37,68,0.72); font-size:26px;
              max-width:1500px; margin:-24px 0 32px;">
      Who they are, what they built, and what makes them the right proof point.
    </p>

    <div style="display:flex; gap:48px; flex:1; min-height:0; align-items:stretch;">

      <!-- LEFT: arc + stats -->
      <div style="flex:1.35; display:flex; flex-direction:column; gap:28px;">

        <!-- 3-stage arc card -->
        <div style="background:white; border-radius:16px; padding:32px 36px; gap:24px;
                    display:flex; flex-direction:column; box-shadow:0 6px 20px rgba(2,37,68,0.06);">
          <div style="font-family:var(--font-mono); font-size:24px; color:var(--plaid-blue-700);
                      letter-spacing:0.14em; text-transform:uppercase; font-weight:600;">
            The customer arc
          </div>
          <div style="display:flex; gap:18px; align-items:stretch;">
            <!-- Stage 1: gray bg -->
            <div style="flex:1; padding:18px; background:#F2F2F2; border-radius:10px;
                        display:flex; flex-direction:column; gap:10px;">
              <div style="font-family:var(--font-display); font-weight:500; font-size:52px;
                          color:var(--plaid-blue-600); line-height:0.95;">01</div>
              <div style="font-family:var(--font-sans); font-weight:600; font-size:24px;">Stage name</div>
              <div style="font-family:var(--font-sans); font-size:24px; color:rgba(2,37,68,0.7); line-height:1.45;">
                What happened.
              </div>
            </div>
            <div style="display:flex; align-items:center; color:var(--plaid-blue-600);
                        font-family:var(--font-mono); font-size:24px;">→</div>
            <!-- Stage 2: gray bg -->
            <div style="flex:1; padding:18px; background:#F2F2F2; border-radius:10px;
                        display:flex; flex-direction:column; gap:10px;">
              <!-- same structure -->
            </div>
            <div style="display:flex; align-items:center; color:var(--plaid-blue-600);
                        font-family:var(--font-mono); font-size:24px;">→</div>
            <!-- Stage 3: holo bg — present state -->
            <div style="flex:1; padding:18px;
                        background:linear-gradient(135deg, #E6E6FF, #D8FEF3);
                        border-radius:10px; display:flex; flex-direction:column; gap:10px;">
              <!-- same structure -->
            </div>
          </div>
          <p style="font-family:var(--font-sans); font-size:24px; color:rgba(2,37,68,0.55);
                    padding-top:6px; border-top:1px dashed rgba(2,37,68,0.18); margin:0;">
            Optional summary line.
          </p>
        </div>

        <!-- Stat callouts row -->
        <div style="display:flex; gap:16px;">
          <div style="flex:1; background:white; border-radius:12px; padding:22px 20px;
                      display:flex; flex-direction:column; gap:6px;
                      box-shadow:0 4px 14px rgba(2,37,68,0.05);">
            <div style="font-family:var(--font-display); font-weight:500; font-size:48px;
                        color:var(--plaid-ink-900); line-height:1; letter-spacing:-0.02em;">$X</div>
            <div style="font-family:var(--font-sans); font-size:24px; color:rgba(2,37,68,0.65);">caption</div>
          </div>
          <!-- repeat for 3–4 stats. Final one uses accent treatment. -->
        </div>
      </div>

      <!-- RIGHT: pull quote -->
      <div style="flex:1; background:var(--plaid-ink-900); color:white; border-radius:16px;
                  padding:40px 40px; display:flex; flex-direction:column; gap:20px;
                  position:relative; overflow:hidden;">
        <div style="position:absolute; right:-60px; bottom:-60px; width:240px; height:240px;
                    background:linear-gradient(135deg, rgba(152,165,255,0.25), rgba(66,240,205,0.18));
                    border-radius:50%; pointer-events:none;"></div>

        <div style="font-family:var(--font-display); font-weight:500; font-size:120px;
                    color:var(--plaid-teal-500); line-height:0.7; opacity:0.85;">"</div>

        <p style="font-family:var(--font-display); font-weight:400; font-style:italic;
                  font-size:27px; color:white; line-height:1.32; position:relative; margin:0;">
          The full pull quote from the customer, with the most powerful clause
          <span style="color:var(--plaid-teal-500);">highlighted in mint.</span>
        </p>

        <div style="margin-top:auto; padding-top:24px; border-top:1px solid rgba(255,255,255,0.18);
                    display:flex; align-items:center; gap:18px; position:relative;">
          <div style="width:52px; height:52px; border-radius:50%;
                      background:linear-gradient(135deg, #E6E6FF, #D8FEF3);
                      display:flex; align-items:center; justify-content:center;
                      color:#022544; font-family:var(--font-sans); font-weight:700; font-size:22px;">
            XX
          </div>
          <div>
            <div style="font-family:var(--font-sans); font-weight:600; font-size:24px; color:white;">Full Name</div>
            <div style="font-family:var(--font-mono); font-size:24px; color:rgba(255,255,255,0.6);">Title · Company</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Logo strip -->
    <div style="margin-top:40px; padding-top:24px; border-top:1px solid rgba(2,37,68,0.14);
                display:flex; align-items:center; justify-content:space-between; gap:32px;">
      <div style="font-family:var(--font-mono); font-size:24px; color:rgba(2,37,68,0.6);
                  letter-spacing:0.12em; text-transform:uppercase; font-weight:600;">
        Also building on this
      </div>
      <div style="display:flex; gap:48px; align-items:center;">
        <span style="font-family:var(--font-display); font-weight:500; font-size:34px;
                     color:rgba(2,37,68,0.78);">Logo A</span>
        <span style="font-family:var(--font-display); font-weight:500; font-size:34px;
                     color:rgba(2,37,68,0.78);">Logo B</span>
        <span style="font-family:var(--font-display); font-weight:500; font-size:34px;
                     color:rgba(2,37,68,0.78);">Logo C</span>
      </div>
    </div>

    <div class="chrome-foot" style="color:rgba(2,37,68,0.5);">
      <span>NN / TOTAL &nbsp;·&nbsp; Proof</span>
    </div>
  </div>
</section>
```

---

## T11 — CTA / next steps

**When to use:** the closing slide. Three audience segments with different next actions.

**Layout:**
- `.holo` background
- Massive Bowery Street headline ("Let's get *specific.*")
- Three side-by-side action cards, alternating white / dark / white treatment
- Each card: mono "if you are..." eyebrow → action verb headline → body explaining the next step → small footer detail (code snippet, pills, timeline)
- Bottom contact strip with attribution

**Skeleton:**

```html
<section class="holo" data-label="NN Next steps">
  <div class="frame">
    <img class="chrome-logo" src="assets/logos/plaid-horizontal-dark.png" alt="" />
    <div class="eyebrow-tag" style="margin-top:24px; color:var(--plaid-blue-700);">Section X — Next steps</div>

    <h2 style="font-family:var(--font-display); font-weight:500; font-size:140px;
               line-height:0.95; letter-spacing:-0.025em; color:var(--plaid-ink-900); margin:0;">
      Let's get<br/>
      <em style="font-style:italic; font-weight:400;">specific.</em>
    </h2>

    <div style="display:flex; gap:24px; flex:1; min-height:0; align-items:stretch;">

      <!-- White card -->
      <div style="flex:1; background:white; border-radius:16px; padding:36px 32px;
                  display:flex; flex-direction:column; gap:18px;
                  box-shadow:0 20px 60px rgba(2,37,68,0.10);">
        <div style="font-family:var(--font-mono); font-size:24px; color:var(--plaid-blue-700);
                    letter-spacing:0.14em; text-transform:uppercase; font-weight:600;">
          If you are X
        </div>
        <div style="font-family:var(--font-sans); font-weight:600; font-size:32px;
                    color:var(--plaid-ink-900); line-height:1.15;">
          Action verb.
        </div>
        <p style="font-family:var(--font-sans); font-size:24px; color:rgba(2,37,68,0.78); margin:0;">
          What we'll do together. Time commitment. Outcome.
        </p>
        <div style="margin-top:auto;">
          <!-- Optional footer detail: code snippet, pills, icon row -->
        </div>
      </div>

      <!-- Dark navy card -->
      <div style="flex:1; background:#022544; color:white; border-radius:16px; padding:36px 32px;
                  display:flex; flex-direction:column; gap:18px;
                  box-shadow:0 20px 60px rgba(2,37,68,0.20);">
        <!-- same structure, but use teal eyebrow / white body / mint pills -->
      </div>

      <!-- Second white card -->
      <div style="flex:1; background:white; border-radius:16px; padding:36px 32px;
                  display:flex; flex-direction:column; gap:18px;
                  box-shadow:0 20px 60px rgba(2,37,68,0.10);">
        <!-- repeat -->
      </div>
    </div>

    <!-- Footer strip -->
    <div style="margin-top:32px; display:flex; justify-content:space-between; align-items:flex-end;
                padding-top:24px; border-top:1px solid rgba(2,37,68,0.18);">
      <div>
        <div style="font-family:var(--font-mono); font-size:24px; color:rgba(2,37,68,0.55);
                    letter-spacing:0.14em; text-transform:uppercase;">Contact</div>
        <div style="font-family:var(--font-sans); font-weight:500; font-size:24px;
                    color:var(--plaid-ink-900); margin-top:6px;">
          Your contact &nbsp;·&nbsp; <span style="font-family:var(--font-mono);">your@email.com</span>
        </div>
      </div>
      <div style="font-family:var(--font-mono); font-size:24px; color:rgba(2,37,68,0.55);
                  text-align:right; line-height:1.6;">
        Three key callbacks from the deck<br/>
        <em>—the takeaway.</em>
      </div>
    </div>

    <div class="chrome-foot" style="color:rgba(2,37,68,0.55);"><span>NN / TOTAL &nbsp;·&nbsp; Next steps</span></div>
  </div>
</section>
```

---

**Continue to:** `DECK_COMPOSITION.md` (how to choose and sequence templates, write headlines, add speaker notes).
