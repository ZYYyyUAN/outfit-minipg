import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../shared/password.mjs';
import { root, uploads, check, loadSource, newRun, connect, preflight, counts, demoPassword, normalizeMood, validateMap, copyExclusive, digest, writeJson, safeError, expectedCounts } from './demo-common.mjs';

export async function seed(mode) {
  const run = await newRun(mode.slice(2));
  const r = run.report;
  let c, transaction = false, committed = false;
  const files = [];
  const map = { users: {}, categories: {}, clothes: {}, outfits: {}, diaries: {} };
  try {
    const { data, manifests } = await loadSource();
    r.datasetVersion = data.datasetVersion;
    c = await connect(); r.preflight = await preflight(c, true);
    if (mode === '--check') r.state = 'check-passed';
    else {
      const passwordHash = await hashPassword(demoPassword());
      const timestamp = new Date().toISOString(); r.importTime = timestamp;
      const dbTime = timestamp.replace('T', ' ').slice(0, 23);
      const times = { created_at: dbTime, updated_at: dbTime };
      const insert = async (table, values) => {
        const columns = Object.keys(values);
        const [result] = await c.execute(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(values));
        return result.insertId;
      };
      check(Object.values(await counts(c)).every(n => n === 0), 'NON_EMPTY_DATABASE');
      await c.beginTransaction(); transaction = true; r.state = 'writing';
      for (const category of data.categories) { await insert('categories', { id: category.id, name: category.name, sort_order: category.sortOrder }); map.categories[category.id] = category.id; }
      const uid = await insert('users', { username: 'demo_user', nickname: data.demoProfile.nickname, password_hash: passwordHash, avatar_path: null, auth_token_hash: null, auth_expires_at: null, ...times });
      map.users[data.demoProfile.id] = uid;
      await fs.mkdir(path.join(uploads, 'users'), { recursive: true });
      await fs.mkdir(path.join(uploads, 'users', String(uid)));
      const copy = async (source, logicalId) => {
        const spec = manifests.find(x => x.file === source);
        const relative = `users/${uid}/${randomUUID()}.jpg`;
        const target = path.join(uploads, relative);
        await copyExclusive(path.join(root, source), target);
        const entry = { logicalId, source, path: relative, userId: uid, bytes: spec.bytes, sha256: spec.sha256, copied: true };
        files.push(entry);
        const bytes = await fs.readFile(target);
        check(bytes.length === spec.bytes && digest(bytes) === spec.sha256, 'COPIED_IMAGE_MISMATCH');
        return relative;
      };
      for (const item of data.clothes) map.clothes[item.id] = await insert('clothes', { user_id: uid, category_id: item.categoryId, name: item.name, color: item.color, season: item.season, note: item.note, is_archived: Number(item.isArchived), image_path: await copy(item.imagePath, item.id), ...times });
      for (const outfit of data.outfits) {
        const oid = await insert('outfits', { user_id: uid, name: outfit.name, occasion: outfit.occasion, note: outfit.note, is_archived: Number(outfit.isArchived), ...times }); map.outfits[outfit.id] = oid;
        for (const [i, id] of outfit.clothingIds.entries()) await insert('outfit_items', { outfit_id: oid, clothing_id: map.clothes[id], sort_order: i + 1 });
      }
      for (const diary of data.diaries) {
        const variant = mode === '--rollback-check' && diary.id === 'DIA004';
        const id = await insert('diaries', { user_id: uid, wear_date: diary.wearDate, source_outfit_id: diary.sourceOutfitId === null ? null : map.outfits[diary.sourceOutfitId], occasion: diary.occasion, mood: normalizeMood(variant ? '' : diary.mood), note: variant ? '' : diary.note, photo_path: diary.photoPath === null ? null : await copy(diary.photoPath, diary.id), ...times }); map.diaries[diary.id] = id;
        for (const [i, clothing] of diary.clothingIds.entries()) await insert('diary_items', { diary_id: id, clothing_id: map.clothes[clothing], sort_order: i + 1 });
      }
      validateMap(data, map);
      r.inTransactionCounts = await counts(c);
      check(JSON.stringify(r.inTransactionCounts) === JSON.stringify(expectedCounts), 'TRANSACTION_COUNT_MISMATCH');
      check(files.length === 25, 'COPIED_FILE_COUNT');
      await writeJson(path.join(run.dir, 'prepared-id-map.json'), { committed: false, map });
      await writeJson(path.join(run.dir, 'prepared-files.json'), { committed: false, files });
      if (mode === '--rollback-check') {
        const [rows] = await c.execute('SELECT mood,note FROM diaries WHERE id=?', [map.diaries.DIA004]);
        check(rows[0].mood === null && rows[0].note === '', 'EMPTY_VARIANT_NOT_SAVED');
        r.testVariant = { diary: 'DIA004', moodNull: true, noteEmpty: true, sourceFileUnchanged: true };
        r.failurePointReached = true;
        throw Object.assign(new Error('P203_EXPECTED_ROLLBACK'), { code: 'P203_EXPECTED_ROLLBACK' });
      }
      await c.commit(); transaction = false; committed = true; r.state = 'committed-unverified';
      await writeJson(path.join(run.dir, 'id-map.json'), { committed: true, datasetVersion: data.datasetVersion, map });
      await writeJson(path.join(run.dir, 'files-manifest.json'), { committed: true, files });
      r.countsAfterCommit = await counts(c); r.userId = uid;
    }
  } catch (e) {
    if (transaction) { await c.rollback(); transaction = false; r.rolledBack = true; }
    r.error = safeError(e); r.state = committed ? 'committed-unverified' : r.rolledBack ? 'rolled-back' : 'preflight-rejected';
    if (r.rolledBack) {
      r.sameConnectionCounts = await counts(c);
      check(Object.values(r.sameConnectionCounts).every(n => n === 0), 'SAME_CONNECTION_ROLLBACK_NOT_CONFIRMED');
      await c.end(); c = await connect(); r.reconnectedCounts = await counts(c);
      check(Object.values(r.reconnectedCounts).every(n => n === 0), 'ROLLBACK_NOT_CONFIRMED');
      if (mode === '--rollback-check' && e.code === 'P203_EXPECTED_ROLLBACK' && r.failurePointReached) r.state = 'rollback-verified';
    }
    if (r.state !== 'rollback-verified') process.exitCode = 1;
  } finally {
    if (c) await c.end();
    r.committed = committed; r.copiedFiles = files; r.completedAt = new Date().toISOString();
    await writeJson(path.join(run.dir, 'import-result.json'), r);
  }
  console.log(JSON.stringify({ runId: run.runId, state: r.state, userId: r.userId, files: files.length, error: r.error }));
  return r;
}

async function main() {
  if (process.argv.length === 2) { console.log('Usage: seed-demo.mjs --check|--rollback-check|--apply'); return; }
  check(process.argv.length === 3 && ['--check', '--rollback-check', '--apply'].includes(process.argv[2]), 'INVALID_MODE');
  await seed(process.argv[2]);
}
if (import.meta.main) {
  try { await main(); } catch (e) { console.error(JSON.stringify({ state: 'failed', error: safeError(e) })); process.exitCode = 1; }
}
