import {Router,json} from 'express';
import {requireAuth} from '../middleware/auth.js';
import {queryInput,positive,validateBody} from '../utils/input-validation.js';
import {monthInput,dateInput,diaryInput} from '../utils/diary-input.js';

export function diariesRoutes(account,diaries){
  const r=Router();r.use('/diaries',requireAuth(account),json({limit:'8kb'}),(req,res,next)=>{
    if(['GET','DELETE'].includes(req.method)&&req.body!==undefined)validateBody(req.body,[]);
    next();
  });
  r.get('/diaries',async(req,res)=>{queryInput(req.query,['month']);res.json({data:await diaries.list(req.auth.userId,monthInput(req.query.month))});});
  r.get('/diaries/by-date',async(req,res)=>{queryInput(req.query,['date']);res.json({data:{diary:await diaries.byDate(req.auth.userId,dateInput(req.query.date))}});});
  r.get('/diaries/:id',async(req,res)=>{queryInput(req.query,[]);res.json({data:await diaries.detail(req.auth.userId,positive(req.params.id,'id',4294967295))});});
  r.post('/diaries',async(req,res)=>{queryInput(req.query,[]);res.status(201).json({data:await diaries.create(req.auth.userId,diaryInput(req.body))});});
  r.put('/diaries/:id',async(req,res)=>{queryInput(req.query,[]);res.json({data:await diaries.update(req.auth.userId,positive(req.params.id,'id',4294967295),diaryInput(req.body))});});
  r.delete('/diaries/:id',async(req,res)=>{queryInput(req.query,[]);res.json({data:await diaries.remove(req.auth.userId,positive(req.params.id,'id',4294967295))});});
  return r;
}
