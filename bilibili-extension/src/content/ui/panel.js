// ui/panel.js - 助手面板：DOM 渲染、事件绑定、开始上传入口
import { batchUpload } from '../flow.js'
import { logBuffer, MAX_LOG_BUFFER, setIsUploading, recordError, formatReportMarkdown } from '../core/errorReport.js'
import { parseTitle } from '../core/title.js'
import { STORAGE_KEYS } from '../config.js'

export function createPanel() {
  const panel = document.createElement('div')
  panel.id = 'bili-helper-panel'
  panel.innerHTML = `
    <div class="bili-helper-header">
      <span class="bili-helper-title">B站投稿助手</span>
      <button class="bili-helper-minimize" id="bili-helper-min">—</button>
    </div>
    <div class="bili-helper-body" id="bili-helper-body">
      <div class="bili-helper-section">
        <p class="bili-helper-desc">选择合并好的MP4文件，自动上传并提交到B站</p>
        <div class="bili-helper-setting-row">
          <span class="bili-helper-setting-label">可见范围</span>
          <select class="bili-helper-setting-select" id="bili-helper-visibility">
            <option value="公开可见">公开可见</option>
            <option value="仅自己可见" selected>仅自己可见</option>
          </select>
        </div>
        <label class="bili-helper-file-btn">
          选择MP4文件
          <input type="file" id="bili-helper-files" multiple accept=".mp4" style="display:none" />
        </label>
      </div>
      <div id="bili-helper-file-list" style="display:none">
        <p class="bili-helper-file-count" id="bili-helper-count"></p>
        <div id="bili-helper-files-preview"></div>
        <button class="bili-helper-upload-btn" id="bili-helper-start">开始自动上传</button>
      </div>
      <div id="bili-helper-log" style="display:none">
        <button class="bili-helper-copy-btn" id="bili-helper-copy-report">📋 复制错误包（粘贴给 AI）</button>
        <pre id="bili-helper-log-content"></pre>
      </div>
    </div>
  `
  document.body.appendChild(panel)

  // 从 localStorage 加载已保存的可见范围设置
  const savedVisibility = localStorage.getItem(STORAGE_KEYS.visibility)
  if (savedVisibility) {
    const select = document.getElementById('bili-helper-visibility')
    select.value = savedVisibility
  }
  // 每次修改时保存
  document.getElementById('bili-helper-visibility').addEventListener('change', (e) => {
    localStorage.setItem(STORAGE_KEYS.visibility, e.target.value)
  })

  // 最小化/展开
  let minimized = false
  document.getElementById('bili-helper-min').addEventListener('click', () => {
    minimized = !minimized
    const body = document.getElementById('bili-helper-body')
    body.style.display = minimized ? 'none' : 'block'
    document.getElementById('bili-helper-min').textContent = minimized ? '+' : '—'
  })

  // 复制错误包：把最近一份错误报告转成 Markdown 复制到剪贴板
  document.getElementById('bili-helper-copy-report').addEventListener('click', async () => {
    const btn = document.getElementById('bili-helper-copy-report')
    let reports = []
    try {
      reports = JSON.parse(localStorage.getItem(STORAGE_KEYS.errorReports) || '[]')
    } catch (e) { reports = [] }
    if (!Array.isArray(reports) || !reports.length) {
      btn.textContent = '暂无错误报告'
      setTimeout(() => { btn.textContent = '📋 复制错误包（粘贴给 AI）' }, 1500)
      return
    }
    const md = formatReportMarkdown(reports[reports.length - 1])
    try {
      await navigator.clipboard.writeText(md)
      btn.textContent = '✅ 已复制，粘贴给 AI 即可'
    } catch (e) {
      // 兜底：textarea + execCommand（检查返回值，失败时如实提示）
      try {
        const ta = document.createElement('textarea')
        ta.value = md
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        btn.textContent = ok ? '✅ 已复制（兜底方式）' : '⚠️ 复制失败，请手动复制日志'
      } catch (e2) {
        btn.textContent = '⚠️ 复制失败'
      }
    }
    setTimeout(() => { btn.textContent = '📋 复制错误包（粘贴给 AI）' }, 2500)
  })

  // 开始上传逻辑（声明在 change 回调之前，避免 TDZ 与可读性问题）
  const startBtn = document.getElementById('bili-helper-start')
  const startClickHandler = async () => {
    const files = Array.from(document.getElementById('bili-helper-files').files)
    if (files.length === 0) return
    logBuffer.length = 0
    startBtn.disabled = true
    startBtn.textContent = '上传中...'

    const logDiv = document.getElementById('bili-helper-log')
    const logContent = document.getElementById('bili-helper-log-content')
    logDiv.style.display = 'block'
    logContent.textContent = ''

    const onLog = (msg) => {
      logBuffer.push(msg)
      if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift()
      logContent.textContent += msg + '\n'
      logContent.scrollTop = logContent.scrollHeight
    }

    setIsUploading(true)
    try {
      const visText = document.getElementById('bili-helper-visibility').value
      await batchUpload(files, onLog, visText)
      startBtn.textContent = '全部完成'
    } catch (err) {
      recordError(err)
      onLog(`错误: ${err.message}`)
      startBtn.textContent = '出错，请重试'
    } finally {
      setIsUploading(false)
      startBtn.disabled = false
    }
  }

  // 文件选择
  document.getElementById('bili-helper-files').addEventListener('change', (e) => {
    const files = Array.from(e.target.files)
    if (files.length === 0) return

    document.getElementById('bili-helper-file-list').style.display = 'block'
    document.getElementById('bili-helper-count').textContent = `已选择 ${files.length} 个视频文件`

    const preview = document.getElementById('bili-helper-files-preview')
    preview.innerHTML = ''
    files.forEach((f, i) => {
      const div = document.createElement('div')
      div.className = 'bili-helper-file-item'
      div.textContent = `${i + 1}. ${f.name} (${(f.size / 1024 / 1024).toFixed(1)}MB)`
      div.title = `标题: ${parseTitle(f.name)}`
      preview.appendChild(div)
    })

    // 绑定开始按钮：先移除旧监听器再绑定，防止重复选择文件时叠加多个监听器导致多次批量上传
    startBtn.removeEventListener('click', startClickHandler)
    startBtn.addEventListener('click', startClickHandler)
  })
}
