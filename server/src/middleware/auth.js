import { unauthenticated } from '../utils/business-error.js';

export function bearerToken(header) {
  if (typeof header !== 'string') throw unauthenticated();
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header);
  if (!match) throw unauthenticated();
  return match[1];
}
export const requireAuth = account => async (req, res, next) => {
  const headers = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'authorization');
  if (headers.length !== 1) throw unauthenticated();
  req.auth = await account.authenticate(bearerToken(req.headers.authorization));
  next();
};
