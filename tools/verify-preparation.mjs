import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(resolve(root, 'data/demo-data.json'), 'utf8'));
const sources = JSON.parse(readFileSync(resolve(root, 'assets/source-manifest.json'), 'utf8'));
const summary = JSON.parse(readFileSync(resolve(root, 'data/demo-summary.json'), 'utf8'));
const diaryPhotos = JSON.parse(readFileSync(resolve(root, 'assets/diary-photo-manifest.json'), 'utf8'));

function uniqueIds(rows, label) {
  const ids = new Set(rows.map(row => row.id));
  assert.equal(ids.size, rows.length, `${label}: duplicate IDs`);
  return ids;
}

const categoryIds = uniqueIds(data.categories, 'categories');
const clothingIds = uniqueIds(data.clothes, 'clothes');
const outfitIds = uniqueIds(data.outfits, 'outfits');
uniqueIds(data.diaries, 'diaries');
assert.equal(data.clothes.length, 24);
assert.equal(data.outfits.length, 8);
assert.equal(data.diaries.length, 12);
assert.equal(sources.length, data.clothes.length);
assert.equal(new Set(sources.map(source => source.clothingId)).size, sources.length);
assert.equal(new Set(sources.map(source => source.sha256)).size, sources.length, 'duplicate image content');

const imagePaths = new Set();
for (const clothing of data.clothes) {
  assert(categoryIds.has(clothing.categoryId), `${clothing.id}: invalid category`);
  assert.equal(clothing.userId, data.demoProfile.id);
  const source = sources.find(row => row.clothingId === clothing.id);
  assert.equal(source.file, clothing.imagePath);
  assert.equal(source.name, clothing.name);
  assert.equal(source.visualChecked, true);
  if (source.provider === 'Pexels') {
    assert(source.sourceUrl.startsWith('https://www.pexels.com/photo/'));
    assert(source.photographer && source.photographer !== '待核对');
  } else {
    assert.equal(source.provider, 'CHERRYKOKO');
    assert.equal(new URL(source.sourceUrl).hostname, 'en.cherrykoko.com');
    assert.equal(source.licenseVerifiedForRedistribution, false);
  }
  assert(source.width >= 600 && source.height >= 600, `${clothing.id}: insufficient image dimensions`);
  const bytes = readFileSync(resolve(root, clothing.imagePath));
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  assert.equal(bytes.length, source.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
  imagePaths.add(clothing.imagePath);
}

for (const photo of diaryPhotos) {
  const bytes = readFileSync(resolve(root, photo.file));
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  assert.equal(bytes.length, photo.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), photo.sha256);
  assert.equal(photo.visualChecked, true);
  for (const id of photo.relatedClothingIds) assert(clothingIds.has(id));
}

for (const outfit of data.outfits) {
  assert.equal(outfit.userId, data.demoProfile.id);
  assert(outfit.clothingIds.length > 0);
  assert.equal(new Set(outfit.clothingIds).size, outfit.clothingIds.length);
  for (const id of outfit.clothingIds) assert(clothingIds.has(id), `${outfit.id}: unknown clothing ${id}`);
}

const dates = new Set();
const wearCounts = new Map();
const monthDiaryCounts = {};
for (const diary of data.diaries) {
  assert.equal(diary.userId, data.demoProfile.id);
  assert.match(diary.wearDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(`${diary.wearDate}T00:00:00Z`).toISOString().slice(0, 10), diary.wearDate);
  assert(!dates.has(`${diary.userId}:${diary.wearDate}`), `duplicate diary date: ${diary.wearDate}`);
  dates.add(`${diary.userId}:${diary.wearDate}`);
  assert.equal(new Set(diary.clothingIds).size, diary.clothingIds.length);
  if (diary.sourceOutfitId !== null) assert(outfitIds.has(diary.sourceOutfitId));
  if (diary.photoPath !== null) {
    const photo = diaryPhotos.find(row => row.file === diary.photoPath);
    assert(photo, `${diary.id}: untracked diary photo`);
    for (const id of photo.relatedClothingIds) assert(diary.clothingIds.includes(id));
  }
  const month = diary.wearDate.slice(0, 7);
  monthDiaryCounts[month] = (monthDiaryCounts[month] ?? 0) + 1;
  for (const id of diary.clothingIds) {
    assert(clothingIds.has(id), `${diary.id}: unknown clothing ${id}`);
    wearCounts.set(id, (wearCounts.get(id) ?? 0) + 1);
  }
}

assert.deepEqual(monthDiaryCounts, summary.monthDiaryCounts);
assert.deepEqual(data.clothes.filter(row => !wearCounts.has(row.id)).map(row => row.id), summary.neverWorn);
for (const row of summary.mostWorn) assert.equal(wearCounts.get(row.id), row.count);
assert.equal(sources.reduce((total, row) => total + row.bytes, 0), summary.imagesBytes);
assert.equal(summary.clothes, data.clothes.length);
assert.equal(summary.outfits, data.outfits.length);
assert.equal(summary.diaries, data.diaries.length);

console.log(JSON.stringify({
  status: 'passed',
  clothes: data.clothes.length,
  outfits: data.outfits.length,
  diaries: data.diaries.length,
  localImages: sources.length,
  diaryPhotos: diaryPhotos.length,
  months: monthDiaryCounts,
  neverWorn: summary.neverWorn.length,
  imagesBytes: summary.imagesBytes,
}, null, 2));
