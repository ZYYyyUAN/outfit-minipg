const session = require('../../../utils/session.js');
const { request } = require('../../../utils/request.js');
const media = require('../../../utils/media.js');
const wardrobe = require('../../../utils/wardrobe-state.js');
const fields = ['name','categoryId','imagePath','color','season','note'];
const empty = () => ({name:'',categoryId:'',imagePath:'',color:'',season:'',note:''});
Page({
  data:{ready:false,editing:false,form:empty(),categories:[],categoryIndex:-1,categoryName:'请选择',seasons:['春','夏','秋','冬','春夏','春秋','秋冬','四季'],seasonIndex:-1,categoryError:'',src:'',imageError:'',candidate:'',uploadState:'idle',busy:false,dirty:false,error:'',errors:{},focusField:'',nameCount:0,colorCount:0,noteCount:0},
  async onLoad(options) {
    this._alive=true;this._visible=true;this._operation=0;this._imageOperation=0;this._id=options.id;
    if(!await session.guard() || !this._alive) return;
    this._epoch=session.snapshot().epoch;
    this._initial=empty(); this.setData({editing:Boolean(this._id)});
    this.loadCategories();this.load();
  },
  onShow() {
    this._visible=true;
    if(this.data.ready && this._epoch!==session.snapshot().epoch) { this.setData({ready:false,form:empty(),src:'',candidate:''});session.showLogin();return; }
    if(this.data.ready) this.readImage();
  },
  onHide() { this._visible=false;this._imageOperation++;this.setData({src:''}); },
  onUnload() { this._alive=false;this._operation++;this._imageOperation++;this.setData({src:'',candidate:''});wx.disableAlertBeforeUnload(); },
  current() { return this._alive && this._epoch===session.snapshot().epoch; },
  async load() {
    this.setData({error:''});
    try {
      const value=this._id?await request('/clothes/'+this._id):empty();
      if(!this.current()) return;
      const form=Object.fromEntries(fields.map(key=>[key,value[key]]));this._initial={...form};
      this.setData({form,ready:true});this.syncFields();this.readImage();
    } catch(error) { if(this.current()) this.setData({error:error.message}); }
  },
  async loadCategories() {
    this.setData({categoryError:''});
    try { const result=await request('/categories');if(this.current()) {this.setData({categories:result.items});this.syncFields();} }
    catch(error) { if(this.current()) this.setData({categoryError:error.message}); }
  },
  syncFields() {
    const form=this.data.form,index=this.data.categories.findIndex(item=>item.id===form.categoryId);
    this.setData({categoryIndex:index,categoryName:index<0?'请选择':this.data.categories[index].name,seasonIndex:this.data.seasons.indexOf(form.season),nameCount:Array.from(form.name.trim()).length,colorCount:Array.from(form.color.trim()).length,noteCount:Array.from(form.note).length});
    const dirty=fields.some(key=>form[key]!==this._initial[key]) || Boolean(this.data.candidate);
    this.setData({dirty});
    if(dirty) wx.enableAlertBeforeUnload({message:'衣物尚未保存，确定离开吗？'});else wx.disableAlertBeforeUnload();
  },
  input(event) { const form={...this.data.form,[event.currentTarget.dataset.field]:event.detail.value};this.setData({form,error:'',errors:{}});this.syncFields(); },
  category(event) { const item=this.data.categories[Number(event.detail.value)];this.setData({form:{...this.data.form,categoryId:item.id},errors:{}});this.syncFields(); },
  season(event) { this.setData({form:{...this.data.form,season:this.data.seasons[Number(event.detail.value)]},errors:{}});this.syncFields(); },
  async readImage() {
    const operation=++this._imageOperation;
    if(!this._visible || !this.data.ready) return;
    if(this.data.candidate) { this.setData({src:this.data.candidate});return; }
    if(!this.data.form.imagePath) {this.setData({src:'',imageError:''});return;}
    this.setData({imageError:''});
    try { const src=await media.download(this.data.form.imagePath);if(this.current() && this._visible && operation===this._imageOperation) this.setData({src}); }
    catch(error) { if(this.current() && this._visible && operation===this._imageOperation) this.setData({imageError:error.message}); }
  },
  imageFailed() { this.setData({src:'',imageError:'图片显示失败，请重新读取或选择图片'}); },
  preview() { if(this.data.src) wx.previewImage({current:this.data.src,urls:[this.data.src]}); },
  choose() {
    if(this.data.busy || this.data.uploadState==='uploading' || this._choosing) return;
    this._choosing=true;const epoch=this._epoch;
    wx.chooseMedia({count:1,mediaType:['image'],sizeType:['original'],sourceType:['album','camera'],success:result=> {
      this._choosing=false;if(!this.current() || epoch!==this._epoch) return;
      const file=result.tempFiles[0];
      if(file.size>5242880) {this.setData({error:'图片不能超过5MiB'});return;}
      this._imageOperation++;this._candidateBase=this.data.form.imagePath;
      this.setData({candidate:file.tempFilePath,src:this._visible?file.tempFilePath:'',imageError:'',error:''});this.syncFields();this.upload();
    },fail:error=> {this._choosing=false;if(this.current() && !error.errMsg.includes('cancel')) this.setData({error:'未能选择图片，请重试'});} });
  },
  async upload() {
    if(this.data.uploadState==='uploading' || !this.data.candidate) return;
    const operation=++this._operation,local=this.data.candidate;
    this.setData({uploadState:'uploading',error:''});
    try {
      const value=await media.upload(local);
      if(!this.current() || operation!==this._operation) return;
      this.setData({form:{...this.data.form,imagePath:value.imagePath},candidate:'',uploadState:'idle',src:this._visible?local:''});this.syncFields();
    } catch(error) { if(this.current() && operation===this._operation) this.setData({uploadState:'failed',error:error.message}); }
  },
  discardCandidate() {
    if(this.data.uploadState==='uploading') return;
    this._operation++;this.setData({candidate:'',form:{...this.data.form,imagePath:this._candidateBase},uploadState:'idle',error:''});this.syncFields();this.readImage();
  },
  cancel() {
    if(this.data.busy || this.data.uploadState==='uploading') return;
    const leave=()=>{wx.disableAlertBeforeUnload();wx.navigateBack();};
    if(!this.data.dirty) {leave();return;}
    wx.showModal({title:'放弃修改？',content:'尚未保存的衣物资料将丢失。',confirmText:'放弃修改',success:result=>{if(result.confirm && this.current()) leave();}});
  },
  async save() {
    if(this.data.busy || this.data.uploadState==='uploading' || this.data.candidate || !this.data.categories.length) return;
    const form={...this.data.form,name:this.data.form.name.trim(),color:this.data.form.color.trim()},errors={};
    for(const [key,max] of [['name',40],['color',20]]) if(!form[key] || Array.from(form[key]).length>max || /[\r\n\u2028\u2029]/.test(form[key])) errors[key]=`请填写1～${max}个字符，不能换行`;
    if(!form.categoryId) errors.categoryId='请选择分类';if(!form.season) errors.season='请选择适用季节';
    if(!form.imagePath) errors.imagePath='请先选择并上传单品图片';if(Array.from(form.note).length>500) errors.note='备注不能超过500个字符';
    if(Object.keys(errors).length) {this.setData({errors,error:'请检查标记的字段',focusField:Object.keys(errors)[0]});return;}
    const operation=++this._operation;this.setData({busy:true,error:'',errors:{}});
    try {
      const saved=await request('/clothes'+(this._id?'/'+this._id:''),{method:this._id?'PUT':'POST',data:form});
      wardrobe.changed();
      if(!this.current() || operation!==this._operation) return;
      this._initial={...form};this.setData({busy:false,dirty:false});wx.disableAlertBeforeUnload();
      if(!this._visible) return;
      const pages=getCurrentPages(),previous=pages[pages.length-2];
      if(this._id && previous && previous.route==='pages/clothes/detail/index' && String(previous.options.id)===String(this._id)) wx.navigateBack();
      else wx.redirectTo({url:'/pages/clothes/detail/index?id='+saved.id});
    } catch(error) {
      if(this.current() && operation===this._operation) this.setData({busy:false,error:['TIMEOUT','NETWORK_ERROR'].includes(error.code)?'保存结果未确认，请先查看衣橱':error.message,errors:error.fields || {},focusField:Object.keys(error.fields || {})[0] || ''});
    }
  },
});
