// popup.js - 弹出窗口逻辑
document.getElementById('openPage').addEventListener('click', () => {
  chrome.tabs.create({
    url: 'https://member.bilibili.com/platform/upload/video/frame'
  })
  document.getElementById('status').textContent = '已打开B站投稿页面，请在页面右侧使用助手面板'
})
