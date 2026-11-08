const session = require('../../utils/session.js');
const { request } = require('../../utils/request.js');
const media = require('../../utils/media.js');
Page({
  data: { avatarSrc: '', avatarState: 'empty', avatarError: '', user: null, busy: false, error: '', state: 'idle', statusText: '尚未检查', detail: '检查与本机服务的连接。' },
  async onShow() {
    this._visible = true; const sequence = (this._sequence || 0) + 1; this._sequence = sequence;
    this.setData({ user: null, error: '', avatarSrc: '', avatarState: 'empty', avatarError: '' });
    if (!await session.guard()) return;
    const epoch = session.snapshot().epoch;
    try {
      const user = await request('/me');
      if (!this._visible || sequence !== this._sequence || epoch !== session.snapshot().epoch) return;
      session.setUser(user); this.setData({ user }); this.refreshAvatar();
    } catch (error) { if (this._visible && sequence === this._sequence && error.code !== 'STALE_SESSION') this.setData({ error: error.message }); }
  },
  onHide() { this._visible = false; this._sequence++; this.setData({ user: null, avatarSrc: '', avatarState: 'empty', avatarError: '' }); },
  onUnload() { this.onHide(); },
  async refreshAvatar() {
    if (!this.data.user || this.data.user.avatarPath === null) return;
    const sequence = this._sequence, epoch = session.snapshot().epoch;
    this.setData({ avatarSrc: '', avatarState: 'loading', avatarError: '' });
    try {
      const src = await media.download(this.data.user.avatarPath);
      if (this._visible && sequence === this._sequence && epoch === session.snapshot().epoch) this.setData({ avatarSrc: src, avatarState: 'ready' });
    } catch (error) { if (this._visible && sequence === this._sequence && epoch === session.snapshot().epoch && error.code !== 'STALE_SESSION') this.setData({ avatarState: 'failed', avatarError: error.message }); }
  },
  imageError() { if (this._visible) this.setData({ avatarSrc: '', avatarState: 'failed', avatarError: '图片显示失败，请重新读取' }); },
  editProfile() { wx.navigateTo({ url: '/pages/profile/index' }); },
  async logout() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      const result = await request('/auth/logout', { method: 'POST' });
      if (result.loggedOut !== true) { this.setData({ error: '退出未确认，请重试' }); return; }
      session.clear(); this.setData({ user: null, avatarSrc: '', avatarState: 'empty' }); session.showLogin();
    } catch (error) { if (!['STALE_SESSION','UNAUTHENTICATED'].includes(error.code)) this.setData({ error: '退出未确认，请重试' }); }
    finally { this.setData({ busy: false }); }
  },
  async checkConnection() {
    if (this.data.state === 'checking') return;
    this.setData({ state: 'checking', statusText: '正在检查', detail: '正在连接本机服务…' });
    try {
      const result = await request('/health', { auth: false });
      const valid = result?.status === 'ok';
      this.setData({ state: valid ? 'success' : 'failed', statusText: valid ? '本地服务已连接' : '服务响应异常', detail: valid ? '本次连接检查成功。' : '响应内容与连接检查约定不符。' });
    } catch (error) { this.setData({ state: 'failed', statusText: ['NETWORK_ERROR','TIMEOUT'].includes(error.code) ? '暂时无法连接' : '服务响应异常', detail: error.message }); }
  },
});
