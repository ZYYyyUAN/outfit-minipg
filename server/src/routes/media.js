import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { BusinessError, invalid } from '../utils/business-error.js';

const parseFile = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5242880, files: 1, fields: 0, parts: 1 } }).single('file');
function uploadParser(req, res, next) {
  if (!req.is('multipart/form-data')) return next(new BusinessError(400, 'IMAGE_REQUIRED', '请选择一张图片'));
  parseFile(req, res, error => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') return next(new BusinessError(413, 'FILE_TOO_LARGE', '图片不能超过5MiB'));
      if (['LIMIT_FILE_COUNT','LIMIT_UNEXPECTED_FILE','LIMIT_FIELD_COUNT','LIMIT_PART_COUNT','LIMIT_FIELD_KEY','LIMIT_FIELD_VALUE','INVALID_FIELD_NAME','STREAM_DESTROYED'].includes(error.code)) return next(invalid('file', '请只提交一个名为file的图片字段'));
    }
    if (['Multipart: Boundary not found','Unexpected end of form','Unexpected end of multipart data','Malformed part header'].includes(error.message)) return next(invalid('file', '图片上传请求不完整'));
    next(error);
  });
}
function noQuery(req, res, next) {
  if (Object.keys(req.query).length) throw invalid('query', '此接口不接受查询参数');
  next();
}
export function mediaRoutes(account, media) {
  const router = Router(), auth = requireAuth(account);
  router.get('/categories', auth, noQuery, async (req, res) => res.json({ data: await media.categories() }));
  router.post('/uploads', auth, noQuery, uploadParser, async (req, res) => {
    if (!req.file) throw new BusinessError(400, 'IMAGE_REQUIRED', '请选择一张图片');
    res.status(201).json({ data: await media.upload(req.auth.userId, req.file.buffer) });
  });
  router.get('/media/:filename', auth, noQuery, async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/.test(req.params.filename)) throw new BusinessError(404, 'NOT_FOUND', '图片不存在');
    const image = await media.read(req.auth.userId, req.params.filename);
    res.status(200).set({ 'Content-Type': image.mimeType, 'Content-Length': String(image.bytes.length), 'Cache-Control': 'private, no-store' }).end(image.bytes);
  });
  return router;
}
