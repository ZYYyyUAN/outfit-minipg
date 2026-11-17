const { apiBaseUrl } = require('../config.js');
const session = require('./session.js');
class RequestError extends Error {
  constructor(code, message, httpStatus, fields) { super(message); this.code = code; this.httpStatus = httpStatus; this.fields = fields; }
}
function apiUrl(path) {
  if (typeof path !== 'string' || !/^\/(?!api(?:\/|$)|\/)[a-z]/.test(path)) throw new RequestError('INVALID_REQUEST', '接口地址无效');
  return apiBaseUrl + path;
}
function currentError(sent) { return session.isCurrent(sent) ? null : new RequestError('STALE_SESSION', '登录状态已改变'); }
function networkError(error, sent) {
  const stale = currentError(sent);
  if (stale) return stale;
  const timeout = error.errMsg.includes('timeout');
  return new RequestError(timeout ? 'TIMEOUT' : 'NETWORK_ERROR', timeout ? '连接超时，请重试' : '暂时无法连接，请检查本地服务');
}
function settleJson(res, { sent, auth, redirectOn401 = true }, resolve, reject) {
  if (auth) { const stale = currentError(sent); if (stale) return reject(stale); }
  const body = res.data;
  if (res.statusCode >= 200 && res.statusCode < 300) {
    if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'data') || Object.prototype.hasOwnProperty.call(body, 'error')) return reject(new RequestError('INVALID_RESPONSE', '服务响应异常', res.statusCode));
    return resolve(body.data);
  }
  if (!body || typeof body.error?.code !== 'string' || typeof body.error.message !== 'string') return reject(new RequestError('INVALID_RESPONSE', '服务响应异常', res.statusCode));
  if (auth && res.statusCode === 401 && body.error.code === 'UNAUTHENTICATED') session.expire(redirectOn401);
  const error = new RequestError(body.error.code, body.error.message, res.statusCode, body.error.details?.fields);
  error.details = body.error.details;
  reject(error);
}
function request(path, { method = 'GET', data, auth = true, redirectOn401 = true } = {}) {
  return new Promise((resolve, reject) => {
    const url = apiUrl(path), sent = session.snapshot();
    if (auth && !sent.token) { session.showLogin(); reject(new RequestError('UNAUTHENTICATED', '请先登录')); return; }
    wx.request({ url, method, data, timeout: 5000,
      header: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + sent.token } : {}) },
      success: res => settleJson(res, { sent, auth, redirectOn401 }, resolve, reject),
      fail: error => reject(auth ? networkError(error, sent) : new RequestError(error.errMsg.includes('timeout') ? 'TIMEOUT' : 'NETWORK_ERROR', '暂时无法连接，请重试')),
    });
  });
}
module.exports = { request, RequestError, apiUrl, currentError, networkError, settleJson };
