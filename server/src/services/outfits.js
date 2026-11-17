import { BusinessError } from '../utils/business-error.js';
import { utcSql } from './account.js';
import { literalLike, utcIso } from './clothes.js';

const notFound = () => new BusinessError(404, 'NOT_FOUND', '搭配不存在或无法访问');

export function createOutfitService(database, config, now = () => new Date()) {
  const clothing = row => ({ id: row.id, name: row.name, categoryId: row.category_id, color: row.color, season: row.season,
    imagePath: row.image_path, imageUrl: row.image_path === null ? null : config.publicBaseUrl + '/api/media/' + row.image_path.split('/').at(-1), isArchived: Boolean(row.is_archived) });
  async function transaction(work, readOnly = false) {
    const connection = await database.getConnection();
    try {
      if (readOnly) {
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      } else await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }
  function scope(userId, archived) {
    return { sql: 'user_id=?' + (archived === 'all' ? '' : ' AND is_archived=?'), values: archived === 'all' ? [userId] : [userId, archived === 'archived' ? 1 : 0] };
  }
  async function owned(connection, userId, id, lock = false) {
    const [rows] = await connection.execute('SELECT * FROM outfits WHERE id=? AND user_id=?' + (lock ? ' FOR UPDATE' : ''), [id, userId]);
    if (!rows.length) throw notFound();
    return rows[0];
  }
  async function children(connection, userId, ids) {
    const grouped = new Map(ids.map(id => [id, []]));
    if (!ids.length) return grouped;
    const [rows] = await connection.execute(`SELECT i.outfit_id parentId,c.* FROM outfit_items i JOIN outfits p ON p.id=i.outfit_id JOIN clothes c ON c.id=i.clothing_id WHERE p.user_id=? AND c.user_id=? AND p.id IN (${ids.map(() => '?').join(',')}) ORDER BY i.outfit_id,i.sort_order`, [userId, userId, ...ids]);
    for (const row of rows) grouped.get(row.parentId).push(clothing(row));
    return grouped;
  }
  async function detailOn(connection, userId, id) {
    const row = await owned(connection, userId, id), items = (await children(connection, userId, [id])).get(id);
    return { id: row.id, name: row.name, occasion: row.occasion, note: row.note, isArchived: Boolean(row.is_archived), items,
      createdAt: utcIso(row.created_at), updatedAt: utcIso(row.updated_at) };
  }
  async function selection(connection, userId, ids) {
    const [rows] = await connection.execute(`SELECT id FROM clothes WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`, [userId, ...ids]);
    if (rows.length !== ids.length) throw new BusinessError(400, 'INVALID_SELECTION', '请检查所选衣物', { clothingIds: '请选择本人已有的衣物' });
  }
  async function insertItems(connection, id, ids) {
    for (const [index, clothingId] of ids.entries()) await connection.execute('INSERT INTO outfit_items (outfit_id,clothing_id,sort_order) VALUES (?,?,?)', [id, clothingId, index + 1]);
  }
  return {
    list(userId, input) {
      const where = scope(userId, input.archived);
      if (input.keyword) { where.sql += " AND LOWER(name) LIKE ? ESCAPE '!'"; where.values.push(literalLike(input.keyword)); }
      if (input.occasion !== undefined) { where.sql += ' AND occasion=?'; where.values.push(input.occasion); }
      return transaction(async connection => {
        const [[count]] = await connection.execute('SELECT COUNT(*) total FROM outfits WHERE ' + where.sql, where.values);
        const [rows] = await connection.execute(`SELECT * FROM outfits WHERE ${where.sql} ORDER BY id DESC LIMIT ${input.pageSize} OFFSET ${input.offset}`, where.values);
        const grouped = await children(connection, userId, rows.map(row => row.id));
        return { items: rows.map(row => ({ id: row.id, name: row.name, occasion: row.occasion, isArchived: Boolean(row.is_archived),
          clothingCount: grouped.get(row.id).length, previewItems: grouped.get(row.id).slice(0, 4) })), page: input.page, pageSize: input.pageSize, total: Number(count.total) };
      }, true);
    },
    facets(userId, archived) {
      const where = scope(userId, archived);
      return transaction(async connection => {
        const [rows] = await connection.execute('SELECT DISTINCT occasion FROM outfits WHERE ' + where.sql + ' ORDER BY occasion', where.values);
        return { occasions: rows.map(row => row.occasion) };
      }, true);
    },
    detail(userId, id) { return transaction(connection => detailOn(connection, userId, id), true); },
    create(userId, input) {
      return transaction(async connection => {
        await selection(connection, userId, input.clothingIds);
        const time = utcSql(now());
        const [result] = await connection.execute('INSERT INTO outfits (user_id,name,occasion,note,is_archived,created_at,updated_at) VALUES (?,?,?,?,0,?,?)', [userId, input.name, input.occasion, input.note, time, time]);
        await insertItems(connection, result.insertId, input.clothingIds);
        return detailOn(connection, userId, result.insertId);
      });
    },
    update(userId, id, input) {
      return transaction(async connection => {
        await owned(connection, userId, id, true);
        await selection(connection, userId, input.clothingIds);
        await connection.execute('UPDATE outfits SET name=?,occasion=?,note=?,updated_at=? WHERE id=? AND user_id=?', [input.name, input.occasion, input.note, utcSql(now()), id, userId]);
        await connection.execute('DELETE FROM outfit_items WHERE outfit_id=?', [id]);
        await insertItems(connection, id, input.clothingIds);
        return detailOn(connection, userId, id);
      });
    },
    archive(userId, id, isArchived) {
      return transaction(async connection => {
        const row = await owned(connection, userId, id, true);
        if (Boolean(row.is_archived) !== isArchived) await connection.execute('UPDATE outfits SET is_archived=?,updated_at=? WHERE id=? AND user_id=?', [isArchived ? 1 : 0, utcSql(now()), id, userId]);
        return detailOn(connection, userId, id);
      });
    },
  };
}
