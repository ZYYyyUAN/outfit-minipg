import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs, reserveRun, compareSnapshots } from '../scripts/verify-outfits.mjs';

test('outfit verification CLI defaults to help and only accepts explicit safe read modes', () => {
  assert.deepEqual(parseArgs([]), { mode: 'help' }); assert.deepEqual(parseArgs(['--help']), { mode: 'help' });
  for (const mode of ['preflight', 'audit']) assert.deepEqual(parseArgs(['--' + mode, 'run-20261116-b1']), { mode, runId: 'run-20261116-b1' });
  for (const args of [['--audit'], ['--preflight', '../escape'], ['--audit', 'x/y'], ['--audit', ''], ['--audit', 'A'], ['--audit', 'a'.repeat(81)], ['--help', 'x'], ['--preflight', 'run', 'extra'], ['--run-id', 'run']]) assert.throws(() => parseArgs(args), { code: 'INVALID_ARGUMENTS' });
  for (const mode of ['--http', '--prepare-ui', '--restart']) assert.throws(() => parseArgs([mode, 'run']), { code: 'UNSUPPORTED_MODE' });
});
test('help and unsupported modes work without database/private configuration from another cwd', () => {
  const script = fileURLToPath(new URL('../scripts/verify-outfits.mjs', import.meta.url));
  const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith('DB_') || ['PUBLIC_BASE_URL', 'UPLOAD_ROOT'].includes(key)) delete env[key];
  for (const args of [[], ['--help'], ['--http', 'run'], ['--prepare-ui', 'run'], ['--restart', 'run'], ['--preflight', '../escape']]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: os.tmpdir(), env, encoding: 'utf8', windowsHide: true });
    if (!args.length || args[0] === '--help') { assert.equal(result.status, 0); assert.match(result.stdout, /仅帮助/); assert.equal(result.stderr, ''); }
    else { assert.equal(result.status, 1); assert.match(result.stderr, /UNSUPPORTED_MODE|INVALID_ARGUMENTS/); assert.doesNotMatch(result.stderr, /INVALID_CONFIG|mysql|ECONN/); }
  }
});
test('evidence run reservation refuses any existing directory and preserves its bytes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'p5-evidence-')); t.after(() => fs.rm(directory, { recursive: true }));
  const run = await reserveRun(directory, 'run'); await fs.writeFile(path.join(run, 'marker.json'), 'original');
  await assert.rejects(reserveRun(directory, 'run'), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(run, 'marker.json'), 'utf8'), 'original');
});
test('zero-increment protection detects changed, added or missing rows/images/files, schema and identity', () => {
  const baseline = { identity: { version: '8', hostname: 'local', port: 3306, account: 'test', db: 'wardrobe_demo', timeZone: '+00:00', connectionCollation: 'utf8mb4_0900_as_cs' }, grants: ['GRANT SELECT'], columns: [{ columnName: 'id' }], tables: { users: { count: 1, rows: [{ key: 1, sha256: 'hash' }], structure: 'DDL' } }, protectedFiles: { 'data/demo.json': 'hash' }, images: { 'users/1/image.jpg': { size: 3, sha256: 'hash', mimeType: 'image/jpeg' } } };
  assert.equal(compareSnapshots(baseline, structuredClone(baseline)).allRowsUnchanged, true);
  for (const mutate of [s => s.identity.db = 'other', s => s.grants.push('OTHER'), s => s.columns.pop(), s => s.tables.users.rows[0].sha256 = 'changed', s => s.tables.users.rows.push({ key: 2, sha256: 'new' }), s => s.tables.users.rows.pop(), s => s.tables.users.structure = 'ALTERED', s => s.protectedFiles['data/demo.json'] = 'changed', s => s.protectedFiles['data/extra.json'] = 'new', s => s.images['users/1/image.jpg'].sha256 = 'changed', s => s.images['users/2/new.jpg'] = {}, s => delete s.images['users/1/image.jpg']]) {
    const current = structuredClone(baseline); mutate(current); assert.throws(() => compareSnapshots(baseline, current), { code: 'ERR_ASSERTION' });
  }
});
