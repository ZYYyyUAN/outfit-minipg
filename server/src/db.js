import mysql from 'mysql2/promise';

export function createDatabase(config) {
  const pool = mysql.createPool({ ...config.db, charset: 'utf8mb4', timezone: 'Z', dateStrings: true, multipleStatements: false, connectionLimit: 5, waitForConnections: true });
  return {
    async getConnection() {
      const connection = await pool.getConnection();
      try {
        await connection.query('SET NAMES utf8mb4 COLLATE utf8mb4_0900_as_cs');
        await connection.query("SET SESSION time_zone='+00:00'");
      } catch (error) { connection.destroy(); throw error; }
      return connection;
    },
    end: () => pool.end(),
  };
}
export async function probe(connection) {
  const [rows] = await connection.query('SELECT VERSION() version,@@hostname hostname,@@port port,CURRENT_USER() account,DATABASE() db,CONNECTION_ID() connectionId,@@session.time_zone timeZone,@@character_set_client clientCharset,@@character_set_connection connectionCharset,@@character_set_results resultsCharset,@@collation_connection connectionCollation');
  const [tables] = await connection.query('SELECT TABLE_NAME name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME');
  const identity = rows[0];
  if (identity.db !== 'wardrobe_demo' || identity.timeZone !== '+00:00' || identity.connectionCollation !== 'utf8mb4_0900_as_cs' || ['clientCharset','connectionCharset','resultsCharset'].some(k=>identity[k]!=='utf8mb4') || tables.map(t=>t.name).join(',') !== 'categories,clothes,diaries,diary_items,outfit_items,outfits,users') throw Object.assign(new Error('DATABASE_TARGET_MISMATCH'), { code: 'DATABASE_TARGET_MISMATCH' });
  return identity;
}
