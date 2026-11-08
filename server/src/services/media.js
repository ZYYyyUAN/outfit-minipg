import * as filesystem from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { BusinessError } from '../utils/business-error.js';

const unsupported = () => new BusinessError(415, 'UNSUPPORTED_IMAGE', '请选择可解码的JPEG或PNG图片');
const notFound = () => new BusinessError(404, 'NOT_FOUND', '图片不存在');

export function createMediaService(database, config, { io = filesystem, makeId = randomUUID } = {}) {
  return {
    async categories() {
      const connection = await database.getConnection();
      try {
        const [rows] = await connection.query('SELECT id,name,sort_order FROM categories ORDER BY sort_order,id');
        return { items: rows.map(row => ({ id: row.id, name: row.name, sortOrder: row.sort_order })) };
      } finally { connection.release(); }
    },
    async upload(userId, buffer) {
      if (buffer.length === 0) throw unsupported();
      const image = sharp(buffer, { failOn: 'warning' });
      let format;
      try {
        ({ format } = await image.metadata());
        if (format !== 'jpeg' && format !== 'png') throw unsupported();
        await image.raw().toBuffer();
      } catch (error) {
        if (error instanceof BusinessError || error instanceof TypeError || error instanceof RangeError || error.code) throw error;
        throw unsupported();
      }
      const extension = format === 'jpeg' ? 'jpg' : 'png';
      const directory = path.resolve(config.uploadRoot, 'users', String(userId));
      const filename = makeId() + '.' + extension;
      const target = path.resolve(directory, filename);
      if (path.dirname(target) !== directory) throw new Error('INVALID_IMAGE_TARGET');
      await io.mkdir(directory, { recursive: true });
      const file = await io.open(target, 'wx');
      try { await file.writeFile(buffer); await file.close(); }
      catch (error) {
        // Only an exclusive open grants ownership of a file that may be removed.
        const closed = await Promise.allSettled([file.close()]);
        const removed = await Promise.allSettled([io.unlink(target)]);
        const failed = [...closed, ...removed].filter(result => result.status === 'rejected').map(result => result.reason);
        if (failed.length) throw Object.assign(new AggregateError([error, ...failed], 'IMAGE_CLEANUP_FAILED'), { code: 'IMAGE_CLEANUP_FAILED' });
        throw error;
      }
      return { imagePath: `users/${userId}/${filename}`, imageUrl: config.publicBaseUrl + '/api/media/' + filename,
        mimeType: 'image/' + format, size: buffer.length };
    },
    async read(userId, filename) {
      const target = path.join(config.uploadRoot, 'users', String(userId), filename);
      let file;
      try { file = await io.open(target, 'r'); }
      catch (error) { if (['ENOENT','ENOTDIR','EISDIR'].includes(error.code)) throw notFound(); throw error; }
      try {
        if (!(await file.stat()).isFile()) throw notFound();
        return { bytes: await file.readFile(), mimeType: filename.endsWith('.png') ? 'image/png' : 'image/jpeg' };
      } finally { await file.close(); }
    },
  };
}
