import { Router, json } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { invalid } from '../utils/business-error.js';
import { validateBody } from './account.js';

export const categories = ['tops','outerwear','dresses','bottoms','shoes','bags','accessories'];
export const seasons = ['春','夏','秋','冬','春夏','春秋','秋冬','四季'];
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
  if (Object.keys(query).some(k=>!fields.includes(k))) throw invalid('query', '包含不允许的查询参数');
  for (const key of Object.keys(query)) if (typeof query[key] !== 'string') throw invalid(key, '查询参数必须是单个字符串');
}
export function pagination(query) {
  const page = query.page === undefined ? 1 : positive(query.page, 'page');
  const pageSize = query.pageSize === undefined ? 12 : positive(query.pageSize, 'pageSize', 50);
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw invalid('page', '页码超出范围');
  return { page, pageSize, offset };
}
function enumeration(value, values, field) {
  if (!values.includes(value)) throw invalid(field, '请选择有效选项');
  return value;
}
export function filters(query) {
  queryInput(query, ['keyword','categoryId','color','season','archived','page','pageSize']);
  return { ...pagination(query), archived: enumeration(query.archived ?? 'active', ['active','archived','all'], 'archived'),
    keyword: query.keyword === undefined ? '' : text(query.keyword,'keyword',0,40),
    categoryId: query.categoryId === undefined ? undefined : enumeration(query.categoryId,categories,'categoryId'),
    color: query.color === undefined ? undefined : text(query.color,'color',1,20),
    season: query.season === undefined ? undefined : enumeration(query.season,seasons.slice(0,4),'season') };
}
export function clothingInput(body) {
  validateBody(body, ['name','categoryId','imagePath','color','season','note']);
  return { name: text(body.name,'name',1,40), categoryId: enumeration(body.categoryId,categories,'categoryId'),
    imagePath: text(body.imagePath,'imagePath',1,255), color: text(body.color,'color',1,20),
    season: enumeration(body.season,seasons,'season'), note: text(body.note,'note',0,500,true) };
}
export function clothesRoutes(account, clothes) {
  const router = Router();
  router.use('/clothes', requireAuth(account), json({limit:'8kb'}));
  router.get('/clothes', async (req,res)=>res.json({ data: await clothes.list(req.auth.userId,filters(req.query)) }));
  router.get('/clothes/facets', async (req,res)=> {
    queryInput(req.query,['archived']);
    const scope = enumeration(req.query.archived ?? 'active',['active','archived','all'],'archived');
    res.json({data:await clothes.facets(req.auth.userId,scope)});
  });
  router.post('/clothes', async (req,res)=> {
    queryInput(req.query,[]);
    res.status(201).json({data:await clothes.create(req.auth.userId,clothingInput(req.body))});
  });
  router.get('/clothes/:id', async (req,res)=> {
    queryInput(req.query,[]);
    res.json({data:await clothes.detail(req.auth.userId,positive(req.params.id,'id',4294967295))});
  });
  router.put('/clothes/:id', async (req,res)=> {
    queryInput(req.query,[]);
    res.json({data:await clothes.update(req.auth.userId,positive(req.params.id,'id',4294967295),clothingInput(req.body))});
  });
  router.patch('/clothes/:id/archive', async (req,res)=> {
    queryInput(req.query,[]); validateBody(req.body,['isArchived']);
    if (typeof req.body.isArchived !== 'boolean') throw invalid('isArchived','请提交布尔值');
    res.json({data:await clothes.archive(req.auth.userId,positive(req.params.id,'id',4294967295),req.body.isArchived)});
  });
  for (const kind of ['outfits','diaries']) router.get(`/clothes/:id/${kind}`, async (req,res)=> {
    queryInput(req.query,['page','pageSize']);
    res.json({data:await clothes.related(req.auth.userId,positive(req.params.id,'id',4294967295),kind,pagination(req.query))});
  });
  return router;
}
