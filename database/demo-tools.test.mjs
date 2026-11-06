import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from '../shared/password.mjs';
import { root, loadSource, validateDataset, validateMap, normalizeMood, validDate, copyExclusive, digest } from './demo-common.mjs';

const source = await loadSource();
test('source: fixed counts, references and 25 JPEG bytes', () => validateDataset(source.data, source.manifests));
for (const [name, change, code] of [
  ['duplicate logical ID', d => { d.clothes[1].id = d.clothes[0].id; }, 'DUPLICATE_LOGICAL_ID'],
  ['wrong owner', d => { d.outfits[0].userId = 'OTHER'; }, 'INVALID_SOURCE_OWNER'],
  ['duplicate date', d => { d.diaries[1].wearDate = d.diaries[0].wearDate; }, 'DUPLICATE_DIARY_DATE'],
  ['invalid date', d => { d.diaries[0].wearDate = '2026-02-30'; }, 'INVALID_DIARY_DATE'],
  ['missing clothing reference', d => { d.outfits[0].clothingIds[0] = 'CLO999'; }, 'INVALID_CLOTHING_SELECTION'],
  ['duplicate selection', d => { d.outfits[0].clothingIds[1] = d.outfits[0].clothingIds[0]; }, 'INVALID_CLOTHING_SELECTION'],
  ['empty selection', d => { d.outfits[0].clothingIds = []; }, 'INVALID_CLOTHING_SELECTION'],
  ['overlong selection', d => { d.outfits[0].clothingIds = d.clothes.slice(0, 21).map(c => c.id); }, 'INVALID_CLOTHING_SELECTION'],
  ['invalid source outfit', d => { d.diaries[0].sourceOutfitId = 'OUT999'; }, 'INVALID_SOURCE_OUTFIT'],
  ['blob path', d => { d.clothes[0].imagePath = 'blob:temporary'; }, 'INVALID_IMAGE_PATH'],
  ['missing image manifest reference', d => { d.clothes[0].imagePath = d.clothes[1].imagePath; }, 'INVALID_CLOTHING_IMAGE_REFERENCE'],
]) test('reject ' + name, () => { const data = structuredClone(source.data); change(data); assert.throws(() => validateDataset(data, source.manifests), e => e.code === code); });

const map = { categories: Object.fromEntries(source.data.categories.map(c => [c.id, c.id])) };
for (const [kind, rows] of Object.entries({ users: [source.data.demoProfile], clothes: source.data.clothes, outfits: source.data.outfits, diaries: source.data.diaries })) map[kind] = Object.fromEntries(rows.map((r, i) => [r.id, 100 + i]));
test('mapping: positive actual IDs need not start at 1', () => validateMap(source.data, map));
for (const [name, change] of [['missing', m => { delete m.diaries.DIA001; }], ['alias', m => { m.diaries.DIA002 = m.diaries.DIA001; }], ['temporary', m => { m.diaries.DIA001 = 'TMP-DIA-0001'; }]]) test('reject map ' + name, () => { const m = structuredClone(map); change(m); assert.throws(() => validateMap(source.data, m), e => e.code === 'INVALID_ID_MAP_diaries'); });
test('date and null conversion boundaries', () => { assert.equal(normalizeMood('  '), null); assert.equal(normalizeMood(null), null); assert.equal(normalizeMood(' 开心 '), '开心'); assert.equal(validDate('2026-02-30'), false); assert.equal(validDate('2024-02-29'), true); });
test('password encoding, independent salts and positive/negative verification without logging secrets', async () => {
  const p = randomBytes(16).toString('base64'); const a = await hashPassword(p); const b = await hashPassword(p);
  assert.ok(a.length === 178 && b.length === 178 && a !== b);
  assert.ok(await verifyPassword(p, a)); assert.ok(!await verifyPassword(p + 'wrong', a));
  await assert.rejects(verifyPassword(p, 'invalid'), /INVALID_PASSWORD_HASH/);
});
test('exclusive file copy refuses replacement and leaves original bytes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wardrobe-p203-'));
  const a = path.join(dir, 'a.jpg'); const b = path.join(dir, 'b.jpg');
  try { await fs.writeFile(a, 'source'); await copyExclusive(a, b); const before = digest(await fs.readFile(b)); await assert.rejects(copyExclusive(a, b), e => e.code === 'EEXIST'); assert.equal(digest(await fs.readFile(b)), before); }
  finally { await fs.unlink(a); await fs.unlink(b); await fs.rmdir(dir); }
});
test('module import has no CLI/evidence side effects; all no-argument entries show help', async () => {
  const old = path.join(root, 'docs/evidence/P2-02'); const before = (await fs.readdir(old)).sort();
  const text = execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./database/verify-schema.mjs'); await import('./database/seed-demo.mjs'); await import('./database/verify-demo.mjs');"], { cwd: root, encoding: 'utf8' });
  assert.equal(text, ''); assert.deepEqual((await fs.readdir(old)).sort(), before);
  for (const file of ['verify-schema.mjs', 'seed-demo.mjs', 'verify-demo.mjs', 'run-demo-local.mjs']) assert.match(execFileSync(process.execPath, ['database/' + file], { cwd: root, encoding: 'utf8' }), /Usage:/);
  const current = (await fs.readdir(path.join(root, 'docs/evidence/P2-03'))).sort();
  assert.throws(() => execFileSync(process.execPath, ['database/seed-demo.mjs', '--unknown'], { cwd: root, stdio: 'pipe' }), e => e.status === 1 && e.stderr.toString().includes('INVALID_MODE'));
  assert.deepEqual((await fs.readdir(path.join(root, 'docs/evidence/P2-03'))).sort(), current);
});
