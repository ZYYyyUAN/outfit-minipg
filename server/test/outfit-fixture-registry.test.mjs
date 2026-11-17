import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureManifestRows } from '../scripts/outfit-http.mjs';

const fixture = { accounts: { a: { id: 2 } }, clothes: { A1: { id: 10 } }, outfits: { A1: { id: 20, clothingIds: [10] } }, diaries: { A1: { id: 30, clothingIds: [10] } } };
const data = {
  users: [{ id: 1 }, { id: 2 }], clothes: [{ id: 10, user_id: 2 }, { id: 11, user_id: 1 }], outfits: [{ id: 20, user_id: 2 }],
  outfit_items: [{ outfit_id: 20, clothing_id: 10, sort_order: 1 }], diaries: [{ id: 30, user_id: 2, wear_date: '2026-10-09' }],
  diary_items: [{ diary_id: 30, clothing_id: 10, sort_order: 1 }],
};
test('fixture manifest includes only explicitly registered owned keys and current ordered relations', () => {
  const result = fixtureManifestRows(data, fixture);
  assert.deepEqual(result.unknownRows, []); assert.deepEqual(result.missingRows, []);
  assert.equal(result.rows.length, 6); assert.ok(result.rows.every(row => row.ownerId === 2));
});
for (const [table, row] of [
  ['clothes', { id: 12, user_id: 2 }], ['outfits', { id: 21, user_id: 2 }], ['diaries', { id: 31, user_id: 2, wear_date: '2026-10-10' }],
  ['outfit_items', { outfit_id: 20, clothing_id: 11, sort_order: 2 }], ['diary_items', { diary_id: 30, clothing_id: 11, sort_order: 2 }],
]) test('unregistered owned ' + table + ' is reported and cannot be silently enrolled in the manifest', () => {
  const actual = structuredClone(data); actual[table].push(row);
  const result = fixtureManifestRows(actual, fixture);
  assert.equal(result.rows.length, 6); assert.equal(result.unknownRows.length, 1); assert.equal(result.unknownRows[0].table, table);
});
test('missing registered rows and unregistered item order fail the fixture inventory', () => {
  for (const table of Object.keys(data)) {
    const actual = structuredClone(data); actual[table] = [];
    const result = fixtureManifestRows(actual, fixture);
    assert.ok(result.missingRows.some(row => row.table === table));
  }
  const actual = structuredClone(data); actual.outfit_items[0].sort_order = 2;
  const result = fixtureManifestRows(actual, fixture);
  assert.deepEqual(result.unknownRows, [{ table: 'outfit_items', key: '20:10', ownerId: 2, reason: 'UNREGISTERED_ORDER' }]);
});
