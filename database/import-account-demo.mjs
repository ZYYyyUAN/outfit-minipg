import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, uploads, loadSource, connect, normalizeMood, digest } from './demo-common.mjs';

// Existing accounts are preserved; this operation only fills an empty wardrobe.
export async function importAccountDemo(username) {
  const { data, manifests } = await loadSource();
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const directory = path.join(root, 'docs/evidence/account-demo', runId);
  await fs.mkdir(directory, { recursive: true });
  const report = { runId, username, datasetVersion: data.datasetVersion, committed: false, files: [], map: { clothes: {}, outfits: {}, diaries: {} } };
  const c = await connect();
  let transaction = false;
  try {
    await c.beginTransaction(); transaction = true;
    const [users] = await c.execute('SELECT * FROM users WHERE username=? FOR UPDATE', [username]);
    if (users.length !== 1) throw new Error('TARGET_ACCOUNT_NOT_FOUND');
    const user = users[0]; report.userId = user.id;
    const userBefore = digest(Buffer.from(JSON.stringify(user)));
    for (const table of ['clothes', 'outfits', 'diaries']) {
      const [[row]] = await c.execute(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`, [user.id]);
      if (Number(row.n)) throw new Error('TARGET_NOT_EMPTY_NO_OVERWRITE');
    }
    const [categories] = await c.execute('SELECT id,name,sort_order FROM categories ORDER BY sort_order');
    if (JSON.stringify(categories) !== JSON.stringify(data.categories.map(x => ({ id: x.id, name: x.name, sort_order: x.sortOrder })))) throw new Error('CATEGORY_MISMATCH');
    const time = new Date().toISOString().replace('T', ' ').slice(0, 23);
    const insert = async (table, values) => {
      const keys = Object.keys(values);
      const [result] = await c.execute(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(values));
      return result.insertId;
    };
    await fs.mkdir(path.join(uploads, 'users', String(user.id)), { recursive: true });
    const copy = async (source, logicalId) => {
      const spec = manifests.find(x => x.file === source);
      const imagePath = `users/${user.id}/${randomUUID()}.jpg`;
      const bytes = await fs.readFile(path.join(root, source));
      await fs.writeFile(path.join(uploads, imagePath), bytes, { flag: 'wx' });
      const copied = await fs.readFile(path.join(uploads, imagePath));
      if (digest(copied) !== spec.sha256) throw new Error('COPIED_IMAGE_MISMATCH');
      report.files.push({ logicalId, source, imagePath, bytes: copied.length, sha256: spec.sha256 });
      return imagePath;
    };
    for (const item of data.clothes) {
      report.map.clothes[item.id] = await insert('clothes', { user_id: user.id, category_id: item.categoryId, name: item.name, image_path: await copy(item.imagePath, item.id), color: item.color, season: item.season, note: item.note, is_archived: Number(item.isArchived), created_at: time, updated_at: time });
    }
    for (const item of data.outfits) {
      const id = await insert('outfits', { user_id: user.id, name: item.name, occasion: item.occasion, note: item.note, is_archived: Number(item.isArchived), created_at: time, updated_at: time });
      report.map.outfits[item.id] = id;
      for (const [i, key] of item.clothingIds.entries()) await insert('outfit_items', { outfit_id: id, clothing_id: report.map.clothes[key], sort_order: i + 1 });
    }
    for (const item of data.diaries) {
      const id = await insert('diaries', { user_id: user.id, wear_date: item.wearDate, source_outfit_id: item.sourceOutfitId === null ? null : report.map.outfits[item.sourceOutfitId], occasion: item.occasion, mood: normalizeMood(item.mood), note: item.note, photo_path: item.photoPath === null ? null : await copy(item.photoPath, item.id), created_at: time, updated_at: time });
      report.map.diaries[item.id] = id;
      for (const [i, key] of item.clothingIds.entries()) await insert('diary_items', { diary_id: id, clothing_id: report.map.clothes[key], sort_order: i + 1 });
    }
    const [after] = await c.execute('SELECT * FROM users WHERE id=?', [user.id]);
    if (digest(Buffer.from(JSON.stringify(after[0]))) !== userBefore) throw new Error('ACCOUNT_CHANGED');
    report.counts = {};
    for (const [table, parent, foreign] of [['clothes'], ['outfits'], ['diaries'], ['outfit_items', 'outfits', 'outfit_id'], ['diary_items', 'diaries', 'diary_id']]) {
      const sql = parent ? `SELECT COUNT(*) n FROM ${table} i JOIN ${parent} p ON p.id=i.${foreign} WHERE p.user_id=?` : `SELECT COUNT(*) n FROM ${table} WHERE user_id=?`;
      const [[row]] = await c.execute(sql, [user.id]); report.counts[table] = Number(row.n);
    }
    if (JSON.stringify(Object.values(report.counts)) !== JSON.stringify([24, 8, 12, 37, 53]) || report.files.length !== 25) throw new Error('IMPORT_COUNT_MISMATCH');
    await c.commit(); transaction = false; report.committed = true;
    report.accountUnchanged = true;
  } catch (error) {
    if (transaction) await c.rollback();
    report.error = error.code || error.message;
    throw error;
  } finally {
    await c.end();
    await fs.writeFile(path.join(directory, 'import-result.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ committed: report.committed, userId: report.userId, counts: report.counts, images: report.files.length, report: path.relative(root, path.join(directory, 'import-result.json')).replaceAll('\\', '/') }));
}

if (import.meta.main) {
  if (process.argv.length === 2) console.log('Usage: node --env-file=server/.env database/import-account-demo.mjs --apply <existing-username> (requires empty clothes/outfits/diaries)');
  else if (process.argv.length === 4 && process.argv[2] === '--apply' && /^[a-z0-9_]{4,20}$/.test(process.argv[3])) await importAccountDemo(process.argv[3]);
  else throw new Error('INVALID_ARGUMENTS');
}
