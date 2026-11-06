import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { seed } from './seed-demo.mjs';
import { verify } from './verify-demo.mjs';
import { newRun, check, connect, counts, uploads, tables, digest, writeJson, safeError } from './demo-common.mjs';

async function snapshot() {
  const c = await connect();
  try {
    const rowHashes = {};
    for (const t of tables) {
      const [rows] = await c.query(`SELECT * FROM ${t} ORDER BY ${t === 'outfit_items' ? 'outfit_id,clothing_id' : t === 'diary_items' ? 'diary_id,clothing_id' : 'id'}`);
      rowHashes[t] = digest(JSON.stringify(rows));
    }
    const [ids] = await c.query('SELECT TABLE_NAME,AUTO_INCREMENT FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME');
    const files = {};
    for (const user of await fs.readdir(path.join(uploads, 'users'))) for (const name of await fs.readdir(path.join(uploads, 'users', user))) files[`users/${user}/${name}`] = digest(await fs.readFile(path.join(uploads, 'users', user, name)));
    return { counts: await counts(c), rowHashes, autoIncrements: ids, files };
  } finally { await c.end(); }
}

async function main() {
  if (process.argv.length === 2) { console.log('Usage: run-demo-local.mjs --execute|--resume <committedImportRunId>'); return; }
  const args = process.argv.slice(2);
  check((args.length === 1 && args[0] === '--execute') || (args.length === 2 && args[0] === '--resume' && /^[a-zA-Z0-9_-]+$/.test(args[1])), 'INVALID_RUNNER_ARGUMENTS');
  const run = await newRun('local-runner'); const r = run.report;
  try {
    if (args[0] === '--execute') {
      const checked = await seed('--check'); r.checkRunId = checked.runId; check(checked.state === 'check-passed', 'CHECK_FAILED');
      const rollback = await seed('--rollback-check'); r.rollbackRunId = rollback.runId; check(rollback.state === 'rollback-verified', 'ROLLBACK_FAILED');
      const applied = await seed('--apply'); r.importRunId = applied.runId; check(applied.committed && !applied.error, 'IMPORT_FAILED');
    } else r.importRunId = args[1];
    const verified = await verify(r.importRunId, '2026-11-06'); r.verifyRunId = verified.runId; check(verified.state === 'verified', 'VERIFY_FAILED');
    r.beforeRepeat = await snapshot(); r.repeatRefusals = [];
    for (const mode of ['--check', '--apply']) {
      const rejected = await seed(mode); r.repeatRefusals.push({ mode, runId: rejected.runId, error: rejected.error, copiedFiles: rejected.copiedFiles.length });
      check(rejected.state === 'preflight-rejected' && rejected.error?.code === 'NON_EMPTY_DATABASE' && rejected.copiedFiles.length === 0, 'REPEAT_NOT_REJECTED');
      process.exitCode = 0;
    }
    r.afterRepeat = await snapshot(); assert.deepEqual(r.afterRepeat, r.beforeRepeat);
    r.state = 'local-pipeline-passed';
  } catch (e) { r.state = 'local-pipeline-failed'; r.error = safeError(e); process.exitCode = 1; }
  r.completedAt = new Date().toISOString(); await writeJson(path.join(run.dir, 'runner-result.json'), r);
  console.log(JSON.stringify({ runnerId: run.runId, state: r.state, error: r.error }));
}
if (import.meta.main) { try { await main(); } catch (e) { console.error(JSON.stringify({ state: 'failed', error: safeError(e) })); process.exitCode = 1; } }
