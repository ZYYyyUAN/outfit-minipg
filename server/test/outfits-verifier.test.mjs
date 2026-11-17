import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs, reserveRun, compareSnapshots, compareCumulative } from '../scripts/verify-outfits.mjs';

test('outfit verification CLI defaults to help and requires an explicit safe run ID for read or HTTP modes', () => {
  assert.deepEqual(parseArgs([]), { mode: 'help' }); assert.deepEqual(parseArgs(['--help']), { mode: 'help' });
  for (const mode of ['preflight', 'audit', 'http']) assert.deepEqual(parseArgs(['--' + mode, 'run-20261116-b1']), { mode, runId: 'run-20261116-b1' });
  for (const args of [['--audit'], ['--preflight', '../escape'], ['--audit', 'x/y'], ['--audit', ''], ['--audit', 'A'], ['--audit', 'a'.repeat(81)], ['--help', 'x'], ['--preflight', 'run', 'extra'], ['--run-id', 'run']]) assert.throws(() => parseArgs(args), { code: 'INVALID_ARGUMENTS' });
  for (const mode of ['--prepare-ui', '--restart']) assert.throws(() => parseArgs([mode, 'run']), { code: 'UNSUPPORTED_MODE' });
});
test('help and unsupported modes work without database/private configuration from another cwd', () => {
  const script = fileURLToPath(new URL('../scripts/verify-outfits.mjs', import.meta.url));
  const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith('DB_') || ['PUBLIC_BASE_URL', 'UPLOAD_ROOT'].includes(key)) delete env[key];
  for (const args of [[], ['--help'], ['--http'], ['--prepare-ui', 'run'], ['--restart', 'run'], ['--preflight', '../escape']]) {
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
test('cumulative manifests explain only registered new owners and exact row/image hashes', () => {
  const baseline = { identity: {}, grants: [], columns: [], U0: 1, tables: { users: { count: 1, structure: 'users', rows: [{ key: 1, sha256: 'old' }] }, categories: { count: 0, structure: 'categories', rows: [] } }, protectedFiles: {}, images: {} };
  // The stage always has seven fixed tables.
  for (const table of ['clothes', 'outfits', 'outfit_items', 'diaries', 'diary_items']) baseline.tables[table] = { count: 0, structure: table, rows: [] };
  const manifest = { version: 1, runId: 'new', accounts: [{ id: 2 }], rows: [{ table: 'users', ownerId: 2, row: { key: 2, sha256: 'new' }, beforeSha256: null, allowedFields: ['updated_at'], changedFields: [] }], images: [{ userId: 2, path: 'users/2/image.jpg', size: 3, sha256: 'image', mimeType: 'image/jpeg' }] };
  const current = structuredClone(baseline); current.U0 = 2; current.tables.users.count = 2; current.tables.users.rows.push({ key: 2, sha256: 'new' }); current.images['users/2/image.jpg'] = { size: 3, sha256: 'image', mimeType: 'image/jpeg' };
  assert.equal(compareCumulative(baseline, current, [manifest]).registeredAccounts, 1);
  for (const mutate of [s => s.tables.users.rows[0].sha256 = 'changed', s => s.tables.users.rows[1].sha256 = 'changed', s => s.tables.users.rows.push({ key: 3, sha256: 'unknown' }), s => s.images['users/9/unknown.jpg'] = {}, s => s.U0 = 3]) {
    const altered = structuredClone(current); mutate(altered); assert.throws(() => compareCumulative(baseline, altered, [manifest]));
  }
  for (const mutate of [m => m.rows[0].row.key = 1, m => m.rows[0].ownerId = 1, m => m.rows[0].beforeSha256 = 'unknown', m => m.images[0].path = 'users/1/image.jpg', m => m.rows[0].table = 'categories']) {
    const altered = structuredClone(manifest); mutate(altered); assert.throws(() => compareCumulative(baseline, current, [altered]));
  }
  const update = { version: 1, runId: 'later', accounts: [], rows: [{ ...manifest.rows[0], beforeSha256: 'new', row: { key: 2, sha256: 'later' }, changedFields: ['updated_at'] }], images: [] };
  const later = structuredClone(current); later.tables.users.rows[1].sha256 = 'later';
  assert.throws(() => compareCumulative(baseline, later, [manifest, update]), /EXISTING_KEY_TRANSITION_NOT_SUPPORTED/);
  update.rows[0].changedFields = ['password_hash']; assert.throws(() => compareCumulative(baseline, later, [manifest, update]), /EXISTING_KEY_TRANSITION_NOT_SUPPORTED/);
});
test('cumulative audit checks actual parent, clothing and diary-source ownership beyond manifest declarations', () => {
  const baseline = { identity: {}, grants: [], columns: [], U0: 1, tables: {}, protectedFiles: {}, images: {} };
  for (const table of ['users', 'categories', 'clothes', 'outfits', 'outfit_items', 'diaries', 'diary_items']) baseline.tables[table] = { count: 0, structure: table, rows: [] };
  baseline.tables.users = { count: 1, structure: 'users', rows: [{ key: 1, sha256: 'original' }] };
  const current = structuredClone(baseline); current.U0 = 2;
  const rows = [
    { table: 'users', row: { key: 2, sha256: 'user' } }, { table: 'clothes', row: { key: 10, sha256: 'clothing', userId: 2 } },
    { table: 'outfits', row: { key: 20, sha256: 'outfit', userId: 2 } }, { table: 'outfit_items', row: { key: '20:10', sha256: 'item' } },
    { table: 'diaries', row: { key: 30, sha256: 'diary', userId: 2 } },
  ].map(value => ({ ...value, ownerId: 2, beforeSha256: null, allowedFields: [], changedFields: [] }));
  for (const entry of rows) { current.tables[entry.table].rows.push(entry.row); current.tables[entry.table].count++; }
  current.ownership = { clothes: { 10: { ownerId: 2 } }, outfits: { 20: { ownerId: 2 } }, outfit_items: { '20:10': { parentId: 20, clothingId: 10, sortOrder: 1 } }, diaries: { 30: { ownerId: 2, sourceOutfitId: 20 } } };
  const manifest = { version: 1, runId: 'new', accounts: [{ id: 2 }], rows, images: [] };
  assert.equal(compareCumulative(baseline, current, [manifest]).registeredRows, 5);
  for (const mutate of [s => s.ownership.clothes[10].ownerId = 1, s => s.ownership.outfits[20].ownerId = 1, s => s.ownership.diaries[30].ownerId = 1, s => { s.ownership.outfits[21] = { ownerId: 1 }; s.ownership.diaries[30].sourceOutfitId = 21; }]) {
    const altered = structuredClone(current); mutate(altered); assert.throws(() => compareCumulative(baseline, altered, [manifest]));
  }
});
