import { invalid } from './business-error.js';

export function validateBody(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('body', '请提交JSON对象');
  if (Object.keys(body).some(k => !fields.includes(k))) throw invalid('body', '包含不允许的字段');
  if (fields.some(k => !Object.hasOwn(body, k))) throw invalid('body', '请填写所有必填项');
}
export function text(value, field, min, max, multiline = false) {
  if (typeof value !== 'string') throw invalid(field, '请填写文字');
  const result = multiline ? value : value.trim();
  if (Array.from(result).length < min || Array.from(result).length > max || (!multiline && /[\r\n\u2028\u2029]/.test(result))) throw invalid(field, `长度应为${min}～${max}个字符${multiline ? '' : '，不能换行'}`);
  return result;
}
export function positive(value, field, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) throw invalid(field, '请填写有效正整数');
  return Number(value);
}
export function queryInput(query, fields) {
  if (Object.keys(query).some(k => !fields.includes(k))) throw invalid('query', '包含不允许的查询参数');
  for (const key of Object.keys(query)) if (typeof query[key] !== 'string') throw invalid(key, '查询参数必须是单个字符串');
}
export function pagination(query) {
  const page = query.page === undefined ? 1 : positive(query.page, 'page');
  const pageSize = query.pageSize === undefined ? 12 : positive(query.pageSize, 'pageSize', 50);
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw invalid('page', '页码超出范围');
  return { page, pageSize, offset };
}
