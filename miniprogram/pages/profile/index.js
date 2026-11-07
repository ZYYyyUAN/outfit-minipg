const session = require('../../utils/session.js');
const { request } = require('../../utils/request.js');
Page({
  data: { username: '', nickname: '', avatarPath: null, count: 0, dirty: false, busy: false, error: '', fields: {}, focusField: '' },
  async onLoad() {
    this._active = true;
    if (!await session.guard()) return;
    const user = session.snapshot().user;
    this._initial = { nickname: user.nickname, avatarPath: user.avatarPath };
    this.setData({ username: user.username, nickname: user.nickname, avatarPath: user.avatarPath, count: Array.from(user.nickname).length });
  },
  onShow() { session.guard(); },
  onUnload() { this._active = false; wx.disableAlertBeforeUnload(); },
  input(e) { this.setData({ nickname: e.detail.value, count: Array.from(e.detail.value.trim()).length, error: '', fields: {} }); this.updateDirty(); },
  removeAvatar() { this.setData({ avatarPath: null }); this.updateDirty(); },
  updateDirty() {
    const dirty = this.data.nickname.trim() !== this._initial.nickname || this.data.avatarPath !== this._initial.avatarPath;
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
    if (this.data.busy) return;
    const name = this.data.nickname.trim();
    if (!name || Array.from(name).length > 20 || /[\r\n\u2028\u2029]/.test(this.data.nickname)) {
      this.setData({ error: '请检查昵称', fields: { nickname: '昵称为1～20个字符，不能换行' }, focusField: 'nickname' }); return;
    }
    this.setData({ busy: true, error: '', fields: {} });
    try {
      const user = await request('/me', { method: 'PUT', data: { nickname: name, avatarPath: this.data.avatarPath } });
      session.setUser(user);
      if (!this._active) return;
      this.setData({ dirty: false }); wx.disableAlertBeforeUnload(); wx.navigateBack();
    } catch (error) { if (this._active && error.code !== 'STALE_SESSION') this.setData({ error: error.message, fields: error.fields || {}, focusField: Object.keys(error.fields || {})[0] || '' }); }
    finally { if (this._active) this.setData({ busy: false }); }
  },
});
