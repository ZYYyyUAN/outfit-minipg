const session = require('../../../utils/session.js');
const { request } = require('../../../utils/request.js');
const media = require('../../../utils/media.js');
const wardrobe = require('../../../utils/wardrobe-state.js');
const outfits = require('../../../utils/diary-state.js');
const calendar=require('../../../utils/diary-calendar.js');
const empty=()=>({wearDate:calendar.today(),sourceOutfitId:null,occasion:'',mood:null,photoPath:null,note:''});
const normalized=(form,items)=>JSON.stringify({...form,occasion:form.occasion.trim(),clothingIds:items.map(item=>item.id)});
Page({
  data:{ready:false,editing:false,form:empty(),items:[],busy:false,error:'',errors:{},dirty:false,photo:'',photoError:'',conflict:null,occasionCount:0,noteCount:0,clothingRefreshFailed:false,epoch:-1},
  onLoad(options){this._id=options.id;this._date=options.date;this._source=options.sourceOutfitId;this._upload=0;this._alive=true;this._sequence=0;this._show=0;this._images=new Map();},
  async onShow(){
    this._visible=true;const show=++this._show;
    if(this._epoch!==session.snapshot().epoch){this._sequence++;this._images.clear();this.setData({ready:false,form:empty(),items:[],busy:false,dirty:false,error:'',errors:{},photo:'',photoError:'',conflict:null,clothingRefreshFailed:false});this._photoChoice=null;}
    if(!await session.guard()||!this._alive||!this._visible||show!==this._show)return;
    if(this._unwatch)this._unwatch();
    this._unwatch=wardrobe.watch(()=>{if(this.current()&&!this._savePending){this.selectComponent('#picker').closeState();if(this.data.ready)this.refreshClothes();else this.load();}});
    const epoch=session.snapshot().epoch;
    if(this._epoch!==epoch){this._epoch=epoch;this._saved=null;this._saveError=null;this.setData({epoch,editing:Boolean(this._id)});this.load();return;}
    if(this._savePending && this._saveEpoch===epoch) await this._savePending;
    if(!this.current()||show!==this._show)return;
    if(this._saved){this.finishSave(this._saved);return;}
    if(this._saveError){this.setData({busy:false,error:this._saveError.message,...(this._saveError.code==='DATE_OCCUPIED'?{conflict:this._saveError.details}:{})});if(this._saveError.fields)this.focusError(this._saveError.fields);this._saveError=null;}
    if(!this.data.ready)this.load();else if(this._wardrobeRevision!==wardrobe.current())this.refreshClothes();else {this.refreshImages();this.readPhoto();}if(this._photoChoice&&!this.data.busy)this.uploadPhoto();
  },
  onHide(){this._photoRead=null;this._upload++;if(this._unwatch){this._unwatch();this._unwatch=null;}this._visible=false;this._show++;this._sequence++;this._images.clear();this.selectComponent('#picker').closeState();this.setData({busy:Boolean(this._savePending),photo:'',items:this.data.items.map(item=>({...item,src:''}))});},
  onUnload(){this.onHide();this._alive=false;wx.disableAlertBeforeUnload();},
  current(sequence=this._sequence){return this._alive&&this._visible&&this._epoch===session.snapshot().epoch&&sequence===this._sequence;},
  async load(){
    const sequence=++this._sequence;this.setData({error:''});
    try{let value=this._id?await request('/diaries/'+this._id):this._source?await request('/outfits/'+this._source):{...empty(),items:[]};
      if(!this._id){const defaultDate=this._date||(await request('/statistics',{data:{month:calendar.today().slice(0,7)}})).asOf;value={...empty(),...value,wearDate:defaultDate,sourceOutfitId:this._source?Number(this._source):null,mood:null,note:'',photoPath:null};const existing=await request('/diaries/by-date',{data:{date:value.wearDate}});if(existing.diary&&this.current(sequence))this.setData({conflict:{wearDate:value.wearDate,existingDiaryId:existing.diary.id}});}if(!this.current(sequence))return;
      const form={wearDate:value.wearDate,sourceOutfitId:value.sourceOutfitId,occasion:value.occasion,mood:value.mood,photoPath:value.photoPath,note:value.note},items=value.items.map(item=>({...item,src:'',imageState:'loading'}));this._initial=normalized(form,items);
      this._wardrobeRevision=wardrobe.current();this.setData({form,items,ready:true});this.sync();this.refreshImages();this.readPhoto();
    }catch(error){if(this.current(sequence))this.setData({error:error.message});}
  },
  async refreshClothes(){
    const sequence=++this._sequence,revision=wardrobe.current();this._images.clear();this.setData({busy:true,error:'',clothingRefreshFailed:false});
    try{
      const items=await Promise.all(this.data.items.map(item=>request('/clothes/'+item.id)));
      if(!this.current(sequence))return;
      this._wardrobeRevision=revision;this.setData({items:items.map(item=>({...item,src:'',imageState:'loading'})),busy:false});this.refreshImages();
    }catch(error){if(this.current(sequence))this.setData({busy:false,error:error.message,clothingRefreshFailed:true});}
  },
  sync(){const {form,items}=this.data;this.setData({dirty:normalized(form,items)!==this._initial,occasionCount:Array.from(form.occasion.trim()).length,noteCount:Array.from(form.note).length});if(this.data.dirty)wx.enableAlertBeforeUnload({message:'日记尚未保存'});else wx.disableAlertBeforeUnload();},
  input(event){if(!this.current()||this.data.busy)return;this.setData({form:{...this.data.form,[event.currentTarget.dataset.field]:event.currentTarget.dataset.field==='mood'?(event.detail.value||null):event.detail.value},errors:{},error:''});this.sync();},
  choose(){if(this.current()&&this.data.ready&&!this.data.busy&&!this.data.clothingRefreshFailed)this.selectComponent('#picker').open();},
  picked(event){if(!this.current()||this.data.busy||event.detail.epoch!==this._epoch)return;this._images.clear();this.setData({items:event.detail.items.map(item=>({...item,src:'',imageState:'loading'})),errors:{},error:''});this.sync();this.refreshImages();},
  move(event){
    if(!this.current()||this.data.busy)return;const from=Number(event.currentTarget.dataset.index),to=from+Number(event.currentTarget.dataset.step),items=[...this.data.items];if(to<0||to>=items.length)return;
    [items[from],items[to]]=[items[to],items[from]];this.setData({items});this.sync();
  },
  remove(event){if(!this.current()||this.data.busy)return;this.setData({items:this.data.items.filter(item=>item.id!==Number(event.currentTarget.dataset.id))});this.sync();},
  date(event){if(this.current()&&!this.data.busy){this.setData({form:{...this.data.form,wearDate:event.detail.value},conflict:null});this.sync();}},
  async readPhoto(){
    const path=this.data.form.photoPath,n=this._sequence,attempt={};this._photoRead=attempt;
    if(!path){this.setData({photo:'',photoError:''});return;}
    try{const photo=await media.download(path);if(this.current(n)&&this._photoRead===attempt&&path===this.data.form.photoPath)this.setData({photo,photoError:''});}
    catch(e){if(this.current(n)&&this._photoRead===attempt&&path===this.data.form.photoPath)this.setData({photoError:e.message});}
  },
  photoFailed(event){if(this.current()&&event.currentTarget.dataset.src===this.data.photo)this.setData({photo:'',photoError:'图片显示失败，请重试'});},
  choosePhoto(){if(!this.current()||this.data.busy)return;const epoch=this._epoch;wx.chooseMedia({count:1,mediaType:['image'],success:result=>{if(epoch!==session.snapshot().epoch||!this._alive)return;this._photoChoice=result.tempFiles[0].tempFilePath;if(this.current())this.uploadPhoto();}});},
  async uploadPhoto(){const local=this._photoChoice;this._photoChoice=null;const candidate=++this._upload;this.setData({busy:true,photoError:''});try{const value=await media.upload(local);if(!this.current()||candidate!==this._upload)return;this._photoRead=null;this.setData({form:{...this.data.form,photoPath:value.imagePath},busy:false,photo:''});this.sync();this.readPhoto();}catch(e){if(this.current()&&candidate===this._upload)this.setData({busy:false,photoError:e.message});}},
  removePhoto(){if(this.current()&&!this.data.busy){this._photoRead=null;this._upload++;this.setData({form:{...this.data.form,photoPath:null},photo:'',photoError:''});this.sync();}},
  existing(){if(!this.current()||!this.data.conflict)return;const n=this._sequence,id=this.data.conflict.existingDiaryId;wx.showModal({title:'放弃当前草稿？',content:'前往已有日记，当前未保存内容将丢失。',success:r=>{if(r.confirm&&this.current(n)){wx.disableAlertBeforeUnload();wx.redirectTo({url:'/pages/diary/detail/index?id='+id});}}});},
  refreshImages(){for(const item of this.data.items)if(!item.src&&item.imageState!=='failed'&&!this._images.has(item.id))this.readImage(item);},
  async readImage(item){
    const sequence=this._sequence,attempt={};this._images.set(item.id,attempt);
    const update=patch=>{if(!this.current(sequence)||this._images.get(item.id)!==attempt)return;this.setData({items:this.data.items.map(row=>row.id===item.id&&row.imagePath===item.imagePath?{...row,...patch}:row)});};
    update({imageState:'loading'});try{update({src:await media.download(item.imagePath),imageState:'ready'});}catch(error){update({src:'',imageState:'failed'});}
  },
  retryImage(event){if(!this.current())return;this.readImage(this.data.items.find(item=>item.id===Number(event.currentTarget.dataset.id)));},
  imageFailed(event){if(!this.current())return;const {id,src}=event.currentTarget.dataset;this.setData({items:this.data.items.map(item=>item.id===Number(id)&&item.src===src?{...item,src:'',imageState:'failed'}:item)});},
  leave(){wx.disableAlertBeforeUnload();if(getCurrentPages().length>1)wx.navigateBack();else wx.switchTab({url:'/pages/diary/index'});},
  cancel(){if(!this.current()||this.data.busy)return;if(!this.data.dirty){this.leave();return;}const sequence=this._sequence;wx.showModal({title:'放弃修改？',content:'尚未保存的日记、照片和实际清单将丢失。',confirmText:'放弃修改',success:result=>{if(result.confirm&&this.current(sequence))this.leave();}});},
  focusError(errors){const field=Object.keys(errors)[0];this.setData({errors,error:'请检查标记的字段'});wx.pageScrollTo({selector:'#field-'+field,duration:0});},
  finishSave(saved){
    this._saved=null;this._initial=normalized(this.data.form,this.data.items);this.setData({busy:false,dirty:false});wx.disableAlertBeforeUnload();
    const pages=getCurrentPages(),previous=pages[pages.length-2];
    if(this._id&&previous&&previous.route==='pages/diary/detail/index'&&String(previous.options.id)===String(this._id))wx.navigateBack();
    else wx.redirectTo({url:'/pages/diary/detail/index?id='+saved.id});
  },
  async save(){
    if(!this.current()||!this.data.ready||this.data.busy||this.data.clothingRefreshFailed)return;
    const form={...this.data.form,occasion:this.data.form.occasion.trim(),mood:this.data.form.mood===null?null:this.data.form.mood.trim()},errors={};
    for(const [key,max]of [['occasion',20]])if(!form[key]||Array.from(form[key]).length>max||/[\r\n\u2028\u2029]/.test(form[key]))errors[key]=`请填写1～${max}个字符，不能换行`;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(form.wearDate))errors.wearDate='请选择有效日期';if(form.mood!==null&&(!form.mood||Array.from(form.mood).length>12||/[\r\n\u2028\u2029]/.test(form.mood)))errors.mood='心情为1～12个字符';if(Array.from(form.note).length>1000)errors.note='备注不能超过1000个字符';if(!this.data.items.length)errors.clothingIds='请至少选择1件衣物';
    if(Object.keys(errors).length){this.focusError(errors);return;}
    const epoch=this._epoch,sequence=this._sequence;this.setData({busy:true,error:'',errors:{}});
    const pending=request('/diaries'+(this._id?'/'+this._id:''),{method:this._id?'PUT':'POST',data:{...form,clothingIds:this.data.items.map(item=>item.id)}});
    this._saveEpoch=epoch;
    this._savePending=pending.then(saved=>{
      if(epoch!==session.snapshot().epoch)return;
      outfits.changed(saved.wearDate);this._saved=saved;
      if(this.current(sequence))this.finishSave(saved);
    },error=>{
      if(epoch!==session.snapshot().epoch)return;
      if(!this.current(sequence)){this._saveError=error;return;}
      this.setData({busy:false,error:error.message,...(error.code==='DATE_OCCUPIED'?{conflict:error.details}:{})});if(error.fields)this.focusError(error.fields);
    });
    await this._savePending;
    if(this._saveEpoch===epoch)this._savePending=null;
  },
});
