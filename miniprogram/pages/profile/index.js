const session = require('../../utils/session.js');
const { request } = require('../../utils/request.js');
const media = require('../../utils/media.js');
Page({
  data: { ready: false, username: '', nickname: '', avatarPath: null, count: 0, dirty: false, busy: false, error: '', fields: {}, focusField: '', avatarSrc: '', avatarState: 'empty', avatarError: '', uploadState: 'idle', selectedLocalPath: '' },
  async onLoad() {
    this._alive = true; this._visible = true; this._imageSequence = 0; this._uploadSequence = 0;
    if (!await session.guard() || !this._alive) return;
    const user = session.snapshot().user;
    this._formEpoch = session.snapshot().epoch;
    this._initial = { nickname: user.nickname, avatarPath: user.avatarPath };
    this.setData({ ready: true, username: user.username, nickname: user.nickname, avatarPath: user.avatarPath, count: Array.from(user.nickname).length });
    this.refreshAvatar();
  },
  async onShow() {
    this._visible = true;
    if (this.data.ready && this._formEpoch !== session.snapshot().epoch) {
      this.setData({ ready: false, username: '', nickname: '', avatarPath: null, selectedLocalPath: '', avatarSrc: '' }); session.showLogin(); return;
    }
    if (await session.guard() && this._alive && this.data.ready) this.refreshAvatar();
  },
  onHide() { this._visible = false; this._imageSequence++; this.setData({ avatarSrc: '' }); },
  onUnload() { this._alive = false; this._imageSequence++; this._uploadSequence++; this.setData({ avatarSrc: '', selectedLocalPath: '' }); wx.disableAlertBeforeUnload(); },
  input(e) { this.setData({ nickname: e.detail.value, count: Array.from(e.detail.value.trim()).length, error: '', fields: {} }); this.updateDirty(); },
  async refreshAvatar() {
    const sequence = ++this._imageSequence, epoch = session.snapshot().epoch;
    if (!this._visible || !this._alive) return;
    if (this.data.selectedLocalPath) { this.setData({ avatarSrc: this.data.selectedLocalPath, avatarState: 'ready' }); return; }
    if (this.data.avatarPath === null) { this.setData({ avatarSrc: '', avatarState: 'empty', avatarError: '' }); return; }
    this.setData({ avatarSrc: '', avatarState: 'loading', avatarError: '' });
    try {
      const src = await media.download(this.data.avatarPath);
      if (this._alive && this._visible && sequence === this._imageSequence && epoch === session.snapshot().epoch) this.setData({ avatarSrc: src, avatarState: 'ready' });
    } catch (error) {
      if (this._alive && this._visible && sequence === this._imageSequence && epoch === session.snapshot().epoch && error.code !== 'STALE_SESSION') this.setData({ avatarState: 'failed', avatarError: error.message });
    }
  },
  imageError() { if (this._alive && this._visible) this.setData({ avatarSrc: '', avatarState: 'failed', avatarError: '图片预览失败，请重新读取或选择图片' }); },
  chooseAvatar() {
    if (this.data.busy || this.data.uploadState === 'uploading' || this._choosing) return;
    const epoch = session.snapshot().epoch; this._choosing = true;
    wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['original'], sourceType: ['album','camera'],
      success: result => {
        this._choosing = false;
        if (!this._alive || epoch !== session.snapshot().epoch) return;
        const file = result.tempFiles[0];
        if (file.size > 5242880) { this.setData({ error: '图片不能超过5MiB' }); return; }
        this._candidateBase = this.data.avatarPath;
        this._imageSequence++;
        this.setData({ selectedLocalPath: file.tempFilePath, avatarSrc: this._visible ? file.tempFilePath : '', avatarState: 'ready', avatarError: '', error: '' });
        this.updateDirty(); this.uploadSelected();
      },
      fail: error => { this._choosing = false; if (this._alive && epoch === session.snapshot().epoch && !error.errMsg.includes('cancel')) this.setData({ error: '未能选择图片，请重试' }); },
    });
  },
  async uploadSelected() {
    if (this.data.uploadState === 'uploading' || !this.data.selectedLocalPath) return;
    const sequence = ++this._uploadSequence, epoch = session.snapshot().epoch, localPath = this.data.selectedLocalPath;
    this.setData({ uploadState: 'uploading', error: '' });
    try {
      const value = await media.upload(localPath);
      if (!this._alive || sequence !== this._uploadSequence || epoch !== session.snapshot().epoch) return;
      this.setData({ avatarPath: value.imagePath, selectedLocalPath: '', uploadState: 'idle', avatarSrc: this._visible ? localPath : '', avatarState: 'ready', avatarError: '' });
      this.updateDirty();
    } catch (error) {
      if (this._alive && sequence === this._uploadSequence && epoch === session.snapshot().epoch && error.code !== 'STALE_SESSION') this.setData({ uploadState: 'failed', error: error.message });
    }
  },
  discardSelection() {
    if (this.data.uploadState === 'uploading') return;
    this._uploadSequence++;
    this.setData({ selectedLocalPath: '', avatarPath: this._candidateBase, uploadState: 'idle', error: '', avatarError: '' });
    this.updateDirty(); this.refreshAvatar();
  },
  removeAvatar() {
    if (this.data.busy || this.data.uploadState === 'uploading') return;
    this._imageSequence++; this._uploadSequence++;
    this.setData({ avatarPath: null, selectedLocalPath: '', avatarSrc: '', avatarState: 'empty', avatarError: '', uploadState: 'idle', error: '' }); this.updateDirty();
  },
  updateDirty() {
    const dirty = this.data.nickname.trim() !== this._initial.nickname || this.data.avatarPath !== this._initial.avatarPath || Boolean(this.data.selectedLocalPath);
    this.setData({ dirty });
    if (dirty) wx.enableAlertBeforeUnload({ message: '资料尚未保存，确定离开吗？' }); else wx.disableAlertBeforeUnload();
  },
  cancel() {
    if (this.data.busy) return;
    const leave = () => { wx.disableAlertBeforeUnload(); wx.navigateBack(); };
    if (!this.data.dirty) { leave(); return; }
    wx.showModal({ title: '放弃修改？', content: '尚未保存的资料将丢失。', confirmText: '放弃修改', success: res => { if (res.confirm) leave(); } });
  },
  async save() {
    if (this.data.busy || this.data.uploadState === 'uploading' || this.data.selectedLocalPath) return;
    const name = this.data.nickname.trim();
    if (!name || Array.from(name).length > 20 || /[\r\n\u2028\u2029]/.test(this.data.nickname)) {
      this.setData({ error: '请检查昵称', fields: { nickname: '昵称为1～20个字符，不能换行' }, focusField: 'nickname' }); return;
    }
    this.setData({ busy: true, error: '', fields: {} });
    try {
      const user = await request('/me', { method: 'PUT', data: { nickname: name, avatarPath: this.data.avatarPath } });
      session.setUser(user);
      if (!this._alive) return;
      this.setData({ dirty: false }); wx.disableAlertBeforeUnload();
      if (this._visible) wx.navigateBack();
    } catch (error) { if (this._alive && error.code !== 'STALE_SESSION') this.setData({ error: error.message, fields: error.fields || {}, focusField: Object.keys(error.fields || {})[0] || '' }); }
    finally { if (this._alive) this.setData({ busy: false }); }
  },
});
