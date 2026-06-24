#!/usr/bin/env node
/**
 * QA harness: compare the Brandfetch API logo path vs the site-crop fallback,
 * exercising the REAL brand-extract functions. For each {name, url} it:
 *   A. Brandfetch API → best logo URL → localizeLogoFromUrl (render+measure)
 *   B. Site crop (extractLogoCropFromSite)
 * and reports dimensions + classification + a recommendation for each.
 *
 * Usage: node scripts/scratch/qa-brand-logo-compare.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const be = require('./scratch/brand-extract');

const OUT = '/tmp/brand-logo-qa';
fs.mkdirSync(OUT, { recursive: true });

const BRANDS = [
  { name: 'Citi', url: 'https://www.citi.com' },
  { name: 'Cox Automotive', url: 'https://www.coxautoinc.com' },
  { name: 'Credit Genie', url: 'https://www.creditgenie.com' },
  { name: 'Current', url: 'https://current.com' },
  { name: 'KeyBank', url: 'https://www.key.com' },
  { name: 'YNAB', url: 'https://www.ynab.com' },
];

function fileKb(p) { try { return Math.round(fs.statSync(p).size / 102.4) / 10; } catch { return 0; } }

(async () => {
  console.log('=== Brand logo QA: Brandfetch-localize vs site-crop ===\n');
  for (const b of BRANDS) {
    const slug = b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const domain = new URL(b.url).hostname.replace(/^www\./, '');
    console.log(`### ${b.name}  (${domain})`);

    // A. Brandfetch API → localize
    let bfLine = '  A. Brandfetch: ';
    try {
      const data = await be.fetchFromBrandfetch(domain);
      if (!data) { bfLine += 'no data'; }
      else {
        const raw = be.brandfetchToRaw(data);
        const url = raw.logoImageUrl || raw.iconImageUrl;
        if (!url) { bfLine += `found "${data.name}" but NO logo URL`; }
        else {
          const out = path.join(OUT, `${slug}-bf.png`);
          const loc = await be.localizeLogoFromUrl(url, out);
          if (loc.ok) {
            const c = be.classifyLogoKind(loc.w, loc.h);
            bfLine += `OK ${loc.w}×${loc.h} aspect=${c.aspect} kind=${c.kind} (${fileKb(out)}KB)`;
          } else { bfLine += `logo URL present but localize FAILED (${url.slice(0, 60)}…)`; }
        }
      }
    } catch (e) { bfLine += `ERROR ${e.message}`; }
    console.log(bfLine);

    // B. Site crop
    let crLine = '  B. Site-crop: ';
    try {
      const out = path.join(OUT, `${slug}-crop.png`);
      const res = await be.extractLogoCropFromSite(b.url, out);
      if (res.ok) {
        const c = res.w && res.h ? be.classifyLogoKind(res.w, res.h) : { kind: '?', aspect: '?' };
        crLine += `OK ${res.w || '?'}×${res.h || '?'} aspect=${c.aspect} kind=${c.kind} via=${res.method} (${fileKb(out)}KB)`;
      } else { crLine += `FAILED (${res.method})`; }
    } catch (e) { crLine += `ERROR ${e.message}`; }
    console.log(crLine);
    console.log('');
  }
  console.log(`Artifacts in ${OUT}/ (open the PNGs to eyeball quality).`);
})();
