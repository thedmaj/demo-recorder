'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const CONFIG_PATH = require('path').join(
  __dirname,
  '../../scripts/scratch/utils/slide-qa-config.js'
);

describe('slide-qa-config', () => {
  const saved = {};

  beforeEach(() => {
    saved.SLIDE_QA_MAX_ITERATIONS = process.env.SLIDE_QA_MAX_ITERATIONS;
    saved.SLIDE_FIX_MAX_ITERATIONS = process.env.SLIDE_FIX_MAX_ITERATIONS;
    delete process.env.SLIDE_QA_MAX_ITERATIONS;
    delete process.env.SLIDE_FIX_MAX_ITERATIONS;
    delete require.cache[CONFIG_PATH];
  });

  afterEach(() => {
    if (saved.SLIDE_QA_MAX_ITERATIONS === undefined) delete process.env.SLIDE_QA_MAX_ITERATIONS;
    else process.env.SLIDE_QA_MAX_ITERATIONS = saved.SLIDE_QA_MAX_ITERATIONS;
    if (saved.SLIDE_FIX_MAX_ITERATIONS === undefined) delete process.env.SLIDE_FIX_MAX_ITERATIONS;
    else process.env.SLIDE_FIX_MAX_ITERATIONS = saved.SLIDE_FIX_MAX_ITERATIONS;
    delete require.cache[CONFIG_PATH];
  });

  test('defaults to 3 when env unset', () => {
    const { resolveSlideQaMaxIterations, SLIDE_QA_MAX_ITERATIONS_DEFAULT } = require(CONFIG_PATH);
    assert.equal(SLIDE_QA_MAX_ITERATIONS_DEFAULT, 3);
    assert.equal(resolveSlideQaMaxIterations(), 3);
  });

  test('honors SLIDE_QA_MAX_ITERATIONS env', () => {
    process.env.SLIDE_QA_MAX_ITERATIONS = '5';
    delete require.cache[CONFIG_PATH];
    const { resolveSlideQaMaxIterations } = require(CONFIG_PATH);
    assert.equal(resolveSlideQaMaxIterations(), 5);
  });

  test('falls back to SLIDE_FIX_MAX_ITERATIONS when SLIDE_QA unset', () => {
    process.env.SLIDE_FIX_MAX_ITERATIONS = '2';
    delete require.cache[CONFIG_PATH];
    const { resolveSlideQaMaxIterations } = require(CONFIG_PATH);
    assert.equal(resolveSlideQaMaxIterations(), 2);
  });

  test('explicit override wins over env', () => {
    process.env.SLIDE_QA_MAX_ITERATIONS = '5';
    delete require.cache[CONFIG_PATH];
    const { resolveSlideQaMaxIterations } = require(CONFIG_PATH);
    assert.equal(resolveSlideQaMaxIterations(1), 1);
  });
});
