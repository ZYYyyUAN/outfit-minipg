const session = require('../../../utils/session.js');
const { request } = require('../../../utils/request.js');
const media = require('../../../utils/media.js');
const outfits = require('../../../utils/outfit-state.js');
const wardrobe = require('../../../utils/wardrobe-state.js');
const section = () => ({items:[],page:0,total:0,busy:false,error:''});
Page({
  data: {clothing:null,loading:true,error:'',notFound:false,src:'',imageError:'',acting:false,outfits:section(),diaries:section()},
  onLoad(options) { this._id=options.id; this._sequence=0; this._imageSequence=0; this._show=0; this._scroll=0; this._previews=new Map(); },
  async onShow() {
    this._visible=true;
    const show=++this._show;
    if(this._epoch!==session.snapshot().epoch) this.setData({clothing:null,src:'',outfits:section(),diaries:section()});
    if(!await session.guard() || !this._visible || show!==this._show) return;
    if(this._archivePending && this._archiveEpoch===session.snapshot().epoch) {
      this.setData({acting:true});
      try { await this._archivePending; } catch(error) { this._revision=-1; }
    }
    if(!this._visible || show!==this._show) return;
    this.setData({acting:false});
    if(this._unwatch) this._unwatch();
    this._unwatch=outfits.watch(()=> { if(!this.current(this._sequence)) return; this._outfitRevision=outfits.current();this._revision=wardrobe.current();this._scroll=0;this.load();wx.pageScrollTo({scrollTop:0,duration:0}); });
    const epoch=session.snapshot().epoch,revision=wardrobe.current(),outfitRevision=outfits.current();
    if(this._epoch!==epoch || this._revision!==revision || this._outfitRevision!==outfitRevision || !this.data.clothing) {
      this._epoch=epoch;this._revision=revision;this._outfitRevision=outfitRevision;this._scroll=0;this.load();wx.pageScrollTo({scrollTop:0,duration:0});return;
    }
    this.readImage();
    for(const kind of ['outfits','diaries']) {
      if(!this.data[kind].page) this.loadSection(kind);
      for(const item of this.data[kind].items) for(const child of item.previewItems) this.readPreview(kind,item.id,child.id,child.imagePath);
    }
    wx.pageScrollTo({scrollTop:this._scroll,duration:0});
  },
  onHide() {
    if(this._unwatch) { this._unwatch();this._unwatch=null; }
    this._visible=false;this._show++;this._sequence++;this._imageSequence++;this._previews.clear();
    const patch={src:'',acting:false};
    for(const kind of ['outfits','diaries']) patch[kind]={...this.data[kind],busy:false,items:this.data[kind].items.map(item=>({...item,previewItems:item.previewItems.map(child=>({...child,src:''}))}))};
    this.setData(patch);
  },
  onUnload() { this.onHide(); },
  onPageScroll(event) { this._scroll=event.scrollTop; },
  current(sequence) { return this._visible && this._epoch===session.snapshot().epoch && sequence===this._sequence; },
  async load() {
    const sequence=++this._sequence;this._previews.clear();
    this.setData({loading:true,error:'',notFound:false,clothing:null,src:'',outfits:section(),diaries:section()});
    try {
      const clothing=await request('/clothes/'+this._id);
      if(!this.current(sequence)) return;
      this.setData({clothing,loading:false});this.readImage();this.loadSection('outfits');this.loadSection('diaries');
    } catch(error) { if(this.current(sequence)) this.setData({loading:false,error:error.message,notFound:error.httpStatus===404}); }
  },
  async readImage() {
    const sequence=this._sequence,imageSequence=++this._imageSequence;
    this.setData({src:'',imageError:''});
    try {
      const src=await media.download(this.data.clothing.imagePath);
      if(this.current(sequence) && imageSequence===this._imageSequence) this.setData({src});
    } catch(error) { if(this.current(sequence) && imageSequence===this._imageSequence) this.setData({imageError:error.message}); }
  },
  imageFailed(event) { if(this.current(this._sequence) && event.currentTarget.dataset.src===this.data.src) this.setData({src:'',imageError:'图片显示失败，请重新读取'}); },
  preview() { if(this.data.src) wx.previewImage({current:this.data.src,urls:[this.data.src]}); },
  async loadSection(kind) {
    const old=this.data[kind];
    if(old.busy || (old.page && old.items.length>=old.total)) return;
    const sequence=this._sequence;
    this.setData({[kind]:{...old,busy:true,error:''}});
    try {
      const value=await request('/clothes/'+this._id+'/'+kind,{data:{page:old.page+1,pageSize:2}});
      if(!this.current(sequence)) return;
      const items=value.items.map(item=>({...item,previewItems:item.previewItems.map(child=>({...child,src:'',imageError:false}))}));
      this.setData({[kind]:{...value,items:[...old.items,...items],busy:false,error:''}});
      for(const item of items) for(const child of item.previewItems) this.readPreview(kind,item.id,child.id,child.imagePath);
    } catch(error) { if(this.current(sequence)) this.setData({[kind]:{...old,busy:false,error:error.message}}); }
  },
  async readPreview(kind,parentId,id,imagePath) {
    const sequence=this._sequence,key=kind+':'+parentId+':'+id,attempt={};this._previews.set(key,attempt);
    const update=patch=> {
      if(!this.current(sequence) || this._previews.get(key)!==attempt) return;
      const parent=this.data[kind].items.findIndex(item=>item.id===parentId);
      if(parent<0) return;
      const index=this.data[kind].items[parent].previewItems.findIndex(item=>item.id===id && item.imagePath===imagePath);
      if(index>=0) this.setData({[`${kind}.items[${parent}].previewItems[${index}]`]:{...this.data[kind].items[parent].previewItems[index],...patch}});
    };
    try { update({src:await media.download(imagePath),imageError:false}); }
    catch(error) { update({src:'',imageError:true}); }
  },
  moreOutfits() { this.loadSection('outfits'); },
  moreDiaries() { this.loadSection('diaries'); },
  retryPreview(event) {
    const {kind,parent,id}=event.currentTarget.dataset;
    const item=this.data[kind].items.find(item=>item.id===Number(parent)).previewItems.find(item=>item.id===Number(id));
    this.readPreview(kind,Number(parent),item.id,item.imagePath);
  },
  previewFailed(event) {
    if(!this.current(this._sequence)) return;
    const {kind,parent,id,src}=event.currentTarget.dataset;
    const p=this.data[kind].items.findIndex(item=>item.id===Number(parent));
    if(p<0) return;
    const i=this.data[kind].items[p].previewItems.findIndex(item=>item.id===Number(id));
    if(i<0 || this.data[kind].items[p].previewItems[i].src!==src) return;
    this.setData({[`${kind}.items[${p}].previewItems[${i}].src`]:'',[`${kind}.items[${p}].previewItems[${i}].imageError`]:true});
  },
  edit() { wx.navigateTo({url:'/pages/clothes/edit/index?id='+this._id}); },
  archive() {
    if(this.data.acting) return;
    const target=!this.data.clothing.isArchived, sequence=this._sequence,epoch=this._epoch;
    wx.showModal({title:target?'归档这件衣物？':'恢复这件衣物？',content:target?'归档后不在默认衣橱显示，已有搭配和穿着记录会保留。':'恢复后会重新显示在在用衣橱中。',confirmText:target?'归档':'恢复',success:async result=> {
      if(!result.confirm || !this.current(sequence)) return;
      this.setData({acting:true,error:''});
      let pending;
      try {
        pending=request('/clothes/'+this._id+'/archive',{method:'PATCH',data:{isArchived:target}});
        this._archiveEpoch=epoch;this._archivePending=pending;
        const clothing=await pending;
        if(epoch!==session.snapshot().epoch) return;
        if(this.current(sequence)) this.setData({acting:false});
        wardrobe.changed();
        if(!this.current(sequence)) return;
        this._revision=wardrobe.current();this.setData({clothing,acting:false});
      } catch(error) { if(this.current(sequence)) this.setData({acting:false,error:error.message}); }
      finally { if(this._archivePending===pending) this._archivePending=null; }
    }});
  },
  diary(event){if(this.current(this._sequence))wx.navigateTo({url:'/pages/diary/detail/index?id='+event.currentTarget.dataset.id});},
  outfit(event) { if(this.current(this._sequence)) wx.navigateTo({url:'/pages/outfits/detail/index?id='+event.currentTarget.dataset.id}); },
  back() { if(getCurrentPages().length>1) wx.navigateBack({delta:1});else wx.switchTab({url:'/pages/wardrobe/index'}); },
});
