import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  if (!/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(encoded)) throw new Error('INVALID_PASSWORD_HASH');
  const [, n, r, p, salt, result] = encoded.split('$');
  const key = await derive(password, Buffer.from(salt, 'hex'), 64, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(key, Buffer.from(result, 'hex'));
}
