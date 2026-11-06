import express from 'express';

export function internalError(error, req, res, next) {
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时无法完成请求' } });
}
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.get('/api/health', (req, res) => res.json({ data: { status: 'ok' } }));
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: '请求的资源不存在' } }));
  app.use(internalError);
  return app;
}
