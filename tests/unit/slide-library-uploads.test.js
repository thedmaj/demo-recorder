'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
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
} = require(path.join(__dirname, '../../scripts/dashboard/utils/slide-library-uploads'));

// ── Image MIME / extension picking ──────────────────────────────────────────

describe('pickImageExt', () => {
  test('prefers MIME type over filename extension', () => {
    assert.equal(pickImageExt({ filename: 'screenshot.bin', mimeType: 'image/png' }), 'png');
    assert.equal(pickImageExt({ filename: 'photo.bin', mimeType: 'image/jpeg' }), 'jpg');
  });

  test('falls back to filename extension when MIME is missing or generic', () => {
    assert.equal(pickImageExt({ filename: 'foo.png', mimeType: '' }), 'png');
    assert.equal(pickImageExt({ filename: 'foo.JPG', mimeType: '' }), 'jpg');
    assert.equal(pickImageExt({ filename: 'foo.webp', mimeType: 'application/octet-stream' }), 'webp');
  });

  test('returns null for unsupported / dangerous types', () => {
    // SVG can carry <script> — we deliberately exclude it.
    assert.equal(pickImageExt({ filename: 'logo.svg', mimeType: 'image/svg+xml' }), null);
    // Random binary:
    assert.equal(pickImageExt({ filename: 'thing.bin', mimeType: 'application/octet-stream' }), null);
    // PDF, video, etc:
    assert.equal(pickImageExt({ filename: 'doc.pdf', mimeType: 'application/pdf' }), null);
    // Empty / nothing:
    assert.equal(pickImageExt({ filename: '', mimeType: '' }), null);
    assert.equal(pickImageExt({}), null);
  });

  test('normalizes "jpeg" to "jpg" so filenames stay tidy', () => {
    assert.equal(pickImageExt({ filename: 'foo.jpeg', mimeType: '' }), 'jpg');
    assert.equal(pickImageExt({ filename: 'foo.bin', mimeType: 'image/jpeg' }), 'jpg');
  });
});

describe('mimeForExt', () => {
  test('returns the canonical MIME for each supported extension', () => {
    assert.equal(mimeForExt('png'), 'image/png');
    assert.equal(mimeForExt('jpg'), 'image/jpeg');
    assert.equal(mimeForExt('jpeg'), 'image/jpeg');
    assert.equal(mimeForExt('webp'), 'image/webp');
    assert.equal(mimeForExt('gif'), 'image/gif');
  });
  test('case-insensitive', () => {
    assert.equal(mimeForExt('PNG'), 'image/png');
  });
  test('returns null for unsupported / empty input', () => {
    assert.equal(mimeForExt('svg'), null);
    assert.equal(mimeForExt(''), null);
    assert.equal(mimeForExt(null), null);
  });
});

describe('normalizeFilename', () => {
  test('replaces unsafe chars with dashes and trims', () => {
    assert.equal(normalizeFilename('  My Slide /v2.png  '), 'My-Slide-v2.png');
    assert.equal(normalizeFilename('a/b\\c?d'), 'a-b-c-d');
    assert.equal(normalizeFilename('hello world!'), 'hello-world');
  });

  test('caps length to 200 chars', () => {
    const long = 'a'.repeat(500);
    assert.equal(normalizeFilename(long).length, 200);
  });

  test('handles non-string input', () => {
    assert.equal(normalizeFilename(null), '');
    assert.equal(normalizeFilename(undefined), '');
  });
});

// ── buildImageWrapperHtml ───────────────────────────────────────────────────

describe('buildImageWrapperHtml', () => {
  test('produces a valid full-document HTML wrapper around the image', () => {
    const html = buildImageWrapperHtml({
      title: 'Identity Match Hero',
      imageSrc: '/api/slide-library/slides/identity-match-hero-20260428/asset',
      altText: 'Identity match scoring hero shot',
    });
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<title>Identity Match Hero<\/title>/);
    assert.match(
      html,
      /<img src="\/api\/slide-library\/slides\/identity-match-hero-20260428\/asset" alt="Identity match scoring hero shot" \/>/
    );
    // Has the slide-root + step structure that the splice helpers expect:
    assert.match(html, /<div data-testid="step-uploaded-image" class="step slide-root">/);
    // Contains the centered-image flex layout:
    assert.match(html, /\.slide-image-wrap/);
    // Closes <html> properly:
    assert.match(html, /<\/html>\s*$/);
  });

  test('escapes HTML special chars in title, src, and alt', () => {
    const html = buildImageWrapperHtml({
      title: 'A & B <script>',
      imageSrc: '/x?a=1&b=2',
      altText: 'X "quoted" & </closed>',
    });
    assert.match(html, /<title>A &amp; B &lt;script&gt;<\/title>/);
    assert.match(html, /<img src="\/x\?a=1&amp;b=2"/);
    assert.match(html, /alt="X &quot;quoted&quot; &amp; &lt;\/closed&gt;"/);
  });

  test('falls back to "Uploaded slide" alt when nothing provided', () => {
    const html = buildImageWrapperHtml({ title: '', imageSrc: '/x', altText: '' });
    assert.match(html, /alt="Uploaded slide"/);
  });
});

// ── Index mutations ─────────────────────────────────────────────────────────

describe('renameSlideInIndex', () => {
  const baseIndex = {
    version: 1,
    slides: [
      { id: 'a', name: 'Old A' },
      { id: 'b', name: 'Old B' },
    ],
  };

  test('renames a matching slide and stamps a renamedAt timestamp', () => {
    const out = renameSlideInIndex(baseIndex, 'a', 'New Name');
    assert.equal(out.changed, true);
    assert.equal(out.slide.name, 'New Name');
    assert.match(out.slide.renamedAt, /^\d{4}-\d{2}-\d{2}T/);
    // Other slides untouched:
    assert.equal(out.index.slides[1].name, 'Old B');
    // Original index is not mutated (pure function):
    assert.equal(baseIndex.slides[0].name, 'Old A');
  });

  test('trims and collapses whitespace; caps to 120 chars', () => {
    const out = renameSlideInIndex(baseIndex, 'a', '   Lots   of    spaces  ');
    assert.equal(out.slide.name, 'Lots of spaces');
    const long = 'x'.repeat(500);
    const out2 = renameSlideInIndex(baseIndex, 'a', long);
    assert.equal(out2.slide.name.length, 120);
  });

  test('returns changed=false when the name is identical', () => {
    const out = renameSlideInIndex(baseIndex, 'a', 'Old A');
    assert.equal(out.changed, false);
    assert.equal(out.reason, 'no-change');
  });

  test('returns changed=false with reason=slide-not-found when id missing', () => {
    const out = renameSlideInIndex(baseIndex, 'zzz', 'whatever');
    assert.equal(out.changed, false);
    assert.equal(out.reason, 'slide-not-found');
  });

  test('rejects empty / whitespace-only names', () => {
    assert.equal(renameSlideInIndex(baseIndex, 'a', '').changed, false);
    assert.equal(renameSlideInIndex(baseIndex, 'a', '   ').reason, 'empty-name');
  });
});

describe('removeSlideFromIndex', () => {
  const baseIndex = {
    version: 1,
    slides: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ],
  };

  test('drops the matching slide and returns it', () => {
    const out = removeSlideFromIndex(baseIndex, 'b');
    assert.equal(out.removed.id, 'b');
    assert.deepEqual(out.index.slides.map((s) => s.id), ['a', 'c']);
    // Original untouched:
    assert.equal(baseIndex.slides.length, 3);
  });

  test('returns removed=null when slide id missing', () => {
    const out = removeSlideFromIndex(baseIndex, 'zzz');
    assert.equal(out.removed, null);
    assert.equal(out.index.slides.length, 3);
  });
});

// ── pathsForSlide ───────────────────────────────────────────────────────────

describe('pathsForSlide', () => {
  const slidesDir = '/abs/out/slide-library/slides';

  test('resolves htmlAbs for a typical slide with a relative htmlPath', () => {
    const slide = { id: 'foo', htmlPath: 'out/slide-library/slides/foo.html' };
    const out = pathsForSlide(slide, slidesDir);
    assert.equal(out.htmlAbs, path.join(slidesDir, 'foo.html'));
    assert.equal(out.imageAbs, null);
  });

  test('resolves both htmlAbs and imageAbs for image uploads', () => {
    const slide = {
      id: 'foo',
      htmlPath: 'out/slide-library/slides/foo.html',
      imagePath: 'out/slide-library/slides/foo.png',
    };
    const out = pathsForSlide(slide, slidesDir);
    assert.equal(out.htmlAbs, path.join(slidesDir, 'foo.html'));
    assert.equal(out.imageAbs, path.join(slidesDir, 'foo.png'));
  });

  test('clamps htmlAbs to the slides dir when a path-traversal attempt is in the entry', () => {
    const evil = { id: 'evil', htmlPath: '../../etc/passwd' };
    const out = pathsForSlide(evil, slidesDir);
    // Must NOT escape the slides directory:
    assert.ok(out.htmlAbs.startsWith(slidesDir + path.sep), 'htmlAbs stays within slidesDir');
  });

  test('returns nulls for malformed / empty input', () => {
    assert.deepEqual(pathsForSlide(null, slidesDir), { htmlAbs: null, imageAbs: null });
    assert.deepEqual(pathsForSlide({}, slidesDir), { htmlAbs: null, imageAbs: null });
  });
});

// ── isUserOwnedSlide ────────────────────────────────────────────────────────

describe('isUserOwnedSlide', () => {
  test('user-uploaded and dashboard-submitted entries are deletable', () => {
    assert.equal(isUserOwnedSlide({ source: 'upload' }), true);
    assert.equal(isUserOwnedSlide({ source: 'submit' }), true);
  });

  test('built-in / unspecified-source entries are read-only', () => {
    assert.equal(isUserOwnedSlide({ source: 'builtin' }), false);
    assert.equal(isUserOwnedSlide({}), false);
    assert.equal(isUserOwnedSlide(null), false);
  });
});

// ── IMAGE_EXT_TO_MIME / ALLOWED_IMAGE_MIMES sanity ──────────────────────────

describe('IMAGE_EXT_TO_MIME / ALLOWED_IMAGE_MIMES', () => {
  test('exposes the expected supported types and is frozen', () => {
    assert.deepEqual(
      Object.keys(IMAGE_EXT_TO_MIME).sort(),
      ['gif', 'jpeg', 'jpg', 'png', 'webp']
    );
    assert.ok(Object.isFrozen(IMAGE_EXT_TO_MIME));
    assert.ok(Object.isFrozen(ALLOWED_IMAGE_MIMES));
    // svg is intentionally NOT in the allow list:
    assert.equal(ALLOWED_IMAGE_MIMES.has('image/svg+xml'), false);
  });
});
