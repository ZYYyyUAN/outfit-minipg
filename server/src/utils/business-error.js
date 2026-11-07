export class BusinessError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status; this.code = code; this.fields = fields;
  }
}
export const invalid = (field, message) => new BusinessError(400, 'INVALID_INPUT', '请检查填写内容', { [field]: message });
export const unauthenticated = () => new BusinessError(401, 'UNAUTHENTICATED', '登录状态已失效，请重新登录');
