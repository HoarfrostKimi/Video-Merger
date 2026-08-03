// index.js - 入口：启动编排（构建产物为 IIFE 单文件 dist/content.js）
import { createPanel } from './ui/panel.js'
import { logBuffer, MAX_LOG_BUFFER, isUploading, recordError, setIsUploading } from './core/errorReport.js'
import { batchUpload } from './flow.js'

(function () {
  'use strict'

  // 防止重复注入
  if (document.getElementById('bili-helper-panel')) return

  createPanel()
  console.log('[B站投稿助手] 面板已注入')

  // 页面可见性检测：后台/最小化标签页会被浏览器节流，导致投稿流程卡住或点击无效
  let hiddenSince = null
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenSince = Date.now()
    } else if (hiddenSince) {
      const seconds = Math.round((Date.now() - hiddenSince) / 1000)
      // 只有任务运行中且隐藏超过 2s 才提示，避免挂机/快速切标签误报
      if (isUploading && seconds >= 2) {
        const msg = `⚠️ 页面曾被隐藏 ${seconds}s，期间浏览器可能节流了投稿流程，请确认投稿状态`
        logBuffer.push(msg)
        if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift()
        const content = document.getElementById('bili-helper-log-content')
        if (content) {
          content.textContent += msg + '\n'
          content.scrollTop = content.scrollHeight
        }
        console.log('[B站投稿助手]', msg)
      }
      hiddenSince = null
    }
  })

  // 检测 URL 参数，自动开始上传（来自视频合并 app 的联动）
  const urlParams = new URLSearchParams(window.location.search)
  const autoFilesParam = urlParams.get('autoFiles')
  if (autoFilesParam) {
    // 立即清除 URL 中的 autoFiles 参数，防止刷新页面后重复投稿
    urlParams.delete('autoFiles')
    const newSearch = urlParams.toString()
    history.replaceState(null, '', location.pathname + (newSearch ? '?' + newSearch : '') + location.hash)

    const fileUrls = autoFilesParam.split(',').map((u) => decodeURIComponent(u.trim())).filter(Boolean)
    if (fileUrls.length > 0) {
      console.log('[B站投稿助手] 检测到自动上传参数，文件数:', fileUrls.length)

      // 提取本地服务器基础 URL（用于发送完成信号）
      const serverBaseUrl = fileUrls[0].split('?')[0]

      // 延迟执行，等页面完全加载
      setTimeout(async () => {
        logBuffer.length = 0
        const logDiv = document.getElementById('bili-helper-log')
        const logContent = document.getElementById('bili-helper-log-content')
        if (logDiv) logDiv.style.display = 'block'

        const onLog = (msg) => {
          if (logContent) {
            logBuffer.push(msg)
            if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift()
            logContent.textContent += msg + '\n'
            logContent.scrollTop = logContent.scrollHeight
          }
          console.log('[B站投稿助手]', msg)
        }

        onLog('收到视频合并app的自动上传指令...')

        setIsUploading(true)
        try {
          // 从本地服务器下载文件
          const files = []
          for (let i = 0; i < fileUrls.length; i++) {
            onLog(`正在获取第 ${i + 1}/${fileUrls.length} 个视频...`)
            const resp = await fetch(fileUrls[i])
            if (!resp.ok) throw new Error(`下载失败: ${resp.status}`)
            const blob = await resp.blob()
            // 从 URL 的 name 参数提取原始文件名
            const urlObj = new URL(fileUrls[i])
            const fileName = urlObj.searchParams.get('name') || `video_${i + 1}.mp4`
            files.push(new File([blob], fileName, { type: 'video/mp4' }))
            onLog(`已获取: ${fileName} (${(blob.size / 1024 / 1024).toFixed(1)}MB)`)
          }

          onLog(`共获取 ${files.length} 个视频，开始自动上传...`)
          onLog('')

          const visText = document.getElementById('bili-helper-visibility').value
          await batchUpload(files, onLog, visText)
          onLog('')
          onLog('===== 全部处理完成 =====')

          // 发送完成信号给 app，让 app 自动关闭
          try {
            await fetch(serverBaseUrl + '?signal=done')
            onLog('已通知 app 关闭')
          } catch (e) {
            console.log('[B站投稿助手] 发送完成信号失败:', e)
          }
        } catch (err) {
          recordError(err)
          onLog(`错误: ${err.message}`)
        } finally {
          setIsUploading(false)
        }
      }, 3000)
    }
  }
})()
