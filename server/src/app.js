import express from 'express';
import { accountRoutes } from './routes/account.js';
import { BusinessError } from './utils/business-error.js';

export function internalError(error, req, res, next) {
  if (error instanceof BusinessError) return res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.fields ? { details: { fields: error.fields } } : {}) } });
  if (['entity.parse.failed', 'entity.too.large'].includes(error.type)) return res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: { code: 'INVALID_INPUT', message: '请求内容无效', details: { fields: { body: error.type === 'entity.too.large' ? '请求不能超过8KiB' : '请提交有效JSON' } } } });
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时无法完成请求' } });
}
export function createApp(account) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/api/health', (req, res) => res.json({ data: { status: 'ok' } }));
  app.use(express.json({ limit: '8kb' }));
  if (account) app.use('/api', accountRoutes(account));
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: '请求的资源不存在' } }));
  app.use(internalError);
  return app;
}
