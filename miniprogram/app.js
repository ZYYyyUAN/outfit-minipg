const session = require('./utils/session.js');
const { request } = require('./utils/request.js');
App({
  onLaunch() { session.restore(); this.authReady = this.restoreIdentity(); },
  async restoreIdentity() {
    this.restoreError = null;
    if (!session.snapshot().token) return;
    try { session.setUser(await request('/me', { redirectOn401: false })); }
    catch (error) { if (error.code !== 'UNAUTHENTICATED' && error.code !== 'STALE_SESSION') this.restoreError = error.message; }
  },
  retryRestore() { this.authReady = this.restoreIdentity(); return this.authReady; },
});
