const { apiBaseUrl } = require('../../config.js');
Page({
  data: { state: 'idle', statusText: '尚未检查', detail: '点击下方按钮，检查与本机服务的连接。' },
  checkConnection() {
    this.setData({ state: 'checking', statusText: '正在检查', detail: '正在连接本机服务…' });
    wx.request({
      url: apiBaseUrl + '/health', method: 'GET', timeout: 5000,
      success: res => {
        const valid = res.statusCode === 200 && res.data?.data?.status === 'ok';
        this.setData({ state: valid ? 'success' : 'failed', statusText: valid ? '本地服务已连接' : '服务响应异常', detail: valid ? '本次连接检查成功。账号和业务功能尚未接入。' : res.statusCode !== 200 ? '服务返回 HTTP ' + res.statusCode + '，请检查后端地址和运行状态。' : '响应内容与连接检查约定不符，请检查后端地址。' });
      },
      fail: error => this.setData({ state: 'failed', statusText: '暂时无法连接', detail: error.errMsg.includes('timeout') ? '连接超时，请确认本机服务已启动后重试。' : '请确认本机服务已启动，并检查接口地址与开发者工具的本地网络设置。' }),
    });
  },
});
