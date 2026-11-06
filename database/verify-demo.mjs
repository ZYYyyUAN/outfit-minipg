import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { verifyPassword } from '../shared/password.mjs';
import { root, evidenceRoot, uploads, tables, expectedCounts, check, readJson, writeJson, loadSource, newRun, connect, preflight, demoPassword, validateMap, validDate, digest, safeError } from './demo-common.mjs';

export async function verify(runId, asOf) {
  const run = await newRun('verify'); const report = run.report;
  report.importRunId = runId; report.asOf = asOf;
  let c, transaction = false;
  try {
    const { data, summary, manifests } = await loadSource();
    const imported = await readJson(path.join(evidenceRoot, runId, 'import-result.json'));
    const idFile = await readJson(path.join(evidenceRoot, runId, 'id-map.json'));
    const fileList = await readJson(path.join(evidenceRoot, runId, 'files-manifest.json'));
    check(imported.committed && imported.state === 'committed-unverified' && idFile.committed && fileList.committed, 'NOT_COMMITTED_IMPORT');
    for (const p of ['data/demo-data.json', 'assets/source-manifest.json', 'assets/diary-photo-manifest.json']) check(imported.hashes[p] === digest(await fs.readFile(path.join(root, p))), 'SOURCE_CHANGED_SINCE_IMPORT');
    const map = idFile.map; validateMap(data, map); const uid = map.users.DEMO001;
    c = await connect(); report.preflight = await preflight(c, false);
    assert.deepEqual(report.preflight.counts, expectedCounts);
    await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'); transaction = true;
    const q = async (sql, params = []) => (await c.execute(sql, params))[0];
    const [user] = await q('SELECT * FROM users WHERE id=?', [uid]);
    check(user.username === 'demo_user' && user.nickname === data.demoProfile.nickname && user.avatar_path === null && user.auth_token_hash === null && user.auth_expires_at === null, 'USER_FIELDS_MISMATCH');
    const password = demoPassword();
    check(await verifyPassword(password, user.password_hash), 'DEMO_PASSWORD_MISMATCH');
    const wrong = (password.startsWith('a') ? 'b' : 'a') + Array.from(password).slice(1).join('');
    check(!await verifyPassword(wrong, user.password_hash), 'WRONG_PASSWORD_ACCEPTED');
    report.password = { correctAccepted: true, wrongRejected: true, encodingLength: user.password_hash.length, saltBytes: 16, derivedBytes: 64, N: 16384, r: 8, p: 1 };
    const dbTime = imported.importTime.replace('T', ' ').slice(0, 23);
    const times = row => check(row.created_at === dbTime && row.updated_at === dbTime, 'UTC_CREATION_TIME_MISMATCH');
    times(user);
    const categories = await q('SELECT id,name,sort_order FROM categories ORDER BY sort_order');
    assert.deepEqual(categories, data.categories.map(x => ({ id: x.id, name: x.name, sort_order: x.sortOrder })));
    const verified = { clothes: [], outfits: [], diaries: [] };
    const referencedFiles = [];
    const checkImage = (value, logicalId, source) => {
      check(typeof value === 'string' && new RegExp(`^users/${uid}/[0-9a-f-]{36}\\.jpg$`).test(value), 'UNSTABLE_IMAGE_PATH');
      const entries = fileList.files.filter(f => f.logicalId === logicalId);
      check(entries.length === 1 && entries[0].path === value && entries[0].source === source && entries[0].userId === uid, 'FILE_MANIFEST_REFERENCE_MISMATCH');
      referencedFiles.push(value);
    };
    for (const source of data.clothes) {
      const [row] = await q('SELECT * FROM clothes WHERE id=?', [map.clothes[source.id]]);
      check(row && row.user_id === uid && row.name === source.name && row.category_id === source.categoryId && row.color === source.color && row.season === source.season && row.note === source.note && row.is_archived === Number(source.isArchived), 'CLOTHING_FIELDS_MISMATCH');
      times(row); checkImage(row.image_path, source.id, source.imagePath); verified.clothes.push({ logicalId: source.id, actualId: row.id, fieldsMatched: true });
    }
    for (const source of data.outfits) {
      const [row] = await q('SELECT * FROM outfits WHERE id=?', [map.outfits[source.id]]);
      check(row && row.user_id === uid && row.name === source.name && row.occasion === source.occasion && row.note === source.note && row.is_archived === Number(source.isArchived), 'OUTFIT_FIELDS_MISMATCH'); times(row);
      const items = await q('SELECT clothing_id,sort_order FROM outfit_items WHERE outfit_id=? ORDER BY sort_order', [row.id]);
      assert.deepEqual(items, source.clothingIds.map((id, i) => ({ clothing_id: map.clothes[id], sort_order: i + 1 })));
      verified.outfits.push({ logicalId: source.id, actualId: row.id, fieldsMatched: true, items });
    }
    const dateSet = new Set();
    for (const source of data.diaries) {
      const [row] = await q('SELECT * FROM diaries WHERE id=?', [map.diaries[source.id]]);
      const expectedMood = source.mood === null || source.mood.trim() === '' ? null : source.mood.trim();
      check(row && row.user_id === uid && row.wear_date === source.wearDate && row.source_outfit_id === (source.sourceOutfitId === null ? null : map.outfits[source.sourceOutfitId]) && row.occasion === source.occasion && row.mood === expectedMood && row.note === source.note, 'DIARY_FIELDS_MISMATCH'); times(row);
      check(!dateSet.has(row.wear_date), 'DUPLICATE_DATABASE_DATE'); dateSet.add(row.wear_date);
      if (source.photoPath === null) check(row.photo_path === null, 'EMPTY_PHOTO_MISMATCH'); else checkImage(row.photo_path, source.id, source.photoPath);
      const items = await q('SELECT clothing_id,sort_order FROM diary_items WHERE diary_id=? ORDER BY sort_order', [row.id]);
      assert.deepEqual(items, source.clothingIds.map((id, i) => ({ clothing_id: map.clothes[id], sort_order: i + 1 })));
      verified.diaries.push({ logicalId: source.id, actualId: row.id, wearDate: row.wear_date, sourceOutfitId: row.source_outfit_id, hasPhoto: row.photo_path !== null, fieldsMatched: true, items });
    }
    check(referencedFiles.length === 25 && new Set(referencedFiles).size === 25 && fileList.files.length === 25, 'REFERENCE_FILE_COUNT_MISMATCH');
    const expectedNames = referencedFiles.map(p => path.basename(p)).sort();
    assert.deepEqual((await fs.readdir(path.join(uploads, 'users', String(uid)))).sort(), expectedNames);
    report.files = [];
    for (const file of fileList.files) {
      const bytes = await fs.readFile(path.join(uploads, file.path)); const source = manifests.find(m => m.file === file.source);
      check(source && bytes[0] === 255 && bytes[1] === 216 && bytes.length === source.bytes && file.bytes === source.bytes && digest(bytes) === source.sha256 && file.sha256 === source.sha256, 'TARGET_IMAGE_MISMATCH');
      report.files.push({ path: file.path, logicalId: file.logicalId, bytes: bytes.length, sha256: digest(bytes), sourceMatched: true });
    }
    const aggregated = await q('SELECT c.id,c.is_archived,COUNT(d.id) wearCount,MAX(d.wear_date) lastWornDate FROM clothes c LEFT JOIN diary_items i ON i.clothing_id=c.id LEFT JOIN diaries d ON d.id=i.diary_id AND d.user_id=c.user_id AND d.wear_date<=? WHERE c.user_id=? GROUP BY c.id,c.is_archived ORDER BY wearCount DESC,c.id ASC', [asOf, uid]);
    const fromSource = data.clothes.map(source => {
      const history = data.diaries.filter(d => d.clothingIds.includes(source.id) && d.wearDate <= asOf);
      return { id: map.clothes[source.id], is_archived: Number(source.isArchived), wearCount: history.length, lastWornDate: history.map(d => d.wearDate).sort().at(-1) ?? null };
    }).sort((a, b) => b.wearCount - a.wearCount || a.id - b.id);
    const actual = aggregated.map(x => ({ ...x, wearCount: Number(x.wearCount) })); assert.deepEqual(actual, fromSource);
    const top = actual.filter(x => !x.is_archived && x.wearCount > 0).slice(0, 5);
    const topSql = await q('SELECT c.id,COUNT(d.id) wearCount,MAX(d.wear_date) lastWornDate FROM clothes c JOIN diary_items i ON i.clothing_id=c.id JOIN diaries d ON d.id=i.diary_id AND d.user_id=c.user_id WHERE c.user_id=? AND c.is_archived=0 AND d.wear_date<=? GROUP BY c.id ORDER BY wearCount DESC,c.id ASC LIMIT 5', [uid, asOf]);
    assert.deepEqual(topSql.map(x => ({ ...x, wearCount: Number(x.wearCount) })), top.map(({ id, wearCount, lastWornDate }) => ({ id, wearCount, lastWornDate })));
    const startDate = new Date(asOf + 'T00:00:00Z'); startDate.setUTCDate(startDate.getUTCDate() - 29); const start = startDate.toISOString().slice(0, 10);
    const notWorn = await q('SELECT c.id FROM clothes c WHERE c.user_id=? AND c.is_archived=0 AND NOT EXISTS (SELECT 1 FROM diary_items i JOIN diaries d ON d.id=i.diary_id WHERE i.clothing_id=c.id AND d.user_id=c.user_id AND d.wear_date>=? AND d.wear_date<=?) ORDER BY c.id', [uid, start, asOf]);
    const expectedNotWorn = data.clothes.filter(x => !x.isArchived && !data.diaries.some(d => d.clothingIds.includes(x.id) && d.wearDate >= start && d.wearDate <= asOf)).map(x => map.clothes[x.id]).sort((a, b) => a - b);
    assert.deepEqual(notWorn.map(x => x.id), expectedNotWorn);
    const categoriesSql = await q('SELECT cat.id,COUNT(c.id) n FROM categories cat LEFT JOIN clothes c ON c.category_id=cat.id AND c.user_id=? AND c.is_archived=0 GROUP BY cat.id,cat.sort_order ORDER BY cat.sort_order', [uid]);
    assert.deepEqual(categoriesSql.map(x => Number(x.n)), data.categories.map(cat => data.clothes.filter(c => c.categoryId === cat.id && !c.isArchived).length));
    const monthly = {};
    for (const month of ['2026-10', '2026-11']) {
      const after = month === '2026-10' ? '2026-11-01' : '2026-12-01';
      monthly[month] = Number((await q('SELECT COUNT(*) n FROM diaries WHERE user_id=? AND wear_date>=? AND wear_date<?', [uid, month + '-01', after]))[0].n);
      check(monthly[month] === data.diaries.filter(d => d.wearDate.startsWith(month)).length && monthly[month] === summary.monthDiaryCounts[month], 'MONTH_COUNT_MISMATCH');
    }
    // The source has a diary on Oct 7, but none on Oct 8; test both DATE predicates without creating a diary.
    const boundary = await q("SELECT b.wear_date,(b.wear_date>=? AND b.wear_date<=?) included,(SELECT COUNT(*) FROM diaries d WHERE d.user_id=? AND d.wear_date=b.wear_date) diaryCount FROM (SELECT DATE('2026-10-07') wear_date UNION ALL SELECT DATE('2026-10-08')) b ORDER BY b.wear_date", [start, asOf, uid]);
    check(boundary.length === 2 && boundary.every(x => Boolean(x.included) === (x.wear_date >= start && x.wear_date <= asOf)), 'WINDOW_BOUNDARY_MISMATCH');
    const reverse = Object.fromEntries(Object.entries(map.clothes).map(([key, id]) => [id, key]));
    if (asOf === '2026-11-06') {
      assert.deepEqual(top.map(x => ({ id: reverse[x.id], count: x.wearCount })), summary.mostWorn);
      assert.deepEqual(notWorn.map(x => reverse[x.id]), summary.neverWorn);
      assert.deepEqual(boundary.map(x => Number(x.included)), [0, 1]);
    }
    report.verifiedRows = verified;
    report.statistics = { asOf, window: [start, asOf], categoryCounts: categoriesSql.map(x => Number(x.n)), monthly, wear: actual.map(x => ({ ...x, logicalId: reverse[x.id] })), top5: top.map(x => ({ ...x, logicalId: reverse[x.id] })), neverWorn: actual.filter(x => x.wearCount === 0).map(x => reverse[x.id]).sort(), notWornRecently: notWorn.map(x => reverse[x.id]), boundary };
    await c.commit(); transaction = false;
    report.state = 'verified'; report.userId = uid;
  } catch (e) {
    report.state = 'verification-failed'; report.error = safeError(e); process.exitCode = 1;
  } finally {
    if (c) { if (transaction) await c.rollback(); await c.end(); }
    report.completedAt = new Date().toISOString(); await writeJson(path.join(run.dir, 'verification.json'), report);
  }
  console.log(JSON.stringify({ verifyId: run.runId, importRunId: runId, state: report.state, files: report.files?.length, error: report.error }));
  return report;
}

async function main() {
  if (process.argv.length === 2) { console.log('Usage: verify-demo.mjs --run <importRunId> [--as-of YYYY-MM-DD]'); return; }
  const args = process.argv.slice(2); const runId = args[1]; const asOf = args[3] ?? '2026-11-06';
  check(args[0] === '--run' && /^[a-zA-Z0-9_-]+$/.test(runId) && (args.length === 2 || (args.length === 4 && args[2] === '--as-of')) && validDate(asOf), 'INVALID_VERIFY_ARGUMENTS');
  await verify(runId, asOf);
}
if (import.meta.main) { try { await main(); } catch (e) { console.error(JSON.stringify({ state: 'failed', error: safeError(e) })); process.exitCode = 1; } }
