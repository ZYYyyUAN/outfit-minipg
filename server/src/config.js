import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function invalid(field) { throw Object.assign(new Error('INVALID_CONFIG'), { code: 'INVALID_CONFIG', field }); }
export function readConfig(env = process.env) {
  for (const key of ['PUBLIC_BASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'UPLOAD_ROOT']) {
    if (typeof env[key] !== 'string' || env[key].length === 0) invalid(key);
  }
  const integerPort = (value, field) => { if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) invalid(field); return Number(value); };
  const port = env.PORT === undefined ? 3000 : integerPort(env.PORT, 'PORT');
  const dbPort = integerPort(env.DB_PORT, 'DB_PORT');
  if (env.DB_HOST !== '127.0.0.1') invalid('DB_HOST');
  if (env.DB_NAME !== 'wardrobe_demo') invalid('DB_NAME');
  let origin;
  try { origin = new URL(env.PUBLIC_BASE_URL); } catch (e) { if (!(e instanceof TypeError)) throw e; invalid('PUBLIC_BASE_URL'); }
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || Number(origin.port || 80) !== port) invalid('PUBLIC_BASE_URL');
  const uploadRoot = path.resolve(serverRoot, env.UPLOAD_ROOT);
  if (uploadRoot !== path.join(serverRoot, 'uploads') || !fs.existsSync(uploadRoot) || !fs.statSync(uploadRoot).isDirectory()) invalid('UPLOAD_ROOT');
  return { port, publicBaseUrl: origin.origin, db: { host: env.DB_HOST, port: dbPort, database: env.DB_NAME, user: env.DB_USER, password: env.DB_PASSWORD }, uploadRoot };
}
export function safeError(error) { return { code: error.code ?? 'INTERNAL_ERROR', ...(error.field ? { field: error.field } : {}) }; }
