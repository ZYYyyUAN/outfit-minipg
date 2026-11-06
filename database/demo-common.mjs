import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { inspect, validateEnvironment, structure } from './verify-schema.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const evidenceRoot = path.join(root, 'docs/evidence/P2-03');
export const uploads = path.join(root, 'server/uploads');
export const tables = ['users', 'categories', 'clothes', 'outfits', 'outfit_items', 'diaries', 'diary_items'];
export const expectedCounts = { users: 1, categories: 7, clothes: 24, outfits: 8, outfit_items: 37, diaries: 12, diary_items: 53 };
export const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const readJson = async p => JSON.parse(await fs.readFile(p, 'utf8'));
export const writeJson = (p, value) => fs.writeFile(p, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
export const normalizeMood = mood => mood === null || mood.trim() === '' ? null : mood.trim();
export const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const text = (value, min, max) => typeof value === 'string' && Array.from(value).length >= min && Array.from(value).length <= max;
const unique = values => new Set(values).size === values.length;

export function validateDataset(d, manifests) {
  check(d.schemaVersion === 1 && d.datasetVersion === 'korean-daily-20261106' && d.datasetType === 'demo', 'INVALID_DATASET_VERSION');
  check(d.demoProfile.id === 'DEMO001' && text(d.demoProfile.nickname, 1, 20), 'INVALID_DEMO_PROFILE');
  const categoryIds = ['tops', 'outerwear', 'dresses', 'bottoms', 'shoes', 'bags', 'accessories'];
  const categoryNames = ['上装', '外套', '连衣裙', '下装', '鞋履', '包袋', '配饰'];
  for (const [name, prefix, total] of [['clothes', 'CLO', 24], ['outfits', 'OUT', 8], ['diaries', 'DIA', 12]]) {
    check(Array.isArray(d[name]) && d[name].length === total, 'INVALID_' + name.toUpperCase() + '_COUNT');
    check(unique(d[name].map(x => x.id)), 'DUPLICATE_LOGICAL_ID');
    for (const [i, item] of d[name].entries()) {
      check(item.id === prefix + String(i + 1).padStart(3, '0'), 'INVALID_SOURCE_ID_ORDER');
      check(item.userId === 'DEMO001', 'INVALID_SOURCE_OWNER');
    }
  }
  check(Array.isArray(d.categories) && d.categories.length === 7 && d.categories.every((c, i) => c.id === categoryIds[i] && c.name === categoryNames[i] && c.sortOrder === i + 1), 'INVALID_CATEGORIES');
  check(manifests.length === 25 && unique(manifests.map(x => x.file)), 'INVALID_MANIFEST');
  for (const m of manifests) check(/^assets\/(clothes\/clothing-\d{3}|diaries\/diary-004)\.jpg$/.test(m.file) && /^[a-f0-9]{64}$/.test(m.sha256) && Number.isInteger(m.bytes) && m.bytes > 0, 'INVALID_IMAGE_MANIFEST');
  const imageRefs = [];
  for (const c of d.clothes) {
    check(text(c.name, 1, 40) && categoryIds.includes(c.categoryId) && text(c.color, 1, 20) && ['春', '夏', '秋', '冬', '春夏', '春秋', '秋冬', '四季'].includes(c.season) && text(c.note, 0, 500) && typeof c.isArchived === 'boolean', 'INVALID_CLOTHING_FIELD');
    check(/^assets\/clothes\/clothing-\d{3}\.jpg$/.test(c.imagePath), 'INVALID_IMAGE_PATH');
    check(manifests.some(m => m.file === c.imagePath && m.clothingId === c.id), 'INVALID_CLOTHING_IMAGE_REFERENCE');
    imageRefs.push(c.imagePath);
  }
  const ids = new Set(d.clothes.map(x => x.id));
  for (const o of [...d.outfits, ...d.diaries]) {
    check(Array.isArray(o.clothingIds) && o.clothingIds.length >= 1 && o.clothingIds.length <= 20 && unique(o.clothingIds) && o.clothingIds.every(id => ids.has(id)), 'INVALID_CLOTHING_SELECTION');
    check(text(o.occasion, 1, 20), 'INVALID_OCCASION');
  }
  for (const o of d.outfits) check(text(o.name, 1, 40) && text(o.note, 0, 500) && typeof o.isArchived === 'boolean', 'INVALID_OUTFIT_FIELD');
  check(unique(d.diaries.map(x => x.wearDate)), 'DUPLICATE_DIARY_DATE');
  for (const diary of d.diaries) {
    check(validDate(diary.wearDate), 'INVALID_DIARY_DATE');
    check(diary.sourceOutfitId === null || d.outfits.some(o => o.id === diary.sourceOutfitId), 'INVALID_SOURCE_OUTFIT');
    check(diary.mood === null || text(diary.mood, 0, 12), 'INVALID_MOOD');
    check(text(diary.note, 0, 1000), 'INVALID_DIARY_NOTE');
    check(diary.photoPath === null || /^assets\/diaries\/diary-004\.jpg$/.test(diary.photoPath), 'INVALID_PHOTO_PATH');
    if (diary.photoPath !== null) { check(manifests.some(m => m.file === diary.photoPath && Array.isArray(m.relatedClothingIds) && m.relatedClothingIds.every(id => diary.clothingIds.includes(id))), 'INVALID_DIARY_PHOTO_REFERENCE'); imageRefs.push(diary.photoPath); }
  }
  check(imageRefs.length === 25 && unique(imageRefs) && imageRefs.every(p => manifests.some(m => m.file === p)), 'INVALID_IMAGE_REFERENCE_COUNT');
  check(d.outfits.reduce((n, x) => n + x.clothingIds.length, 0) === 37 && d.diaries.reduce((n, x) => n + x.clothingIds.length, 0) === 53, 'INVALID_ITEM_COUNT');
}

export async function loadSource() {
  const data = await readJson(path.join(root, 'data/demo-data.json'));
  const summary = await readJson(path.join(root, 'data/demo-summary.json'));
  const manifests = [...await readJson(path.join(root, 'assets/source-manifest.json')), ...await readJson(path.join(root, 'assets/diary-photo-manifest.json'))];
  validateDataset(data, manifests);
  for (const m of manifests) {
    const bytes = await fs.readFile(path.join(root, m.file));
    check(bytes[0] === 255 && bytes[1] === 216 && bytes.length === m.bytes && digest(bytes) === m.sha256, 'SOURCE_IMAGE_MISMATCH');
  }
  return { data, summary, manifests };
}

export async function implementationHashes() {
  const files = ['data/demo-data.json', 'data/demo-summary.json', 'assets/source-manifest.json', 'assets/diary-photo-manifest.json', 'database/schema.sql', 'database/package-lock.json', 'database/verify-schema.mjs', 'database/demo-common.mjs', 'database/seed-demo.mjs', 'database/verify-demo.mjs', 'database/run-demo-local.mjs', 'database/run-demo-local.ps1', 'database/demo-tools.test.mjs', 'shared/password.mjs'];
  return Object.fromEntries(await Promise.all(files.map(async p => [p, digest(await fs.readFile(path.join(root, p)))])));
}

export async function newRun(kind) {
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + kind + '-' + randomUUID().slice(0, 8);
  await fs.mkdir(evidenceRoot, { recursive: true });
  const dir = path.join(evidenceRoot, runId); await fs.mkdir(dir);
  return { runId, dir, report: { runId, kind, startedAt: new Date().toISOString(), state: 'started', hashes: await implementationHashes() } };
}

export async function connect() {
  for (const key of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME', 'DB_PASSWORD']) check(process.env[key] !== undefined, 'MISSING_' + key);
  check(process.env.DB_HOST === '127.0.0.1' && process.env.DB_PORT === '3306' && process.env.DB_NAME === 'wardrobe_demo', 'INVALID_DATABASE_TARGET');
  const c = await mysql.createConnection({ host: process.env.DB_HOST, port: 3306, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, charset: 'utf8mb4', timezone: 'Z', dateStrings: true, multipleStatements: false });
  await c.query('SET NAMES utf8mb4 COLLATE utf8mb4_0900_as_cs');
  await c.query("SET SESSION time_zone='+00:00'");
  await c.query('SET SESSION information_schema_stats_expiry=0');
  return c;
}

export async function preflight(c, requireEmpty) {
  const environment = await inspect(c); validateEnvironment(environment);
  const metadata = await structure(c, environment);
  const rows = await counts(c);
  if (requireEmpty) check(Object.values(rows).every(n => n === 0), 'NON_EMPTY_DATABASE');
  return { environment, metadata, counts: rows };
}
export async function counts(c) {
  const result = {};
  for (const t of tables) result[t] = Number((await c.query(`SELECT COUNT(*) n FROM wardrobe_demo.${t}`))[0][0].n);
  return result;
}
export function demoPassword() { const p = process.env.DEMO_PASSWORD; check(text(p, 8, 64), 'MISSING_OR_INVALID_DEMO_PASSWORD'); return p; }
export function validateMap(data, map) {
  const groups = { users: [data.demoProfile], clothes: data.clothes, outfits: data.outfits, diaries: data.diaries };
  for (const [kind, source] of Object.entries(groups)) {
    check(map[kind] && Object.keys(map[kind]).length === source.length && source.every(x => Number.isInteger(map[kind][x.id]) && map[kind][x.id] > 0) && unique(Object.values(map[kind])), 'INVALID_ID_MAP_' + kind);
  }
  check(map.categories && Object.keys(map.categories).length === 7 && data.categories.every(x => map.categories[x.id] === x.id), 'INVALID_CATEGORY_MAP');
}
export async function copyExclusive(src, dest) { await fs.copyFile(src, dest, fs.constants.COPYFILE_EXCL); }
export function safeError(e) { return { code: e.code ?? 'CHECK_FAILED', errno: e.errno, sqlState: e.sqlState }; }
