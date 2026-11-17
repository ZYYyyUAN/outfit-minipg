const session=require('../../../utils/session.js');
const {request}=require('../../../utils/request.js');
const media=require('../../../utils/media.js');
const wardrobe=require('../../../utils/wardrobe-state.js');
const outfits=require('../../../utils/outfit-state.js');
const state=require('../../../utils/diary-state.js');
Page({
 data:{diary:null,error:'',busy:false,photo:'',images:{}},
 onLoad(options){this._id=options.id;this._sequence=0;this._show=0;this._attempts=new Map();},
 async onShow(){
  this._visible=true;const show=++this._show,epoch=session.snapshot().epoch;
  if(this._epoch!==epoch){this._deleted=false;this._deleteError=null;this.setData({diary:null,photo:'',images:{},error:'',busy:false});}
  if(!await session.guard()||!this._visible||show!==this._show)return;
  this._epoch=epoch;
  if(this._deletePending&&this._deleteEpoch===epoch)await this._deletePending;
  if(!this._visible||show!==this._show||epoch!==session.snapshot().epoch)return;
  if(this._deleted){this.finishDelete();return;}
  if(this._deleteError){this.setData({busy:false,error:this._deleteError.message});this._deleteError=null;}
  if(!this.data.diary||this._revision!==state.current()||this._wardrobe!==wardrobe.current()||this._outfits!==outfits.current())this.load();else this.images();
 },
 onHide(){this._visible=false;this._show++;this._sequence++;this.setData({busy:Boolean(this._deletePending),photo:'',images:{}});},onUnload(){this.onHide();},
 current(n=this._sequence){return this._visible&&n===this._sequence&&this._epoch===session.snapshot().epoch;},
 async load(){const n=++this._sequence;this.setData({busy:true,error:'',diary:null,photo:'',images:{}});try{const diary=await request('/diaries/'+this._id);if(!this.current(n))return;this._revision=state.current();this._wardrobe=wardrobe.current();this._outfits=outfits.current();this.setData({diary,busy:false});this.images();}catch(e){if(this.current(n))this.setData({error:e.message,busy:false});}},
 images(){const d=this.data.diary;if(d.photoPath)this.image('photo',d.photoPath);for(const i of d.items)this.image(i.id,i.imagePath);},
 async image(id,path){const n=this._sequence,attempt={};this._attempts.set(id,attempt);try{const src=await media.download(path);if(this.current(n)&&this._attempts.get(id)===attempt)this.setData(id==='photo'?{photo:src}:{['images.i'+id]:src});}catch(e){if(this.current(n)&&this._attempts.get(id)===attempt)this.setData(id==='photo'?{photo:''}:{['images.i'+id]:''});}},
 retry(event){const id=event.currentTarget.dataset.id,d=this.data.diary;this.image(id,id==='photo'?d.photoPath:d.items.find(i=>i.id===Number(id)).imagePath);},
 failed(event){const {id,src}=event.currentTarget.dataset;if(this.current()&&src===(id==='photo'?this.data.photo:this.data.images['i'+id]))this.setData(id==='photo'?{photo:''}:{['images.i'+id]:''});},
 preview(){if(this.data.photo)wx.previewImage({current:this.data.photo,urls:[this.data.photo]});},
 clothing(event){wx.navigateTo({url:'/pages/clothes/detail/index?id='+event.currentTarget.dataset.id});},
 source(){wx.navigateTo({url:'/pages/outfits/detail/index?id='+this.data.diary.sourceOutfitId});},
 edit(){if(!this.data.busy)wx.navigateTo({url:'/pages/diary/edit/index?id='+this._id});},
 finishDelete(){this._deleted=false;this.setData({busy:false,diary:null});wx.switchTab({url:'/pages/diary/index'});},
 remove(){
  if(this.data.busy||!this.current())return;
  const n=this._sequence;this.setData({busy:true});
  wx.showModal({title:'删除这篇日记？',content:'该日记和实际穿着清单将删除，衣物、搭配和图片保留。',success:async r=>{
   if(!this.current(n))return;
   if(!r.confirm){this.setData({busy:false});return;}
   const epoch=this._epoch,date=this.data.diary.wearDate;this.setData({error:''});this._deleteEpoch=epoch;
   const pending=request('/diaries/'+this._id,{method:'DELETE'}).then(()=>{
    if(epoch!==session.snapshot().epoch)return;
    state.changed(date);this._deleted=true;if(this.current(n))this.finishDelete();
   },error=>{
    if(epoch!==session.snapshot().epoch)return;
    if(this.current(n))this.setData({busy:false,error:error.message});else this._deleteError=error;
   });
   this._deletePending=pending;await pending;if(this._deletePending===pending)this._deletePending=null;
  },fail:()=>{if(this.current(n))this.setData({busy:false});}});
 },
 back(){if(getCurrentPages().length>1)wx.navigateBack();else wx.switchTab({url:'/pages/diary/index'});}
});
