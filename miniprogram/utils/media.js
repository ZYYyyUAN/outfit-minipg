const session = require('./session.js');
const { RequestError, apiUrl, currentError, networkError, settleJson } = require('./request.js');
function identity() {
  const sent = session.snapshot();
  if (!sent.token) { session.showLogin(); throw new RequestError('UNAUTHENTICATED', '请先登录'); }
  return sent;
}
function upload(localPath) {
  return new Promise((resolve, reject) => {
    const sent = identity();
    wx.uploadFile({ url: apiUrl('/uploads'), filePath: localPath, name: 'file', timeout: 15000,
      header: { Authorization: 'Bearer ' + sent.token },
      success: res => {
        const stale = currentError(sent); if (stale) return reject(stale);
        let body;
        try { body = JSON.parse(res.data); }
        catch (error) { if (error instanceof SyntaxError) { reject(new RequestError('INVALID_RESPONSE', '上传响应异常', res.statusCode)); return; } throw error; }
        settleJson({ statusCode: res.statusCode, data: body }, { sent, auth: false }, value => {
          if (res.statusCode !== 201 || !value || typeof value.imagePath !== 'string' || !/^users\/[1-9]\d*\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/.test(value.imagePath) || value.imagePath.split('/')[1] !== String(sent.user.id) || value.imageUrl !== apiUrl('/media/' + value.imagePath.split('/').pop()) || !['image/jpeg','image/png'].includes(value.mimeType) || !Number.isInteger(value.size) || value.size < 1 || value.size > 5242880) return reject(new RequestError('INVALID_RESPONSE', '上传响应异常', res.statusCode));
          resolve(value);
        }, error => {
          if (error.httpStatus === 401 && error.code === 'UNAUTHENTICATED') session.expire();
          reject(error);
        });
      },
      fail: error => reject(networkError(error, sent)),
    });
  });
}
function download(imagePath) {
  return new Promise((resolve, reject) => {
    const sent = identity();
    if (typeof imagePath !== 'string' || !/^users\/[1-9]\d*\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/.test(imagePath)) return reject(new RequestError('INVALID_REQUEST', '图片路径无效'));
    wx.downloadFile({ url: apiUrl('/media/' + imagePath.split('/').pop()), timeout: 15000,
      header: { Authorization: 'Bearer ' + sent.token },
      success: res => {
        const stale = currentError(sent); if (stale) return reject(stale);
        if (res.statusCode === 200 && typeof res.tempFilePath === 'string' && res.tempFilePath) return resolve(res.tempFilePath);
        if (res.statusCode === 401) { session.expire(); return reject(new RequestError('UNAUTHENTICATED', '登录状态已失效，请重新登录', 401)); }
        if (res.statusCode === 404) return reject(new RequestError('NOT_FOUND', '图片不存在', 404));
        reject(new RequestError(res.statusCode >= 500 ? 'INTERNAL_ERROR' : 'INVALID_RESPONSE', '图片读取失败，请重试', res.statusCode));
      },
      fail: error => reject(networkError(error, sent)),
    });
  });
}
module.exports = { upload, download };
