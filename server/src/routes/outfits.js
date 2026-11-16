import { Router, json } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { BusinessError, invalid } from '../utils/business-error.js';
import { validateBody, text, positive, queryInput, pagination } from '../utils/input-validation.js';

function archivedScope(value = 'active') {
  if (!['active', 'archived', 'all'].includes(value)) throw invalid('archived', '请选择有效归档范围');
  return value;
}
export function outfitFilters(query) {
  queryInput(query, ['keyword', 'occasion', 'archived', 'page', 'pageSize']);
  return { ...pagination(query), archived: archivedScope(query.archived),
    keyword: query.keyword === undefined ? '' : text(query.keyword, 'keyword', 0, 40),
    occasion: query.occasion === undefined ? undefined : text(query.occasion, 'occasion', 1, 20) };
}
export function outfitInput(body) {
  validateBody(body, ['name', 'occasion', 'note', 'clothingIds']);
  const name = text(body.name, 'name', 1, 40), occasion = text(body.occasion, 'occasion', 1, 20), note = text(body.note, 'note', 0, 500, true);
  const ids = body.clothingIds;
  if (!Array.isArray(ids) || ids.some(id => !Number.isInteger(id) || id < 1 || id > 4294967295)) throw invalid('clothingIds', '请提交有效整数ID数组');
  if (ids.length < 1 || ids.length > 20 || new Set(ids).size !== ids.length) throw new BusinessError(400, 'INVALID_SELECTION', '请检查所选衣物', { clothingIds: '请选择1～20件不重复衣物' });
  return { name, occasion, note, clothingIds: [...ids] };
}

// Batch 1仅在隔离桩服务测试中挂载；生产装配及真实服务留Batch 2。
export function outfitsRoutes(account, outfits) {
  const router = Router();
  router.use('/outfits', requireAuth(account), json({ limit: '8kb' }));
  router.get('/outfits', async (req, res) => res.json({ data: await outfits.list(req.auth.userId, outfitFilters(req.query)) }));
  router.get('/outfits/facets', async (req, res) => {
    queryInput(req.query, ['archived']);
    res.json({ data: await outfits.facets(req.auth.userId, archivedScope(req.query.archived)) });
  });
  router.get('/outfits/:id', async (req, res) => {
    queryInput(req.query, []);
    res.json({ data: await outfits.detail(req.auth.userId, positive(req.params.id, 'id', 4294967295)) });
  });
  router.post('/outfits', async (req, res) => {
    queryInput(req.query, []);
    res.status(201).json({ data: await outfits.create(req.auth.userId, outfitInput(req.body)) });
  });
  router.put('/outfits/:id', async (req, res) => {
    queryInput(req.query, []);
    res.json({ data: await outfits.update(req.auth.userId, positive(req.params.id, 'id', 4294967295), outfitInput(req.body)) });
  });
  router.patch('/outfits/:id/archive', async (req, res) => {
    queryInput(req.query, []);
    const id = positive(req.params.id, 'id', 4294967295);
    validateBody(req.body, ['isArchived']);
    if (typeof req.body.isArchived !== 'boolean') throw invalid('isArchived', '请提交布尔值');
    res.json({ data: await outfits.archive(req.auth.userId, id, req.body.isArchived) });
  });
  return router;
}
