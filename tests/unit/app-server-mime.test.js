'use strict';
/**
 * Tests for MIME type detection (mirrors MIME_TYPES in scripts/scratch/utils/app-server.js).
 * No API calls, no I/O, no server started.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Mirrors the MIME_TYPES map and getMimeType() from scripts/scratch/utils/app-server.js
const MIME_TYPES = {
  '.html':  'text/html; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.js':    'text/javascript; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.gif':   'image/gif',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.mp4':   'video/mp4',
  '.webm':  'video/webm',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

describe('app-server-mime', () => {
  test('.html → text/html; charset=utf-8', () => {
    assert.equal(getMimeType('index.html'), 'text/html; charset=utf-8');
  });

  test('.png → image/png', () => {
    assert.equal(getMimeType('screenshot.png'), 'image/png');
  });

  test('.mp4 → video/mp4', () => {
    assert.equal(getMimeType('demo.mp4'), 'video/mp4');
  });

  test('.webm → video/webm', () => {
    assert.equal(getMimeType('recording.webm'), 'video/webm');
  });

  test('.unknown → application/octet-stream', () => {
    assert.equal(getMimeType('file.xyz'), 'application/octet-stream');
  });

  test('no extension → application/octet-stream', () => {
    assert.equal(getMimeType('Makefile'), 'application/octet-stream');
  });

  test('.JSON uppercase → application/json (case-insensitive)', () => {
    assert.equal(getMimeType('data.JSON'), 'application/json; charset=utf-8');
  });

  test('.svg → image/svg+xml', () => {
    assert.equal(getMimeType('logo.svg'), 'image/svg+xml');
  });
});
