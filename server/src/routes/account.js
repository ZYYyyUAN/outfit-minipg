import { Router } from 'express';
import { invalid } from '../utils/business-error.js';
import { requireAuth } from '../middleware/auth.js';

export function validateBody(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('body', '请提交JSON对象');
  if (Object.keys(body).some(k => !fields.includes(k))) throw invalid('body', '包含不允许的字段');
  if (fields.some(k => !Object.hasOwn(body, k))) throw invalid('body', '请填写所有必填项');
}
export function username(value) {
  if (typeof value !== 'string' || !/^[a-z0-9_]{4,20}$/.test(value.trim().toLowerCase())) throw invalid('username', '用户名为4～20位字母、数字或下划线');
  return value.trim().toLowerCase();
}
export function password(value) {
  if (typeof value !== 'string' || Array.from(value).length < 8 || Array.from(value).length > 64) throw invalid('password', '密码为8～64个字符，空格会原样保留');
  return value;
}
export function nickname(value) {
  if (typeof value !== 'string' || Array.from(value.trim()).length < 1 || Array.from(value.trim()).length > 20 || /[\r\n\u2028\u2029]/.test(value)) throw invalid('nickname', '昵称为1～20个字符，不能换行');
  return value.trim();
}
export function accountRoutes(account) {
  const router = Router(), auth = requireAuth(account);
  router.post('/auth/register', async (req, res) => {
    validateBody(req.body, ['username','password','nickname']);
    const input = { username: username(req.body.username), password: password(req.body.password), nickname: nickname(req.body.nickname) };
    res.status(201).json({ data: await account.register(input) });
  });
  router.post('/auth/login', async (req, res) => {
    validateBody(req.body, ['username','password']);
    res.json({ data: await account.login({ username: username(req.body.username), password: password(req.body.password) }) });
  });
  router.post('/auth/logout', auth, async (req, res) => {
    if (req.body !== undefined) validateBody(req.body, []);
    res.json({ data: await account.logout(req.auth) });
  });
  router.get('/me', auth, (req, res) => {
    if (Object.keys(req.query).length) throw invalid('query', '此接口不接受查询参数');
    res.json({ data: req.auth.user });
  });
  router.put('/me', auth, async (req, res) => {
    validateBody(req.body, ['nickname','avatarPath']);
    const name = nickname(req.body.nickname), image = req.body.avatarPath;
    if (image !== null && (typeof image !== 'string' || image.length < 1 || image.length > 255)) throw invalid('avatarPath', '头像引用应为null或1～255字符的路径');
    res.json({ data: await account.updateProfile(req.auth, { nickname: name, avatarPath: image }) });
  });
  return router;
}
