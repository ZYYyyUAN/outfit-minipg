const { apiBaseUrl } = require('../config.js');
const session = require('./session.js');
class RequestError extends Error {
  constructor(code, message, httpStatus, fields) { super(message); this.code = code; this.httpStatus = httpStatus; this.fields = fields; }
}
function request(path, { method = 'GET', data, auth = true, redirectOn401 = true } = {}) {
  if (typeof path !== 'string' || !/^\/(?!api(?:\/|$)|\/)[a-z]/.test(path)) return Promise.reject(new RequestError('INVALID_REQUEST', '接口地址无效'));
  const sent = session.snapshot();
  if (auth && !sent.token) { session.showLogin(); return Promise.reject(new RequestError('UNAUTHENTICATED', '请先登录')); }
  return new Promise((resolve, reject) => {
    wx.request({ url: apiBaseUrl + path, method, data, timeout: 5000,
      header: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + sent.token } : {}) },
      success: res => {
        if (auth && sent.epoch !== session.snapshot().epoch) return reject(new RequestError('STALE_SESSION', '登录状态已改变'));
        const body = res.data;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'data') || Object.prototype.hasOwnProperty.call(body, 'error')) return reject(new RequestError('INVALID_RESPONSE', '服务响应异常', res.statusCode));
          return resolve(body.data);
        }
        if (!body || typeof body.error?.code !== 'string' || typeof body.error.message !== 'string') return reject(new RequestError('INVALID_RESPONSE', '服务响应异常', res.statusCode));
        if (auth && res.statusCode === 401 && body.error.code === 'UNAUTHENTICATED') { session.clear(); if (redirectOn401) session.showLogin(); }
        reject(new RequestError(body.error.code, body.error.message, res.statusCode, body.error.details?.fields));
      },
      fail: error => {
        if (auth && sent.epoch !== session.snapshot().epoch) return reject(new RequestError('STALE_SESSION', '登录状态已改变'));
        const timeout = error.errMsg.includes('timeout');
        reject(new RequestError(timeout ? 'TIMEOUT' : 'NETWORK_ERROR', timeout ? '连接超时，请重试' : '暂时无法连接，请检查本地服务'));
      },
    });
  });
}
module.exports = { request, RequestError };
