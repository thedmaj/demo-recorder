'use strict';

/**
 * Minimal harness: startPipelineHeartbeat at PIPELINE_HEARTBEAT_MS, sleep 850ms, exit.
 * Used by orchestrator-heartbeat-integration.test.js to prove mid-stage ticks.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const { startPipelineHeartbeat, parseHeartbeatIntervalMs } = require(
  path.join(PROJECT_ROOT, 'scripts/scratch/utils/pipeline-heartbeat.js')
);
const { getRunLayout } = require(path.join(PROJECT_ROOT, 'scripts/scratch/utils/run-io.js'));

async function main() {
  const runDir = fs.mkdtempSync(path.join(PROJECT_ROOT, 'out', 'hb-integ-'));
  const layout = getRunLayout(runDir);
  fs.mkdirSync(layout.logsDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, '.pipeline.pid'), `${process.pid}\n`, 'utf8');
  process.env.PIPELINE_RUN_DIR = runDir;

  const intervalMs = parseHeartbeatIntervalMs(process.env.PIPELINE_HEARTBEAT_MS);
  const handle = startPipelineHeartbeat({ runDir, intervalMs });

  await new Promise((r) => setTimeout(r, 850));
  handle.stop();

  try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (_) {}
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
