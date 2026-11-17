const session = require('../../utils/session.js');
const { request } = require('../../utils/request.js');
const media = require('../../utils/media.js');
const outfits = require('../../utils/outfit-state.js');
const initial = () => ({items:[],total:0,page:0,busy:false,error:'',keywordDraft:'',keyword:'',occasion:'',archived:'active',occasions:[],facetError:'',panel:false,draftOccasion:'',draftArchived:'active',scopes:[{id:'active',name:'在用'},{id:'archived',name:'已归档'},{id:'all',name:'全部'}]});
Page({
  data: initial(),
  create() { if(this._visible && this._epoch===session.snapshot().epoch) wx.navigateTo({url:'/pages/outfits/edit/index'}); },
  onLoad() { this._generation=0;this._imageGeneration=0;this._facets=0;this._show=0;this._scroll=0;this._images=new Map(); },
  async onShow() {
    this._visible=true;
    const show=++this._show;
    if(this._epoch!==session.snapshot().epoch) this.setData(initial());
    if(!await session.guard() || !this._visible || show!==this._show) return;
    const epoch=session.snapshot().epoch, revision=outfits.current();
    if(this._unwatch) this._unwatch();
    this._unwatch=outfits.watch(()=> {
      if(!this.current(this._generation)) return;
      this._revision=outfits.current();this.loadFacets();this.reload();
    });
    if(this._epoch!==epoch) {
      this._epoch=epoch;this._revision=revision;this.setData(initial());this.loadFacets();this.reload();return;
    }
    if(this._revision!==revision) { this._revision=revision;this.loadFacets();this.reload();return; }
    if(!this.data.page) this.load(false);
    else { this.refreshImages();wx.pageScrollTo({scrollTop:this._scroll,duration:0}); }
    if(this.data.facetError) this.loadFacets();
  },
  onHide() {
    if(this._unwatch) { this._unwatch();this._unwatch=null; }
    this._visible=false;this._show++;this._generation++;this._imageGeneration++;this._facets++;this._images.clear();
    this.setData({busy:false,panel:false,items:this.data.items.map(item=>({...item,previewItems:item.previewItems.map(child=>({...child,src:''}))}))});
  },
  onUnload() { this.onHide(); },
  onPageScroll(event) { this._scroll=event.scrollTop; },
  onReachBottom() { this.more(); },
  current(generation) { return this._visible && this._epoch===session.snapshot().epoch && generation===this._generation; },
  async loadFacets(archived=this.data.archived) {
    const epoch=this._epoch,sequence=++this._facets;
    this.setData({facetError:''});
    try {
      const value=await request('/outfits/facets',{data:{archived}});
      if(this._visible && epoch===session.snapshot().epoch && sequence===this._facets) this.setData({occasions:value.occasions});
    } catch(error) { if(this._visible && epoch===session.snapshot().epoch && sequence===this._facets) this.setData({facetError:error.message}); }
  },
  retryFacets() { this.loadFacets(this.data.panel?this.data.draftArchived:this.data.archived); },
  reload() {
    this._generation++;this._imageGeneration++;this._images.clear();this._scroll=0;
    this.setData({items:[],page:0,total:0,busy:false,error:''});
    wx.pageScrollTo({scrollTop:0,duration:0});this.load(false);
  },
  async load(append) {
    if(this.data.busy || !this._visible) return;
    const generation=++this._generation,page=append?this.data.page+1:1;
    const data={page,pageSize:12,archived:this.data.archived};
    for(const key of ['keyword','occasion']) if(this.data[key]) data[key]=this.data[key];
    this.setData({busy:true,error:''});
    try {
      const result=await request('/outfits',{data});
      if(!this.current(generation)) return;
      const items=result.items.map(item=>({...item,previewItems:item.previewItems.map(child=>({...child,src:'',imageState:'loading'}))}));
      this.setData({items:append?[...this.data.items,...items]:items,page:result.page,total:result.total,busy:false});this.refreshImages();
    } catch(error) { if(this.current(generation)) this.setData({busy:false,error:error.message}); }
  },
  more() { if(this.data.page && this.data.items.length<this.data.total) this.load(true); },
  retry() { this.load(Boolean(this.data.page)); },
  refreshImages() { for(const item of this.data.items) for(const child of item.previewItems) if(!child.src) this.readImage(item.id,child.id,child.imagePath); },
  async readImage(parent,id,imagePath) {
    const generation=this._imageGeneration,key=parent+':'+id,attempt={};this._images.set(key,attempt);
    const update=patch=> {
      if(!this._visible || this._epoch!==session.snapshot().epoch || generation!==this._imageGeneration || this._images.get(key)!==attempt) return;
      const p=this.data.items.findIndex(item=>item.id===parent);
      if(p<0) return;
      const i=this.data.items[p].previewItems.findIndex(item=>item.id===id && item.imagePath===imagePath);
      if(i>=0) this.setData({[`items[${p}].previewItems[${i}]`]:{...this.data.items[p].previewItems[i],...patch}});
    };
    update({imageState:'loading'});
    try { update({src:await media.download(imagePath),imageState:'ready'}); }
    catch(error) { update({src:'',imageState:'failed'}); }
  },
  retryImage(event) {
    const {parent,id}=event.currentTarget.dataset;
    const child=this.data.items.find(item=>item.id===Number(parent)).previewItems.find(item=>item.id===Number(id));
    this.readImage(Number(parent),child.id,child.imagePath);
  },
  imageFailed(event) {
    if(!this.current(this._generation)) return;
    const {parent,id,src}=event.currentTarget.dataset,p=this.data.items.findIndex(item=>item.id===Number(parent));
    if(p<0) return;
    const i=this.data.items[p].previewItems.findIndex(item=>item.id===Number(id));
    if(i>=0 && this.data.items[p].previewItems[i].src===src) this.setData({[`items[${p}].previewItems[${i}].src`]:'',[`items[${p}].previewItems[${i}].imageState`]:'failed'});
  },
  keywordInput(event) { this.setData({keywordDraft:event.detail.value}); },
  search() {
    const keyword=this.data.keywordDraft.trim();
    if(Array.from(keyword).length>40) { this.setData({error:'搜索名称不能超过40个字符'});return; }
    this.setData({keyword});this.reload();
  },
  clearSearch() { this.setData({keyword:'',keywordDraft:''});this.reload(); },
  openPanel() { this.setData({panel:true,draftOccasion:this.data.occasion,draftArchived:this.data.archived});this.loadFacets(); },
  closePanel() { this.setData({panel:false});this.loadFacets(); },
  chooseOccasion(event) { this.setData({draftOccasion:event.currentTarget.dataset.value}); },
  chooseScope(event) { this.setData({draftArchived:event.currentTarget.dataset.id});this.loadFacets(this.data.draftArchived); },
  resetPanel() { this.setData({draftOccasion:'',draftArchived:'active'});this.loadFacets('active'); },
  applyPanel() { this.setData({occasion:this.data.draftOccasion,archived:this.data.draftArchived,panel:false});this.loadFacets();this.reload(); },
  clearFilters() { this.setData({keyword:'',keywordDraft:'',occasion:'',archived:'active'});this.loadFacets();this.reload(); },
  detail(event) { if(this.current(this._generation)) wx.navigateTo({url:'/pages/outfits/detail/index?id='+event.currentTarget.dataset.id}); },
});
