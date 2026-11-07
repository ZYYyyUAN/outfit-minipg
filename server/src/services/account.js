import { randomBytes, createHash } from 'node:crypto';
import { hashPassword, verifyPassword } from '../../../shared/password.mjs';
import { BusinessError, unauthenticated } from '../utils/business-error.js';
import { validateImageReference } from '../utils/image-reference.js';

export const utcSql = date => date.toISOString().replace('T', ' ').slice(0, 23);
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
export function publicUser(row, origin) {
  return { id: row.id, username: row.username, nickname: row.nickname, avatarPath: row.avatar_path,
    avatarUrl: row.avatar_path === null ? null : origin + '/api/media/' + row.avatar_path.split('/').at(-1) };
}
export function usernameConflict(error) {
  return error.code === 'ER_DUP_ENTRY' && error.errno === 1062 && /for key ['`](?:users\.)?uq_users_username['`]/.test(error.sqlMessage ?? '');
}
export function createAccountService(database, config, now = () => new Date()) {
  async function query(sql, values) {
    const connection = await database.getConnection();
    try { const [rows] = await connection.execute(sql, values); return rows; }
    finally { connection.release(); }
  }
  return {
    async register({ username, password, nickname }) {
      const encoded = await hashPassword(password), time = utcSql(now());
      let result;
      try {
        result = await query('INSERT INTO users (username,password_hash,nickname,avatar_path,auth_token_hash,auth_expires_at,created_at,updated_at) VALUES (?,?,?,NULL,NULL,NULL,?,?)', [username, encoded, nickname, time, time]);
      } catch (error) {
        if (usernameConflict(error)) throw new BusinessError(409, 'USERNAME_TAKEN', '该用户名已被使用', { username: '请换一个用户名' });
        throw error;
      }
      return publicUser({ id: result.insertId, username, nickname, avatar_path: null }, config.publicBaseUrl);
    },
    async login({ username, password }) {
      const rows = await query('SELECT id,username,nickname,avatar_path,password_hash FROM users WHERE username=?', [username]);
      if (!rows.length || !await verifyPassword(password, rows[0].password_hash)) throw new BusinessError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
      const issued = now(), token = randomBytes(32).toString('base64url');
      const expires = new Date(issued.getTime() + 7 * 24 * 60 * 60 * 1000);
      await query('UPDATE users SET auth_token_hash=?,auth_expires_at=?,updated_at=? WHERE id=?', [tokenHash(token), utcSql(expires), utcSql(issued), rows[0].id]);
      return { token, expiresAt: expires.toISOString(), user: publicUser(rows[0], config.publicBaseUrl) };
    },
    async authenticate(token) {
      const hash = tokenHash(token);
      const rows = await query('SELECT id,username,nickname,avatar_path FROM users WHERE auth_token_hash=? AND auth_expires_at>?', [hash, utcSql(now())]);
      if (!rows.length) throw unauthenticated();
      return { userId: rows[0].id, tokenHash: hash, user: publicUser(rows[0], config.publicBaseUrl) };
    },
    async logout(auth) {
      const result = await query('UPDATE users SET auth_token_hash=NULL,auth_expires_at=NULL,updated_at=? WHERE id=? AND auth_token_hash=?', [utcSql(now()), auth.userId, auth.tokenHash]);
      if (!result.affectedRows) throw unauthenticated();
      return { loggedOut: true };
    },
    async updateProfile(auth, { nickname, avatarPath }) {
      await validateImageReference(avatarPath, auth.userId, config.uploadRoot);
      await query('UPDATE users SET nickname=?,avatar_path=?,updated_at=? WHERE id=?', [nickname, avatarPath, utcSql(now()), auth.userId]);
      return publicUser({ id: auth.userId, username: auth.user.username, nickname, avatar_path: avatarPath }, config.publicBaseUrl);
    },
  };
}
