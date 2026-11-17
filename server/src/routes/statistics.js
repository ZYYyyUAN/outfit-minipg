import {Router,json} from 'express';
import {requireAuth} from '../middleware/auth.js';
import {queryInput,positive,validateBody} from '../utils/input-validation.js';
import {monthInput} from '../utils/diary-input.js';
import {invalid} from '../utils/business-error.js';
export function statisticsRoutes(account,statistics){
  const r=Router();r.use('/statistics',requireAuth(account),json({limit:'8kb'}),(req,res,next)=>{
    if(req.method==='GET'&&req.body!==undefined)validateBody(req.body,[]);
    next();
  });
  r.get('/statistics',async(req,res)=>{
    queryInput(req.query,['month','notWornPage','notWornPageSize']);
    const month=monthInput(req.query.month),page=req.query.notWornPage===undefined?1:positive(req.query.notWornPage,'notWornPage'),pageSize=req.query.notWornPageSize===undefined?12:positive(req.query.notWornPageSize,'notWornPageSize',50);
    if(!Number.isSafeInteger((page-1)*pageSize))throw invalid('notWornPage','页码超出范围');
    res.json({data:await statistics.get(req.auth.userId,{month,page,pageSize})});
  });return r;
}
