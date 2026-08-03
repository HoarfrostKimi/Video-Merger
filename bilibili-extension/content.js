// content.js - B站投稿页自动化核心逻辑
// 在 https://member.bilibili.com/platform/upload/video/frame 页面上注入助手面板

(function () {
  'use strict'

  // 防止重复注入
  if (document.getElementById('bili-helper-panel')) return

  // ============ 工具函数 ============

  /** 延时 */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * 轮询等待某个条件成立（取代「固定 sleep 后直接判定」，避免时序竞态）
   * @param {() => any} condition 判定函数，返回真值即视为成功
   * @param {number} [timeout=8000] 最长等待毫秒
   * @param {number} [interval=300] 轮询间隔
   * @returns {Promise<any>} 条件成立时的返回值，超时则返回 null
   */
  async function waitFor(condition, timeout = 8000, interval = 300) {
    const start = Date.now()
    for (;;) {
      const res = condition()
      if (res) return res
      if (Date.now() - start >= timeout) return null
      await sleep(interval)
    }
  }

  /** 从文件名提取核心标题（去掉日期与「合并版」后缀），用于页面定位等内部匹配 */
  function cleanTitle(fileName) {
    const name = fileName.replace(/\.mp4$/i, '')
    const title = name
      .replace(/^(?:\d{4}[-_]\d{2}[-_]\d{2})\s*[_\s]*/, '')  // 去前置日期（分隔符可选）
      .replace(/(?:\s*_*\s*合并版)+$/g, '')                   // 去合并版后缀（先剥，避免残留日期被后置规则漏掉）
      .replace(/(?:\s*_?\s*\d{4}[-_]\d{2}[-_]\d{2})$/, '')     // 去后置日期
      .trim()
    return title || name
  }

  /** 从文件名解析投稿标题：保留文件名中的日期（如有）并前置，不加时间 */
  function parseTitle(fileName) {
    const name = fileName.replace(/\.mp4$/i, '')
    const dateMatch = name.match(/(\d{4})[-_](\d{2})[-_](\d{2})/)
    const title = cleanTitle(fileName)
    // title === name 表示未提取出独立标题（如文件名就是「日期_合并版」），此时不拼重复日期
    if (dateMatch && title !== name) {
      return `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]} ${title}`
    }
    return title
  }

  /** 等待元素出现（支持多个 selector） */
  function waitForElement(selectors, timeout = 30000) {
    const selectorList = Array.isArray(selectors) ? selectors : [selectors]
    return new Promise((resolve, reject) => {
      for (const sel of selectorList) {
        const el = document.querySelector(sel)
        if (el) return resolve(el)
      }
      const observer = new MutationObserver(() => {
        for (const sel of selectorList) {
          const el = document.querySelector(sel)
          if (el) {
            observer.disconnect()
            return resolve(el)
          }
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      setTimeout(() => {
        observer.disconnect()
        reject(new Error(`等待元素超时`))
      }, timeout)
    })
  }

  /** 等待 DOM 中出现包含指定文本的可见元素 */
  function waitForElementByText(keyword, timeout = 60000) {
    const check = () => {
      for (const el of document.querySelectorAll('*')) {
        const text = el.textContent || ''
        if (text.includes(keyword) && text.length < 200) {
          const rect = el.getBoundingClientRect()
          if (rect.width > 100 && rect.height > 30) return el
        }
      }
      return null
    }
    const existing = check()
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const obs = new MutationObserver(() => {
        const el = check()
        if (el) { obs.disconnect(); resolve(el) }
      })
      obs.observe(document.body, { childList: true, subtree: true })
      setTimeout(() => { obs.disconnect(); reject(new Error(`等待「${keyword}」超时`)) }, timeout)
    })
  }

  /** 查找B站上传页面的文件输入框 */
  function findFileInput() {
    const selectors = [
      'input[type="file"][accept*="video"]',
      'input[type="file"][accept*="mp4"]',
      '.upload-area input[type="file"]',
      '[class*="upload"] input[type="file"]',
      '[class*="drop"] input[type="file"]',
      'input[type="file"]',
    ]
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      if (el) {
        console.log('[B站投稿助手] 找到 file input:', sel)
        return el
      }
    }
    return null
  }

  /** 通过文本内容查找可点击元素 */
  function findButtonByText(text) {
    const all = document.querySelectorAll('*')

    // 第一轮：找直接文本节点匹配的最小元素，然后向上找可点击父元素
    let bestMatch = null
    for (const el of all) {
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent)
        .join('')
        .trim()
      if (directText === text) {
        if (!bestMatch || el.childNodes.length < bestMatch.childNodes.length) {
          bestMatch = el
        }
      }
    }
    return bestMatch ? toClickable(bestMatch) : null
  }

  /** 从文本元素向上找到可点击的父元素 */
  function toClickable(el) {
    let cur = el
    while (cur && cur !== document.body) {
      const tag = cur.tagName.toLowerCase()
      if (tag === 'button' || tag === 'a' || cur.getAttribute('role') === 'button') {
        return cur
      }
      const cls = cur.className || ''
      if (typeof cls === 'string' && (cls.includes('btn') || cls.includes('button') || cls.includes('link') || cls.includes('cover'))) {
        return cur
      }
      // 检查是否有 pointer 光标（暗示可点击）
      const style = window.getComputedStyle(cur)
      if (style.cursor === 'pointer') {
        return cur
      }
      cur = cur.parentElement
    }
    return el
  }

  /** 通过文本查找并点击下拉选项 */
  function clickDropdownOption(text) {
    // 查找所有可见的下拉菜单项
    const items = document.querySelectorAll(
      '.el-select-dropdown__item, .el-dropdown-menu__item, [class*="dropdown"] [class*="item"], [class*="option"], li'
    )
    for (const item of items) {
      if (item.textContent.trim() === text || item.textContent.trim().includes(text)) {
        // 确保元素可见
        const rect = item.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          item.click()
          return true
        }
      }
    }
    return false
  }

  // ============ 错误自证（错误包收集） ============

  /** 日志缓冲：onLog 的所有输出同时累积于此，供错误包取尾部 */
  const logBuffer = []
  const MAX_LOG_BUFFER = 300

  /** 当前执行步骤（由 runStep 维护），出错时用于定位步骤名与源码 */
  let currentStep = null

  /** 任务运行标志：批量上传进行中为 true（visibilitychange 提示据此避免误报） */
  let isUploading = false

  /**
   * 记录当前执行步骤：保存步骤名与函数源码（函数 toString() 无需任何权限）。
   * 后续步骤出错时，错误包能带上「当时在跑哪个函数、源码长什么样」。
   */
  async function runStep(name, fn, ...args) {
    currentStep = { name, source: fn.toString() }
    return fn(...args)
  }

  /** 收集关键 DOM 快照（出错瞬间页面长什么样），供 AI 定位选择器 */
  function collectDomSnapshot() {
    const snap = {}
    const grab = (key, selectors) => {
      try {
        const el = document.querySelector(selectors)
        snap[key] = el ? el.outerHTML.slice(0, 600) : null
      } catch (e) {
        snap[key] = null
      }
    }
    grab('标题框', 'input[placeholder*="标题"], textarea[placeholder*="标题"]')
    grab('可见范围radio', '.check-radio-v2-container')
    grab('创作声明select', '.el-select')
    grab('上传file input', 'input[type="file"]')
    const coverDialog = findCoverDialog()
    snap['封面弹窗'] = coverDialog ? coverDialog.outerHTML.slice(0, 800) : null
    const submitBtn = findButtonByText('立即投稿')
    snap['立即投稿按钮'] = submitBtn ? submitBtn.outerHTML.slice(0, 300) : null
    return snap
  }

  /**
   * 记录一次错误并自动保存到 localStorage（保留最近 5 份）。
   * @param {Error|string} err
   * @param {object} [extra] 附加上下文（如当前文件/批次）
   */
  function recordError(err, extra) {
    let dom = {}
    try { dom = collectDomSnapshot() } catch (e) { dom = { _error: String(e) } }
    const report = {
      time: new Date().toLocaleString(),
      url: location.href,
      step: currentStep ? currentStep.name : 'unknown',
      error: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n') : '',
      logTail: logBuffer.slice(-40),
      dom,
      source: currentStep ? currentStep.source.slice(0, 4000) : '',
      extra: extra || {},
    }
    try {
      const key = 'bili_helper_error_reports'
      const list = JSON.parse(localStorage.getItem(key) || '[]')
      if (!Array.isArray(list)) throw new Error('bad data')
      list.push(report)
      while (list.length > 5) list.shift()
      localStorage.setItem(key, JSON.stringify(list))
    } catch (e) {
      console.log('[B站投稿助手] 保存错误报告失败:', e)
    }
    return report
  }

  /** 把错误报告格式化成 Markdown（可直接粘贴给 AI） */
  function formatReportMarkdown(report) {
    const lines = []
    lines.push('# B站投稿助手 · 错误报告')
    lines.push('')
    lines.push('## 基本信息')
    lines.push(`- 时间: ${report.time}`)
    lines.push(`- 页面: ${report.url}`)
    lines.push(`- 出错步骤: ${report.step}`)
    lines.push(`- 错误: ${report.error}`)
    if (report.stack) {
      lines.push('')
      lines.push('## 调用栈（前5行）')
      lines.push('```')
      lines.push(report.stack)
      lines.push('```')
    }
    if (Object.keys(report.extra || {}).length) {
      lines.push('')
      lines.push('## 附加上下文')
      for (const [k, v] of Object.entries(report.extra)) {
        lines.push(`- ${k}: ${v}`)
      }
    }
    lines.push('')
    lines.push('## 日志（尾部40条）')
    lines.push('```')
    lines.push((report.logTail || []).join('\n') || '(无日志)')
    lines.push('```')
    lines.push('')
    lines.push('## 出错瞬间 DOM 快照（选择器定位用）')
    for (const [key, html] of Object.entries(report.dom || {})) {
      lines.push(`### ${key}`)
      lines.push(html ? '```html\n' + html + '\n```' : '`(未找到)`')
    }
    lines.push('')
    lines.push('## 出错步骤源码')
    lines.push('```js')
    lines.push(report.source || '(无)')
    lines.push('```')
    return lines.join('\n')
  }

  // ============ 核心自动化步骤 ============

  /**
   * Step 1: 上传视频文件
   */
  async function stepUploadFile(file, onLog) {
    onLog('查找上传入口...')
    const fileInput = findFileInput()
    if (!fileInput) {
      throw new Error('未找到文件上传入口，请确认已在B站投稿页面')
    }
    onLog('找到上传入口，正在设置文件...')

    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(file)
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files').set
    if (nativeSetter) {
      nativeSetter.call(fileInput, dataTransfer.files)
    } else {
      fileInput.files = dataTransfer.files
    }
    fileInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
    fileInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    onLog('文件已选择，等待上传...')
  }

  /**
   * Step 2: 等待表单出现（不需要等上传完成，B站允许边上传边填表）
   */
  async function stepWaitForForm(onLog) {
    onLog('等待表单加载...')
    await waitForElement([
      'input[placeholder*="标题"]',
      'textarea[placeholder*="标题"]',
      '[class*="title"] input',
    ], 600000)
    await sleep(2000)
    onLog('表单已加载，开始设置')
  }

  /**
   * Step 3: 填写标题
   * B站上传后默认以文件名作为标题，但该行为可能随版本变化；
   * 显式填入解析出的标题，避免投稿出现空标题/错误标题。
   */
  async function stepSetTitle(title, onLog) {
    onLog(`填写标题: ${title}`)
    let input
    // 优先匹配更具体的主标题占位文案，避免命中分P标题框（分P编辑页同时存在多个标题框）
    const preciseSelectors = [
      'input[placeholder*="输入标题"]',
      'textarea[placeholder*="输入标题"]',
      'input[placeholder*="填写标题"]',
      'textarea[placeholder*="填写标题"]',
      'input[placeholder*="作品标题"]',
      'textarea[placeholder*="作品标题"]',
    ]
    const fallbackSelectors = [
      'input[placeholder*="标题"]',
      'textarea[placeholder*="标题"]',
      '[class*="title"] input',
      '[class*="title"] textarea',
    ]
    try {
      input = await waitForElement(preciseSelectors, 5000)
    } catch (err) { /* 精确匹配超时，回退到模糊选择器 */ }
    if (!input) {
      try {
        input = await waitForElement(fallbackSelectors, 10000)
      } catch (err) {
        onLog('提示: 未找到标题输入框，跳过标题填写')
        return
      }
    }
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    const applyTitle = () => {
      if (setter) setter.call(input, title)
      else input.value = title
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
    }
    applyTitle()
    await sleep(300)
    // 校验：编辑器可能截断或异步清空，未生效则重填一次
    if ((input.value || '').trim() !== title.trim()) {
      applyTitle()
      await sleep(300)
    }
    if ((input.value || '').trim() !== title.trim()) {
      onLog(`警告: 标题填写后未生效（当前值: ${input.value || '(空)'}），请检查标题框是否被锁定`)
    } else {
      onLog('标题已填写')
    }
  }

  /**
   * Step 4: 设置创作声明为「内容无需标注」
   */
  async function stepSetDeclaration(onLog) {
    onLog('设置创作声明...')

    /** 打开 select 并点击目标选项 */
    async function trySelectDeclaration(selectEl) {
      const trigger = selectEl.querySelector('.el-select__wrapper, .el-input__inner')
      if (!trigger) return false
      trigger.click()
      await sleep(500)
      return clickDropdownOption('内容无需标注')
    }

    // 主方案：通过"创作声明"标签文本精确定位
    for (const label of document.querySelectorAll('span, label, div')) {
      if (label.textContent.trim() === '创作声明') {
        const parent = label.closest('.el-form-item, tr, [class*="row"], [class*="item"]') || label.parentElement
        const targetSelect = parent?.querySelector('.el-select, select, [class*="select"]')
        if (targetSelect && await trySelectDeclaration(targetSelect)) {
          return onLog('创作声明已设置为「内容无需标注」')
        }
        break
      }
    }

    // 备用方案：遍历所有 el-select，找到关联"创作声明"的那一个
    for (const sel of document.querySelectorAll('.el-select')) {
      if (sel.closest('.el-form-item')?.textContent.includes('创作声明')) {
        if (await trySelectDeclaration(sel)) {
          return onLog('创作声明已设置为「内容无需标注」（备用方案）')
        }
      }
    }

    onLog('提示: 创作声明可能已默认为「内容无需标注」，跳过')
  }

  /**
   * Step 5: 设置可见范围
   * 可见范围是自定义 check-radio-v2 组件，非原生 radio 也非 el-select
   * @param {string} targetText - 要选中的可见范围文本，如'公开可见'、'仅自己可见'
   */
  async function stepSetVisibility(onLog, targetText) {
    const text = targetText || '仅自己可见'
    onLog(`设置可见范围为「${text}」...`)

    // 查找包含目标文本的 check-radio-v2-container
    const nameSpans = document.querySelectorAll('.check-radio-v2-name')
    for (const span of nameSpans) {
      if (span.textContent.trim() === text) {
        const container = span.closest('.check-radio-v2-container')
        if (container) {
          if (container.classList.contains('active') || container.classList.contains('checked') || container.querySelector('.check-radio-v2-box')?.classList.contains('checked')) {
            onLog(`可见范围已是「${text}」`)
          } else {
            container.click()
            onLog(`可见范围已设置为「${text}」`)
          }
          await sleep(500)
          return
        }
      }
    }

    // 备用方案：通过文本内容查找
    onLog('提示: 未通过 class 定位，尝试备用方案...')
    const allEls = document.querySelectorAll('div, span, label')
    for (const el of allEls) {
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent)
        .join('')
        .trim()
      if (directText === text) {
        const clickable = el.closest('.check-radio-v2-container') || el.parentElement
        if (clickable) {
          clickable.click()
          onLog(`可见范围已设置为「${text}」（备用方案）`)
          await sleep(500)
          return
        }
      }
    }

    onLog(`提示: 未找到可见范围「${text}」，请手动设置`)
    await sleep(500)
  }

  /**
   * 从视频文件中截取一帧作为封面图片
   */
  async function captureFrameFromFile(file) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video')
      video.src = URL.createObjectURL(file)
      video.muted = true
      video.preload = 'auto'

      video.addEventListener('loadeddata', () => {
        // 跳到第2秒（或视频长度的一半，取较小值）
        const seekTime = Math.min(2, video.duration / 2)
        video.currentTime = seekTime
      })

      video.addEventListener('seeked', () => {
        const vw = video.videoWidth || 1280
        const vh = video.videoHeight || 720

        // 计算 4:3 居中裁剪区域
        const targetRatio = 4 / 3
        const videoRatio = vw / vh
        let sx, sy, sw, sh
        if (videoRatio > targetRatio) {
          // 视频更宽，裁剪左右
          sh = vh
          sw = vh * targetRatio
          sx = (vw - sw) / 2
          sy = 0
        } else {
          // 视频更高，裁剪上下
          sw = vw
          sh = vw / targetRatio
          sx = 0
          sy = (vh - sh) / 2
        }

        const canvas = document.createElement('canvas')
        canvas.width = Math.round(sw)
        canvas.height = Math.round(sh)
        const ctx = canvas.getContext('2d')
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(video.src)
          if (blob) resolve(blob)
          else reject(new Error('截帧失败'))
        }, 'image/jpeg', 0.9)
      })

      video.addEventListener('error', () => {
        URL.revokeObjectURL(video.src)
        reject(new Error('视频加载失败'))
      })

      // 15秒超时
      setTimeout(() => {
        URL.revokeObjectURL(video.src)
        reject(new Error('截帧超时'))
      }, 15000)
    })
  }

  /** 提取为顶层工具：设置文件到 input（浏览器原生 setter，兼容 Vue） */
  function setFileToInput(input, file) {
    const dt = new DataTransfer()
    dt.items.add(file)
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files').set
    if (nativeSetter) {
      nativeSetter.call(input, dt.files)
    } else {
      input.files = dt.files
    }
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  }

  /** 在指定 scope 内按直接文本节点查找可点击元素 */
  function findButtonInScope(text, scope) {
    const all = scope.querySelectorAll('*')
    let bestMatch = null
    for (const el of all) {
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent)
        .join('')
        .trim()
      if (directText === text) {
        if (!bestMatch || el.childNodes.length < bestMatch.childNodes.length) {
          bestMatch = el
        }
      }
    }
    return bestMatch ? toClickable(bestMatch) : null
  }

  /** 已知封面弹窗 CSS 选择器（向后兼容旧版 B站 UI） */
  const COVER_DIALOG_SELECTOR =
    '.el-dialog__wrapper:not([style*="display: none"]), ' +
    '.el-dialog:not([style*="display: none"]), ' +
    '[class*="coverMaker"]:not([style*="display: none"]), ' +
    '[class*="cover-maker"]:not([style*="display: none"]), ' +
    '[class*="coverDialog"]:not([style*="display: none"]), ' +
    '[class*="cover-dialog"]:not([style*="display: none"]), ' +
    '[class*="cover-modal"]:not([style*="display: none"])'

  /**
   * 通过内容特征检测封面弹窗（不依赖特定 class 名，兼容 B站 UI 改版）。
   * 策略：
   *   1. 先尝试已知 CSS 选择器
   *   2. 若失败，查找含封面上传特征（image file input / "上传封面" / "拖拽图片"）的弹窗容器
   * @returns {Element|null}
   */
  function findCoverDialog() {
    // 1. 已知选择器（兼容旧版）
    const known = document.querySelector(COVER_DIALOG_SELECTOR)
    if (known) return known

    // 2. 内容特征检测：找到封面相关的 file input 或上传提示文本，向上追溯弹窗容器
    const candidates = []

    // 2a. 通过 image file input 定位
    const imgInputs = document.querySelectorAll('input[type="file"][accept*="image"], input[type="file"][accept*="jpg"], input[type="file"][accept*="png"]')
    for (const inp of imgInputs) {
      if (inp.offsetParent !== null || inp.closest('[style*="display: none"]') === null) {
        candidates.push(inp)
      }
    }

    // 2b. 通过文本特征定位（"上传封面"、"拖拽图片"、"更换封面"、"裁剪"、"封面裁剪"）
    if (candidates.length === 0) {
      const allEls = document.querySelectorAll('div, section, aside')
      for (const el of allEls) {
        const text = el.textContent || ''
        if (text.length < 500 && (
          text.includes('上传封面') || text.includes('拖拽图片') || text.includes('更换封面') ||
          text.includes('封面制作') || text.includes('封面编辑') ||
          text.includes('封面裁剪') || text.includes('裁剪封面') ||
          (text.includes('封面') && text.includes('裁剪'))
        )) {
          candidates.push(el)
        }
      }
    }

    // 2c. 通过 canvas 元素定位（B站新版封面裁剪用 canvas 预览）
    if (candidates.length === 0) {
      const canvases = document.querySelectorAll('canvas')
      for (const cvs of canvases) {
        const style = window.getComputedStyle(cvs)
        if (style.display !== 'none' && cvs.width > 100 && cvs.height > 100) {
          candidates.push(cvs)
        }
      }
    }

    // 从候选元素向上查找弹窗/遮罩容器
    for (const el of candidates) {
      let node = el
      while (node && node !== document.body) {
        const style = window.getComputedStyle(node)
        const cls = (node.className || '').toString().toLowerCase()
        const zIndex = parseInt(style.zIndex) || 0
        const isOverlay = (
          style.position === 'fixed' || style.position === 'absolute' ||
          cls.includes('dialog') || cls.includes('modal') || cls.includes('overlay') ||
          cls.includes('popup') || cls.includes('drawer') || cls.includes('mask') ||
          cls.includes('crop') || cls.includes('cover') ||
          node.getAttribute('role') === 'dialog' || node.getAttribute('role') === 'alertdialog' ||
          zIndex > 50
        )
        if (isOverlay && style.display !== 'none' && style.visibility !== 'hidden') {
          return node
        }
        node = node.parentElement
      }
    }

    // 3. 兜底：查找任何 fixed/absolute 遮罩层（z-index > 50）内含封面相关内容
    const allContainers = document.querySelectorAll('div, section, aside, article')
    for (const ov of allContainers) {
      const style = window.getComputedStyle(ov)
      if (style.position !== 'fixed' && style.position !== 'absolute') continue
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const zIndex = parseInt(style.zIndex) || 0
      if (zIndex < 50) continue
      const text = ov.textContent || ''
      if (text.includes('封面') || text.includes('裁剪') || ov.querySelector('input[type="file"], canvas, img[src^="blob:"]')) {
        return ov
      }
    }

    return null
  }

  /**
   * 等待封面上传完成。
   * 使用 findCoverDialog() 动态定位弹窗，避免 Vue 重渲染导致引用失效。
   * @param {number} timeout
   * @returns {Promise<boolean>}
   */
  function waitForCoverUploaded(timeout = 15000) {
    const getRoot = () => findCoverDialog() || document
    const isDone = () => {
      const root = getRoot()
      // 仍有"上传中"提示则未完成
      const uploading = Array.from(root.querySelectorAll('*')).some(el => {
        const t = (el.textContent || '')
        return t.length < 30 && (t.includes('上传中') || /上传\s*\d+%/.test(t))
      })
      if (uploading) return false
      // 出现已加载完成的预览图即视为封面已就绪
      // 优先识别本地预览（blob:/data:）：这是我们注入截帧文件后生成的封面预览，
      // 新版「封面制作」编辑器的「智能生成封面」AI 推荐缩略图为 http 图，
      // 若把 http 也当作成功信号会误判，故本地预览优先、http 仅作兜底
      const imgs = root.querySelectorAll('img')
      for (const img of imgs) {
        const src = img.getAttribute('src') || ''
        if (/^(blob:|data:)/.test(src) && img.complete && img.naturalWidth > 50 && img.naturalHeight > 50) return true
      }
      // 兜底：服务端回显的 http 图（部分旧版 UI 上传后无 blob 预览）
      for (const img of imgs) {
        const src = img.getAttribute('src') || ''
        if (/^https?:/.test(src) && img.complete && img.naturalWidth > 50 && img.naturalHeight > 50) return true
      }
      return false
    }
    if (isDone()) return Promise.resolve(true)
    return new Promise((resolve) => {
      // 监听 document.body（稳定节点），而非可能被 Vue patch 替换的弹窗元素
      const obs = new MutationObserver(() => {
        if (isDone()) { obs.disconnect(); resolve(true) }
      })
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class', 'style'] })
      setTimeout(() => { obs.disconnect(); resolve(false) }, timeout)
    })
  }

  /** 点击「完成」按钮并等待封面弹窗关闭 */
  async function confirmCoverDialog(onLog) {
    // 在当前 DOM 中找到封面弹窗（限缩小查找范围）
    const dialog = findCoverDialog()
    const scope = dialog || document

    // 等待确认按钮出现（取代固定 1.5s，避免弹窗刚开时按钮尚未渲染）
    // 新版「封面制作」编辑器的确认按钮文案可能不同，故按候选列表依次匹配
    const confirmLabels = ['完成', '确定', '应用', '保存']
    const findConfirm = (root) => {
      for (const lbl of confirmLabels) {
        const b = findButtonInScope(lbl, root)
        if (b) return b
      }
      return null
    }
    const doneBtn = await waitFor(() => findConfirm(scope), 6000)
    if (doneBtn) {
      // 等待按钮变为可用（B站在上传/裁剪未完成时会 disable 按钮）
      const isBtnEnabled = (btn) => {
        if (btn.disabled) return false
        if (btn.getAttribute('aria-disabled') === 'true') return false
        if (btn.classList.contains('is-disabled') || btn.classList.contains('disabled')) return false
        // 检查父级（有时 disabled 状态挂在父容器上）
        const parent = btn.closest('[class*="disabled"]')
        if (parent && parent.contains(btn)) return false
        return true
      }
      const enabled = await waitFor(() => isBtnEnabled(doneBtn) ? doneBtn : null, 10000)
      if (!enabled) {
        onLog('警告: 「完成」按钮 10s 后仍为禁用状态，强制点击')
      }
      // 使用 dispatchEvent（B站是 Vue 页面，click() 可能不触发 Vue 绑定）
      const rect = doneBtn.getBoundingClientRect()
      doneBtn.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      }))
      onLog('封面设置完成')

      // 验证弹窗是否真的关闭了（最多等 5 秒）
      // B站可能通过移除 DOM、display:none、visibility:hidden 等方式关闭弹窗
      const isDialogGone = (el) => {
        if (!el || !document.body.contains(el)) return true
        const style = el.style
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true
        const computed = window.getComputedStyle(el)
        if (computed.display === 'none' || computed.visibility === 'hidden') return true
        return false
      }
      if (dialog) {
        await new Promise((resolve) => {
          let tries = 0
          const check = () => {
            tries++
            if (isDialogGone(dialog) || tries > 20) resolve()
            else setTimeout(check, 250)
          }
          check()
        })
        if (!isDialogGone(dialog)) {
          onLog('警告: 封面弹窗似乎未关闭，将重试...')
          await sleep(500)
          // 重试：动态查询当前弹窗（Vue 可能已替换节点）
          const currentDialog = findCoverDialog() || dialog
          const retryBtn = findConfirm(currentDialog)
          if (retryBtn) {
            const r = retryBtn.getBoundingClientRect()
            retryBtn.dispatchEvent(new MouseEvent('click', {
              bubbles: true, cancelable: true, view: window,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
            }))
            await sleep(1000)
          }
        }
      }
    } else {
      onLog('提示: 未找到完成按钮')
      // 备用方案：全页面查找
      const fallback = findButtonByText('完成')
      if (fallback) { fallback.click(); onLog('（备用方案）封面设置完成') }
    }
    await sleep(500)
  }

  /**
   * Step 6: 设置封面（所有视频统一走「视频截帧」封面）
   */
  async function stepSetCover(file, onLog) {
    onLog('设置封面...')

    // ---- 1. 找到封面上传入口按钮 ----
    // 新版 B站投稿页入口按钮文案多次变化：封面设置 → 添加主封面 → 添加封面，
    // 这里按顺序尝试多种候选文案，兼容不同版本的 UI（最新文案置前）
    const coverEntryLabels = ['添加封面', '添加主封面', '封面设置', '更换封面', '选择封面', '上传封面']
    let coverBtn = null
    for (const label of coverEntryLabels) {
      coverBtn = findButtonByText(label)
      if (coverBtn) { onLog(`找到封面入口按钮: 「${label}」`); break }
    }
    if (!coverBtn) {
      onLog('尝试通过页面结构定位封面区域...')
      for (const el of document.querySelectorAll('*')) {
        const directText = Array.from(el.childNodes)
          .filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
        if (directText !== '封面' && directText !== '* 封面' && directText !== '添加主封面' && directText !== '添加封面') continue
        const parent = el.closest('.el-form-item') || el.parentElement
        if (!parent) break
        coverBtn = parent.querySelector('[style*="cursor: pointer"], [class*="cover"], [class*="btn"]')
        if (coverBtn) break
        for (const item of parent.querySelectorAll('*')) {
          if (item.textContent.includes('封面') || item.textContent.includes('添加主封面') || item.textContent.includes('添加封面')) { coverBtn = item; break }
        }
        break
      }
    }

    if (!coverBtn) {
      onLog('提示: 未找到封面入口按钮，跳过'); await sleep(500); return
    }

    // ---- 2. 点击打开弹窗 ----
    const rect = coverBtn.getBoundingClientRect()
    coverBtn.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, view: window,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
    }))
    onLog('已点击封面入口，等待弹窗...')

    // ---- 3. 等待弹窗出现（使用内容特征检测，兼容 B站 UI 改版）----
    // B站需先获取视频元数据再显示裁剪界面，网络慢时可能需要较长时间
    const waitForDialog = (timeout) => new Promise((resolve) => {
      const check = () => findCoverDialog()
      const existing = check()
      if (existing) return resolve(existing)
      const obs = new MutationObserver(() => { const d = check(); if (d) { obs.disconnect(); resolve(d) } })
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] })
      setTimeout(() => { obs.disconnect(); resolve(null) }, timeout)
    })

    let dialog = await waitForDialog(15000)

    if (!dialog) {
      // 重试：再点一次封面按钮并等待
      onLog('封面弹窗未出现，重试(2/3)...')
      coverBtn.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, view: window,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
      }))
      dialog = await waitForDialog(12000)
    }

    if (!dialog) {
      // 第三次重试：B站可能因 getMeta 超时而延迟显示
      onLog('封面弹窗仍未出现，重试(3/3)...')
      coverBtn.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, view: window,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
      }))
      dialog = await waitForDialog(10000)
    }

    if (!dialog) {
      onLog('警告: 封面弹窗三次尝试后仍未出现，跳过封面'); await sleep(500); return
    }
    onLog('封面弹窗已打开')

    // ---- 4. 截帧 ----
    let frameBlob
    try {
      frameBlob = await captureFrameFromFile(file)
      onLog('视频截帧成功')
    } catch (err) {
      onLog(`提示: 截帧失败(${err.message})，请手动选择封面`)
      await confirmCoverDialog(onLog)
      return
    }

    const coverFile = new File([frameBlob], 'cover.jpg', { type: 'image/jpeg' })
    onLog(`封面文件: ${coverFile.name}, ${(coverFile.size / 1024).toFixed(0)}KB`)

    // ---- 5. 找到封面 file input 并注入截帧文件 ----
    // 新版「封面制作」编辑器中，「上传封面」是一个按钮（点击触发隐藏的 input[type=file]），
    // 不再保证存在「拖拽图片」文案且与按钮同元素，故这里直接定位隐藏的 image file input。
    // 若按 accept 过滤找不到，则在封面弹窗作用域内兜底匹配任意 file input
    // （弹窗范围内只会存在封面图 input，主视频上传 input 在弹窗之外，不会误匹配）。
    const findCoverInput = () => {
      const allInputs = document.querySelectorAll('input[type="file"]')
      const byAccept = Array.from(allInputs).find(inp =>
        (inp.getAttribute('accept') || '').toLowerCase().includes('image'))
      if (byAccept) return byAccept
      const root = findCoverDialog() || document
      const inDialog = Array.from(root.querySelectorAll('input[type="file"]'))
      return inDialog.length ? inDialog[0] : null
    }

    const coverInput = await waitFor(findCoverInput, 8000)
    if (!coverInput) {
      onLog('提示: 未找到封面 input，请手动上传')
      await confirmCoverDialog(onLog)
      return
    }

    onLog(`找到封面 input: accept="${coverInput.getAttribute('accept') || '(无 accept)'}"`)
    setFileToInput(coverInput, coverFile)
    onLog('已设置封面文件，等待上传完成...')

    // ---- 6. 真正等待封面上传完成（动态查询弹窗，避免 Vue 重渲染导致引用失效）----
    const uploaded = await waitForCoverUploaded(15000)
    if (uploaded) {
      onLog('封面上传完成，预览图已显示')
    } else {
      // 超时兜底：再宽限一次，仍未完成则提示但继续（避免整批卡死）
      onLog('警告: 15s 内未确认封面上传完成，再宽限 5s...')
      await sleep(5000)
      const currentDialog = findCoverDialog() || document
      const hasPreview = currentDialog.querySelector('img[src^="blob:"], img[src^="http"], img[src^="data:"]')
      onLog(hasPreview ? '检测到封面预览' : '警告: 仍未检测到封面预览，可能上传较慢')
    }

    await confirmCoverDialog(onLog)
  }

  /**
   * Step 7: 点击「立即投稿」（加固版）
   * 原实现只点一次、不检查按钮是否可用：disabled 按钮点击无效却日志报成功（假成功）。
   * 现在：等按钮出现且可用 → 点击 → 验证生效（按钮禁用/出现提交反馈），未生效则重试一次。
   */
  async function stepSubmit(onLog) {
    onLog('准备提交稿件...')

    const MAX_WAIT = 30000
    const isDisabled = (btn) => {
      if (btn.disabled) return true
      if (btn.getAttribute('aria-disabled') === 'true') return true
      const cls = btn.className || ''
      return typeof cls === 'string' && /disabled/.test(cls)
    }

    // 1. 等「立即投稿」按钮出现且可用（不 disabled）
    const submitBtn = await waitFor(() => {
      const btn = findButtonByText('立即投稿')
      if (!btn || isDisabled(btn)) return null
      return btn
    }, MAX_WAIT, 1000)

    if (!submitBtn) {
      const exists = findButtonByText('立即投稿')
      if (exists) {
        onLog(`警告: 「立即投稿」按钮 ${MAX_WAIT / 1000}s 内始终禁用，可能上传/封面未完成，请手动检查`)
      } else {
        onLog('警告: 未找到「立即投稿」按钮，请手动提交')
      }
      return
    }

    // 2. 点击
    submitBtn.click()
    onLog('已点击「立即投稿」')

    // 3. 验证生效：按钮进入禁用状态，或连续 3 次（约 1.5s）都找不到按钮（避免渲染间隙误判）才算提交成功；未生效则重试一次
    let disappearCount = 0
    const confirmed = await waitFor(() => {
      const btn = findButtonByText('立即投稿')
      if (btn) {
        disappearCount = 0
        return isDisabled(btn) ? true : null
      }
      disappearCount++
      return disappearCount >= 3 ? true : null
    }, 5000, 500)

    if (confirmed) {
      onLog('投稿已提交')
      return
    }

    // 若已出现确认弹窗（部分场景点「立即投稿」后有二次确认），交给用户手动确认，避免程序化重复点击
    const msgBox = document.querySelector('.el-message-box')
    if (msgBox) {
      onLog('检测到确认弹窗，请手动确认投稿')
      return
    }
    onLog('警告: 未确认投稿生效，重试点击...')
    const retryBtn = findButtonByText('立即投稿')
    if (retryBtn && !isDisabled(retryBtn)) {
      retryBtn.click()
      onLog('已重试点击「立即投稿」')
    } else {
      onLog('警告: 按钮状态异常，请手动确认投稿状态')
    }
  }

  // ============ 主流程 ============

  /**
   * 上传并自动投稿一个视频
   */
  async function uploadAndSubmit(file, onLog, targetText) {
    const title = parseTitle(file.name)
    onLog(`视频: ${file.name}`)
    onLog(`解析标题: ${title}`)
    onLog('')

    // Step 1: 上传文件
    await runStep('stepUploadFile', stepUploadFile, file, onLog)

    // Step 2: 等待表单加载
    await runStep('stepWaitForForm', stepWaitForForm, onLog)

    // Step 3: 填写标题
    await runStep('stepSetTitle', stepSetTitle, title, onLog)

    // Step 4: 设置创作声明
    await runStep('stepSetDeclaration', stepSetDeclaration, onLog)

    // Step 5: 设置可见范围
    await runStep('stepSetVisibility', stepSetVisibility, onLog, targetText)

    // Step 6: 设置封面（截取视频帧作为自定义封面）
    await runStep('stepSetCover', stepSetCover, file, onLog)

    // Step 7: 提交
    await runStep('stepSubmit', stepSubmit, onLog)

    onLog('')
    onLog(`《${title}》处理完成`)
    return { title, success: true }
  }

  /**
   * 批量上传：第一个视频正常上传，后续点击队列卡片进入编辑页面再上传
   */
  async function batchUpload(files, onLog, targetText) {
    onLog('提示: 投稿期间请保持本页面可见，最小化窗口会导致浏览器节流、提交可能卡住')
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      // 重置当前步骤标记：批次内非 runStep 错误（如找不到按钮）也能定位到具体第几个
      currentStep = { name: `batchUpload-第${i + 1}个`, source: '' }
      onLog(`===== 第 ${i + 1}/${files.length} 个视频 =====`)

      try {
        if (i === 0) {
          // 第一个视频：通过主文件输入框上传
          await uploadAndSubmit(file, onLog, targetText)
        } else {
          // 后续视频：通过"添加分P"按钮上传
          onLog('查找添加分P按钮...')
          await sleep(1000)

          // 找"添加分P"按钮
          const addPartBtn = findButtonByText('添加分P') || findButtonByText('+ 添加分P')
          if (!addPartBtn) {
            throw new Error('未找到添加分P按钮')
          }

          // 点击"添加分P"按钮
          addPartBtn.click()
          onLog('已点击添加分P，等待文件输入框...')
          await sleep(2000)

          // 直接找 bcc-upload-wrapper 里的视频 input
          const wrapperInputs = document.querySelectorAll('.bcc-upload-wrapper input[type="file"]')
          let fileInput = null
          for (const inp of wrapperInputs) {
            const accept = (inp.getAttribute('accept') || '').toLowerCase()
            if (accept.includes('.mp4') || accept.includes('.flv') || accept.includes('.mkv') ||
                accept.includes('.avi') || accept.includes('.mov') || accept.includes('.webm') ||
                accept.includes('video')) {
              fileInput = inp
              break
            }
          }

          if (!fileInput) {
            // fallback: 找第一个视频格式的 input
            const allInputs = document.querySelectorAll('input[type="file"]')
            for (const inp of allInputs) {
              const accept = (inp.getAttribute('accept') || '').toLowerCase()
              if (accept.includes('.mp4') || accept.includes('video')) {
                fileInput = inp
                break
              }
            }
          }

          if (!fileInput) {
            throw new Error('未找到视频文件输入框')
          }

          onLog(`找到视频输入框 (display=${window.getComputedStyle(fileInput).display})`)

          // 用原生 setter 设置文件（Vue 兼容）
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files').set
          const dt = new DataTransfer()
          dt.items.add(file)
          if (nativeSetter) {
            nativeSetter.call(fileInput, dt.files)
          } else {
            fileInput.files = dt.files
          }
          fileInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
          fileInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
          onLog('文件已设置，等待视频卡片出现...')

          // 等待视频卡片出现在队列中（MutationObserver 替代 setInterval 轮询）
          // 用去扩展名的完整文件名作为关键词（含日期）：区分度最高，同系列不同日期不会点错旧卡片
          const titleKeyword = file.name.replace(/\.mp4$/i, '')
          await waitForElementByText(titleKeyword, 60000)
          onLog('视频卡片已出现在队列中')
          await sleep(2000)

          // 点击视频卡片进入编辑页面
          onLog('点击视频卡片...')
          let bestEl = null, bestSize = Infinity
          for (const el of document.querySelectorAll('*')) {
            const text = el.textContent || ''
            if (text.includes(titleKeyword) && text.length < 200) {
              const rect = el.getBoundingClientRect()
              if (rect.width > 100 && rect.height > 30) {
                const size = rect.width * rect.height
                if (size < bestSize) { bestSize = size; bestEl = el }
              }
            }
          }
          if (!bestEl) throw new Error(`未能点击视频卡片: ${titleKeyword}`)

          const clickable = toClickable(bestEl)
          if (clickable && clickable !== bestEl) {
            onLog(`找到可点击父元素: ${clickable.tagName}`)
            const rect = clickable.getBoundingClientRect()
            clickable.dispatchEvent(new MouseEvent('click', {
              bubbles: true, cancelable: true, view: window,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2
            }))
          } else {
            bestEl.click()
          }
          onLog('已点击视频卡片')

          // 等待编辑页面加载
          onLog('等待编辑页面加载...')
          await waitForElement([
            'input[placeholder*="标题"]',
            'textarea[placeholder*="标题"]',
          ], 60000)
          await sleep(2000)
          onLog('已进入编辑页面')

          // 填表
          await runStep('stepWaitForForm', stepWaitForForm, onLog)
          // 注意：分P分支不填写标题——B站分P标题默认使用文件名（行为稳定），
          // 且此处页面上同时存在主标题框与分P标题框，显式填写容易覆盖主稿件标题
          await runStep('stepSetDeclaration', stepSetDeclaration, onLog)
          await runStep('stepSetVisibility', stepSetVisibility, onLog, targetText)
          await runStep('stepSetCover', stepSetCover, file, onLog)
          await runStep('stepSubmit', stepSubmit, onLog)

          onLog('')
          onLog(`第 ${i + 1} 个视频处理完成`)
        }
      } catch (err) {
        recordError(err, { 批次: `第 ${i + 1}/${files.length} 个`, 文件: file.name })
        onLog(`第 ${i + 1} 个视频失败: ${err.message}`)
      }
    }
    onLog('===== 全部处理完成 =====')
  }

  // ============ 注入面板 UI ============

  function createPanel() {
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
    const savedVisibility = localStorage.getItem('bili_helper_visibility')
    if (savedVisibility) {
      const select = document.getElementById('bili-helper-visibility')
      select.value = savedVisibility
    }
    // 每次修改时保存
    document.getElementById('bili-helper-visibility').addEventListener('change', (e) => {
      localStorage.setItem('bili_helper_visibility', e.target.value)
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
        reports = JSON.parse(localStorage.getItem('bili_helper_error_reports') || '[]')
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

      isUploading = true
      try {
        const visText = document.getElementById('bili-helper-visibility').value
        await batchUpload(files, onLog, visText)
        startBtn.textContent = '全部完成'
      } catch (err) {
        recordError(err)
        onLog(`错误: ${err.message}`)
        startBtn.textContent = '出错，请重试'
      } finally {
        isUploading = false
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

  // 启动
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

        isUploading = true
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
          isUploading = false
        }
      }, 3000)
    }
  }
})()
