'use strict';
/**
 * slide-library-uploads.js
 *
 * Helpers for the dashboard's "Slide Templates" subtab. Keeps the file-system
 * touchy bits (image MIME detection, wrapper-HTML generation, delete + rename)
 * isolated from server.js so they're unit-testable as pure functions where
 * possible.
 *
 * Conventions (kept in lockstep with the existing slide-library code in
 * server.js):
 *   - Index file:  out/slide-library/index.json
 *   - Slide files: out/slide-library/slides/<slideId>.html      (always)
 *                  out/slide-library/slides/<slideId>.<imgExt>  (image kind)
 *   - Index entries gain `kind` ('html' | 'image') and `source`
 *     ('builtin' | 'submit' | 'upload') for the new subtab to discriminate.
 *     Entries written by older code paths default to `kind: 'html'`,
 *     `source: 'builtin'` when read.
 */

const path = require('path');

// ── Image MIME / extension support ──────────────────────────────────────────

/**
 * Image extensions accepted by the upload endpoint, mapped to the MIME type
 * we encode them with in the wrapper HTML's `<img>` data URL fallback OR the
 * `Content-Type` we serve when the dashboard streams the raw image back.
 *
 * Stays a small, allow-list set so we never accept arbitrary binaries
 * (e.g. .exe, .svg-with-script, .gif-bomb edge cases).
 */
const IMAGE_EXT_TO_MIME = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
});

const ALLOWED_IMAGE_MIMES = Object.freeze(
  new Set(Object.values(IMAGE_EXT_TO_MIME))
);

function normalizeFilename(name) {
  return String(name || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

/**
 * Pick a safe image extension from either the original filename or the MIME
 * type. Returns one of `IMAGE_EXT_TO_MIME` keys, or `null` if neither input
 * resolves to a supported type.
 *
 * Prefers MIME first (clients sometimes pass a generic `.bin` filename), then
 * falls back to the filename extension. Never returns `.svg` — SVG can carry
 * `<script>` and is an XSS hazard for a slide library that the AI editor
 * later rewrites.
 */
function pickImageExt({ filename, mimeType }) {
  const mt = String(mimeType || '').toLowerCase().trim();
  if (mt && ALLOWED_IMAGE_MIMES.has(mt)) {
    if (mt === 'image/jpeg') return 'jpg';
    return mt.replace(/^image\//, '');
  }
  const fn = String(filename || '').toLowerCase().trim();
  const m = fn.match(/\.([a-z0-9]+)$/);
  if (m && IMAGE_EXT_TO_MIME[m[1]]) {
    return m[1] === 'jpeg' ? 'jpg' : m[1];
  }
  return null;
}

function mimeForExt(ext) {
  return IMAGE_EXT_TO_MIME[String(ext || '').toLowerCase()] || null;
}

// ── Image-wrapper HTML ──────────────────────────────────────────────────────

/**
 * Build a standalone slide HTML page that displays an uploaded image
 * full-bleed inside the demo's standard `.step` shell.
 *
 * Why a wrapper? The slide-library splice pipeline (see post-slides.js +
 * insert-slide-html.js) only knows how to splice HTML. Wrapping the image in
 * a deterministic HTML shell — `data-testid="step-<id>"`, `class="step
 * slide-root"`, the same scope hooks the CSS scoper expects — means image
 * uploads "just work" through the existing splice + CSS-scoper plumbing.
 *
 * `imageSrc` MUST be an absolute (or root-relative) URL. We use the
 * dashboard's asset endpoint by default so the image resolves the same way
 * regardless of which path the wrapper is loaded from (e.g. the slide
 * library preview iframe at `/api/slide-library/slides/<id>/html` would
 * try to resolve a relative `<img src="basename.png">` to
 * `/api/slide-library/slides/<id>/basename.png` — a path the server
 * doesn't know about).
 *
 * NOTE on splice into demo apps: when an image-wrapper slide is spliced
 * into a per-run demo app via `spliceLibrarySlideIntoRunHtml`, the
 * absolute `/api/slide-library/...` URL will not resolve against the
 * per-run demo server (which lives on a different port and has no such
 * route). For library *preview* and dashboard editing this is fine; full
 * splice support for image-wrapper slides is a follow-up that needs to
 * either copy the image into the demo's `scratch-app/` directory or
 * proxy `/api/slide-library/slides/.../asset` through the demo server.
 *
 * @param {object} args
 * @param {string} args.title    Display name (also used as <title>).
 * @param {string} args.imageSrc URL the wrapper's <img> tag will load.
 * @param {string} args.altText  Accessible alt for the image.
 * @returns {string}             Full HTML document.
 */
function buildImageWrapperHtml({ title, imageSrc, altText }) {
  const safeTitle = escapeHtml(String(title || 'Uploaded Slide'));
  const safeSrc = escapeHtml(String(imageSrc || ''));
  const safeAlt = escapeHtml(String(altText || title || 'Uploaded slide'));
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${safeTitle}</title>`,
    '  <style>',
    '    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }',
    '    .step { display: block; min-height: 100vh; background: #0d1117; }',
    '    .slide-image-wrap { width: 100%; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }',
    '    .slide-image-wrap img { max-width: 100%; max-height: 100vh; object-fit: contain; display: block; }',
    '  </style>',
    '</head>',
    '<body>',
    `<div data-testid="step-uploaded-image" class="step slide-root">`,
    '  <div class="slide-image-wrap">',
    `    <img src="${safeSrc}" alt="${safeAlt}" />`,
    '  </div>',
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Index mutations: rename, delete ────────────────────────────────────────

/**
 * Rename an entry's display `name` in the library index. Pure function over
 * the index — caller writes back to disk.
 *
 * Returns `{ index, slide, changed }`. `changed=false` when the new name
 * equals the existing one (no-op) or the slide id wasn't found.
 */
function renameSlideInIndex(index, slideId, newName) {
  const safeName = String(newName || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!safeName) {
    return { index, slide: null, changed: false, reason: 'empty-name' };
  }
  const slides = Array.isArray(index && index.slides) ? index.slides : [];
  const idx = slides.findIndex((s) => s && s.id === slideId);
  if (idx < 0) {
    return { index, slide: null, changed: false, reason: 'slide-not-found' };
  }
  if (slides[idx].name === safeName) {
    return { index, slide: slides[idx], changed: false, reason: 'no-change' };
  }
  const updated = { ...slides[idx], name: safeName, renamedAt: new Date().toISOString() };
  const newSlides = slides.slice();
  newSlides[idx] = updated;
  return {
    index: { ...index, slides: newSlides },
    slide: updated,
    changed: true,
    reason: 'renamed',
  };
}

/**
 * Remove an entry from the library index. Pure — caller is responsible for
 * unlinking the underlying files (see `pathsForSlide`).
 *
 * Returns `{ index, removed }` where `removed` is the entry that was
 * dropped (or null if the slide id wasn't present).
 */
function removeSlideFromIndex(index, slideId) {
  const slides = Array.isArray(index && index.slides) ? index.slides : [];
  const idx = slides.findIndex((s) => s && s.id === slideId);
  if (idx < 0) return { index, removed: null };
  const removed = slides[idx];
  const newSlides = slides.slice(0, idx).concat(slides.slice(idx + 1));
  return { index: { ...index, slides: newSlides }, removed };
}

/**
 * Resolve the on-disk paths owned by a single slide entry. Used by delete
 * to know what to unlink, and by the asset endpoint to find image files.
 *
 * `slidesDir` is the absolute path to `out/slide-library/slides/`.
 * Returns `{ htmlAbs, imageAbs }`. `imageAbs` is null when the entry isn't
 * an image upload.
 */
function pathsForSlide(slide, slidesDir) {
  if (!slide || typeof slide !== 'object') return { htmlAbs: null, imageAbs: null };
  let htmlAbs = null;
  if (slide.htmlPath) {
    // htmlPath is relative to PROJECT_ROOT (e.g. "out/slide-library/slides/foo.html").
    htmlAbs = path.resolve(slidesDir, '..', '..', '..', slide.htmlPath);
    // Normalize: if the entry stored an absolute path or different layout,
    // fall back to slidesDir/<basename>.
    const basename = path.basename(slide.htmlPath);
    const candidate = path.join(slidesDir, basename);
    if (!htmlAbs.startsWith(slidesDir + path.sep)) {
      htmlAbs = candidate;
    }
  }
  let imageAbs = null;
  if (slide.imagePath) {
    const basename = path.basename(slide.imagePath);
    imageAbs = path.join(slidesDir, basename);
  }
  return { htmlAbs, imageAbs };
}

/**
 * True if an index entry can be deleted via the dashboard. Built-in slides
 * (no `source` recorded, or `source: 'builtin'`) are read-only — deleting
 * them would orphan running demos that depend on them. Only user-uploaded
 * (`source: 'upload'`) and dashboard-submitted (`source: 'submit'`)
 * entries are deletable.
 */
function isUserOwnedSlide(slide) {
  if (!slide || typeof slide !== 'object') return false;
  const src = String(slide.source || '').toLowerCase();
  return src === 'upload' || src === 'submit';
}

module.exports = {
  IMAGE_EXT_TO_MIME,
  ALLOWED_IMAGE_MIMES,
  normalizeFilename,
  pickImageExt,
  mimeForExt,
  buildImageWrapperHtml,
  renameSlideInIndex,
  removeSlideFromIndex,
  pathsForSlide,
  isUserOwnedSlide,
};
