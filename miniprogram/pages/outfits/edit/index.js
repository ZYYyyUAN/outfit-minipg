const session = require('../../../utils/session.js');
const { request } = require('../../../utils/request.js');
const media = require('../../../utils/media.js');
const outfits = require('../../../utils/outfit-state.js');
const empty=()=>({name:'',occasion:'',note:''});
const normalized=(form,items)=>JSON.stringify({...form,name:form.name.trim(),occasion:form.occasion.trim(),clothingIds:items.map(item=>item.id)});
Page({
  data:{ready:false,editing:false,form:empty(),items:[],busy:false,error:'',errors:{},dirty:false,nameCount:0,occasionCount:0,noteCount:0,epoch:-1},
  onLoad(options){this._id=options.id;this._alive=true;this._sequence=0;this._show=0;this._images=new Map();},
  async onShow(){
    this._visible=true;const show=++this._show;
    if(this._epoch!==session.snapshot().epoch){this._sequence++;this._images.clear();this.setData({ready:false,form:empty(),items:[],busy:false,dirty:false,error:'',errors:{}});}
    if(!await session.guard()||!this._alive||!this._visible||show!==this._show)return;
    const epoch=session.snapshot().epoch;
    if(this._epoch!==epoch){this._epoch=epoch;this._saved=null;this._saveError=null;this.setData({epoch,editing:Boolean(this._id)});this.load();return;}
    if(this._savePending && this._saveEpoch===epoch) await this._savePending;
    if(!this.current()||show!==this._show)return;
    if(this._saved){this.finishSave(this._saved);return;}
    if(this._saveError){this.setData({busy:false,error:this._saveError.message});if(this._saveError.fields)this.focusError(this._saveError.fields);this._saveError=null;}
    if(!this.data.ready)this.load();else this.refreshImages();
  },
  onHide(){this._visible=false;this._show++;this._sequence++;this._images.clear();this.selectComponent('#picker').closeState();this.setData({items:this.data.items.map(item=>({...item,src:''}))});},
  onUnload(){this.onHide();this._alive=false;wx.disableAlertBeforeUnload();},
  current(sequence=this._sequence){return this._alive&&this._visible&&this._epoch===session.snapshot().epoch&&sequence===this._sequence;},
  async load(){
    const sequence=++this._sequence;this.setData({error:''});
    try{const value=this._id?await request('/outfits/'+this._id):{...empty(),items:[]};if(!this.current(sequence))return;
      const form={name:value.name,occasion:value.occasion,note:value.note},items=value.items.map(item=>({...item,src:'',imageState:'loading'}));this._initial=normalized(form,items);
      this.setData({form,items,ready:true});this.sync();this.refreshImages();
    }catch(error){if(this.current(sequence))this.setData({error:error.message});}
  },
  sync(){const {form,items}=this.data;this.setData({dirty:normalized(form,items)!==this._initial,nameCount:Array.from(form.name.trim()).length,occasionCount:Array.from(form.occasion.trim()).length,noteCount:Array.from(form.note).length});},
  input(event){if(!this.current()||this.data.busy)return;this.setData({form:{...this.data.form,[event.currentTarget.dataset.field]:event.detail.value},errors:{},error:''});this.sync();},
  choose(){if(this.current()&&this.data.ready&&!this.data.busy)this.selectComponent('#picker').open();},
  picked(event){if(!this.current()||this.data.busy||event.detail.epoch!==this._epoch)return;this._images.clear();this.setData({items:event.detail.items.map(item=>({...item,src:'',imageState:'loading'})),errors:{},error:''});this.sync();this.refreshImages();},
  move(event){
    if(!this.current()||this.data.busy)return;const from=Number(event.currentTarget.dataset.index),to=from+Number(event.currentTarget.dataset.step),items=[...this.data.items];if(to<0||to>=items.length)return;
    [items[from],items[to]]=[items[to],items[from]];this.setData({items});this.sync();
  },
  remove(event){if(!this.current()||this.data.busy)return;this.setData({items:this.data.items.filter(item=>item.id!==Number(event.currentTarget.dataset.id))});this.sync();},
  refreshImages(){for(const item of this.data.items)if(!item.src&&item.imageState!=='failed'&&!this._images.has(item.id))this.readImage(item);},
  async readImage(item){
    const sequence=this._sequence,attempt={};this._images.set(item.id,attempt);
    const update=patch=>{if(!this.current(sequence)||this._images.get(item.id)!==attempt)return;this.setData({items:this.data.items.map(row=>row.id===item.id&&row.imagePath===item.imagePath?{...row,...patch}:row)});};
    update({imageState:'loading'});try{update({src:await media.download(item.imagePath),imageState:'ready'});}catch(error){update({src:'',imageState:'failed'});}
  },
  retryImage(event){if(!this.current())return;this.readImage(this.data.items.find(item=>item.id===Number(event.currentTarget.dataset.id)));},
  imageFailed(event){if(!this.current())return;const {id,src}=event.currentTarget.dataset;this.setData({items:this.data.items.map(item=>item.id===Number(id)&&item.src===src?{...item,src:'',imageState:'failed'}:item)});},
  leave(){wx.disableAlertBeforeUnload();if(getCurrentPages().length>1)wx.navigateBack();else wx.switchTab({url:'/pages/outfits/index'});},
  cancel(){if(!this.current()||this.data.busy)return;if(!this.data.dirty){this.leave();return;}const sequence=this._sequence;wx.showModal({title:'放弃修改？',content:'尚未保存的搭配资料和组合顺序将丢失。',confirmText:'放弃修改',success:result=>{if(result.confirm&&this.current(sequence))this.leave();}});},
  focusError(errors){const field=Object.keys(errors)[0];this.setData({errors,error:'请检查标记的字段'});wx.pageScrollTo({selector:'#field-'+field,duration:0});},
  finishSave(saved){
    this._saved=null;this._initial=normalized(this.data.form,this.data.items);this.setData({busy:false,dirty:false});wx.disableAlertBeforeUnload();
    const pages=getCurrentPages(),previous=pages[pages.length-2];
    if(this._id&&previous&&previous.route==='pages/outfits/detail/index'&&String(previous.options.id)===String(this._id))wx.navigateBack();
    else wx.redirectTo({url:'/pages/outfits/detail/index?id='+saved.id});
  },
  async save(){
    if(!this.current()||!this.data.ready||this.data.busy)return;
    const form={...this.data.form,name:this.data.form.name.trim(),occasion:this.data.form.occasion.trim()},errors={};
    for(const [key,max]of [['name',40],['occasion',20]])if(!form[key]||Array.from(form[key]).length>max||/[\r\n\u2028\u2029]/.test(form[key]))errors[key]=`请填写1～${max}个字符，不能换行`;
    if(Array.from(form.note).length>500)errors.note='备注不能超过500个字符';if(!this.data.items.length)errors.clothingIds='请至少选择1件衣物';
    if(Object.keys(errors).length){this.focusError(errors);return;}
    const epoch=this._epoch,sequence=this._sequence;this.setData({busy:true,error:'',errors:{}});
    const pending=request('/outfits'+(this._id?'/'+this._id:''),{method:this._id?'PUT':'POST',data:{...form,clothingIds:this.data.items.map(item=>item.id)}});
    this._saveEpoch=epoch;
    this._savePending=pending.then(saved=>{
      if(epoch!==session.snapshot().epoch)return;
      outfits.changed();this._saved=saved;
      if(this.current(sequence))this.finishSave(saved);
    },error=>{
      if(epoch!==session.snapshot().epoch)return;
      if(!this.current(sequence)){this._saveError=error;return;}
      this.setData({busy:false,error:error.message});if(error.fields)this.focusError(error.fields);
    });
    await this._savePending;
    if(this._saveEpoch===epoch)this._savePending=null;
  },
});
