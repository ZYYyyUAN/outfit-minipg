const session = require('../../../utils/session.js');
const { request } = require('../../../utils/request.js');
const media = require('../../../utils/media.js');
const wardrobe = require('../../../utils/wardrobe-state.js');
const section = () => ({items:[],page:0,total:0,busy:false,error:''});
Page({
  data: {clothing:null,loading:true,error:'',notFound:false,src:'',imageError:'',acting:false,outfits:section(),diaries:section()},
  onLoad(options) { this._id=options.id; this._sequence=0; this._imageSequence=0; },
  async onShow() {
    this._visible=true;
    if(!await session.guard() || !this._visible) return;
    this._epoch=session.snapshot().epoch; this.load();
  },
  onHide() { this._visible=false;this._sequence++;this._imageSequence++;this.setData({clothing:null,src:'',outfits:section(),diaries:section(),acting:false}); },
  onUnload() { this._visible=false;this._sequence++;this._imageSequence++; },
  current(sequence) { return this._visible && this._epoch===session.snapshot().epoch && sequence===this._sequence; },
  async load() {
    const sequence=++this._sequence;
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
  imageFailed() { this.setData({src:'',imageError:'图片显示失败，请重新读取'}); },
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
    const sequence=this._sequence;
    const update=patch=> {
      if(!this.current(sequence)) return;
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
    const {kind,parent,id}=event.currentTarget.dataset;
    const p=this.data[kind].items.findIndex(item=>item.id===Number(parent));
    const i=this.data[kind].items[p].previewItems.findIndex(item=>item.id===Number(id));
    this.setData({[`${kind}.items[${p}].previewItems[${i}].src`]:'',[`${kind}.items[${p}].previewItems[${i}].imageError`]:true});
  },
  edit() { wx.navigateTo({url:'/pages/clothes/edit/index?id='+this._id}); },
  archive() {
    if(this.data.acting) return;
    const target=!this.data.clothing.isArchived, sequence=this._sequence;
    wx.showModal({title:target?'归档这件衣物？':'恢复这件衣物？',content:target?'归档后不在默认衣橱显示，已有搭配和穿着记录会保留。':'恢复后会重新显示在在用衣橱中。',confirmText:target?'归档':'恢复',success:async result=> {
      if(!result.confirm || !this.current(sequence)) return;
      this.setData({acting:true,error:''});
      try {
        const clothing=await request('/clothes/'+this._id+'/archive',{method:'PATCH',data:{isArchived:target}});
        wardrobe.changed();
        if(this.current(sequence)) this.setData({clothing,acting:false});
      } catch(error) { if(this.current(sequence)) this.setData({acting:false,error:error.message}); }
    }});
  },
  back() { wx.switchTab({url:'/pages/wardrobe/index'}); },
});
