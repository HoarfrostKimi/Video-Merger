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

  /** 从文件名解析标题 */
  function parseTitle(fileName) {
    const name = fileName.replace(/\.mp4$/i, '')
    const match = name.match(/^(?:\d{4}[-_]\d{2}[-_]\d{2})\s*[_\s]\s*(.+?)(?:\s*_?\s*\d{4}[-_]\d{2}[-_]\d{2}|$)/)
    if (match && match[1]) {
      return match[1].replace(/[_合并版]+$/g, '').trim() || name
    }
    return name
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

  /** 查找B站上传页面的文件输入框 */
  function findFileInput() {
    const selectors = [
      'input[type="file"][accept*="video"]',
      'input[type="file"][accept*="mp4"]',
      'input[type="file"][accept*="video/"]',
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
    if (bestMatch) return toClickable(bestMatch)

    // 第二轮：找 textContent 精确匹配的最小元素
    let smallest = null
    for (const el of all) {
      if (el.textContent.trim() === text) {
        if (!smallest || el.childElementCount < smallest.childElementCount) {
          smallest = el
        }
      }
    }
    if (smallest) return toClickable(smallest)
    return null
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
   * Step 3: 设置创作声明为「内容无需标注」
   */
  async function stepSetDeclaration(onLog) {
    onLog('设置创作声明...')

    // 找到包含"创作声明"标签的表单行中的 select 组件
    const labels = document.querySelectorAll('span, label, div')
    let targetSelect = null
    for (const label of labels) {
      if (label.textContent.trim() === '创作声明') {
        const parent = label.closest('.el-form-item, tr, [class*="row"], [class*="item"]') || label.parentElement
        targetSelect = parent?.querySelector('.el-select, select, [class*="select"]')
        break
      }
    }

    if (targetSelect) {
      // 点击打开下拉框
      const selectTrigger = targetSelect.querySelector('.el-select__wrapper, .el-input__inner, .el-select')
      if (selectTrigger) {
        selectTrigger.click()
        await sleep(500)

        // 在下拉选项中查找「内容无需标注」
        const found = clickDropdownOption('内容无需标注')
        if (found) {
          onLog('创作声明已设置为「内容无需标注」')
        } else {
          onLog('提示: 未找到「内容无需标注」选项，可能已默认选中')
        }
      }
    } else {
      // 备用方案：直接查找页面上所有 el-select，找到包含创作声明的那个
      onLog('提示: 未精确定位创作声明，尝试备用方案...')
      const allSelects = document.querySelectorAll('.el-select')
      for (const sel of allSelects) {
        const wrapper = sel.closest('.el-form-item')
        if (wrapper && wrapper.textContent.includes('创作声明')) {
          const trigger = sel.querySelector('.el-select__wrapper, .el-input__inner')
          if (trigger) {
            trigger.click()
            await sleep(500)
            clickDropdownOption('内容无需标注')
            onLog('创作声明已设置（备用方案）')
            return
          }
        }
      }
      onLog('提示: 创作声明可能已默认为「内容无需标注」，跳过')
    }
  }

  /**
   * Step 4: 设置可见范围
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

  /**
   * Step 5: 设置封面
   * @param {boolean} skipUpload - 第一个视频跳过截帧上传，直接点完成（B站自动推荐封面）
   */
  async function stepSetCover(file, onLog, skipUpload) {
    onLog('设置封面...')

    // 方式1: 通过文本查找「封面设置」按钮
    let coverBtn = findButtonByText('封面设置')

    // 方式2: 通过页面结构定位
    if (!coverBtn) {
      onLog('尝试通过页面结构定位封面区域...')
      const allEls = document.querySelectorAll('*')
      for (const el of allEls) {
        const directText = Array.from(el.childNodes)
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent)
          .join('')
          .trim()
        if (directText === '封面' || directText === '* 封面') {
          const parent = el.closest('.el-form-item') || el.parentElement
          if (parent) {
            const clickable = parent.querySelector('[style*="cursor: pointer"], [class*="cover"], [class*="btn"]')
            if (clickable) { coverBtn = clickable; break }
            const items = parent.querySelectorAll('*')
            for (const item of items) {
              if (item.textContent.includes('封面设置')) { coverBtn = item; break }
            }
          }
          break
        }
      }
    }

    if (!coverBtn) {
      onLog('提示: 未找到封面设置按钮，跳过')
      await sleep(500)
      return
    }

    // 点击封面按钮打开弹窗
    const rect = coverBtn.getBoundingClientRect()
    coverBtn.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    }))
    onLog('已点击封面设置，等待弹窗...')

    // 等待弹窗出现
    const dialog = await new Promise((resolve) => {
      const check = () => {
        return document.querySelector(
          '.el-dialog__wrapper, .el-dialog, ' +
          '[class*="dialog"]:not([style*="display: none"]), ' +
          '[class*="modal"]:not([style*="display: none"]), ' +
          '[class*="coverMaker"], [class*="cover-maker"], [class*="coverDialog"]'
        )
      }
      const existing = check()
      if (existing) return resolve(existing)
      const obs = new MutationObserver(() => {
        const d = check()
        if (d) { obs.disconnect(); resolve(d) }
      })
      obs.observe(document.body, { childList: true, subtree: true })
      setTimeout(() => { obs.disconnect(); resolve(null) }, 10000)
    })

    if (!dialog) {
      onLog('提示: 封面弹窗未出现，跳过')
      await sleep(500)
      return
    }
    onLog('封面弹窗已打开')

    if (skipUpload) {
      // 第一个视频：B站自动推荐封面，直接点完成
      onLog('第一个视频，使用系统推荐封面，直接完成')
      await sleep(1500)
      const doneBtn = findButtonByText('完成')
      if (doneBtn) { doneBtn.click(); onLog('封面设置完成') }
      else onLog('提示: 未找到完成按钮')
      await sleep(500)
      return
    }

    // 截帧（第二个及以后的视频才需要）
    let frameBlob
    try {
      frameBlob = await captureFrameFromFile(file)
      onLog('视频截帧成功')
    } catch (err) {
      onLog(`提示: 截帧失败(${err.message})，请手动选择封面`)
      await sleep(1500)
      const doneBtn = findButtonByText('完成')
      if (doneBtn) doneBtn.click()
      return
    }

    const coverFile = new File([frameBlob], 'cover.jpg', { type: 'image/jpeg' })
    onLog(`封面文件: ${coverFile.name}, ${(coverFile.size / 1024).toFixed(0)}KB`)

    // 设置文件到输入框（使用浏览器原生 setter）
    function setFileToInput(input, file) {
      const dt = new DataTransfer()
      dt.items.add(file)
      // 使用 HTMLInputElement 原生的 files setter，绕过任何自定义属性定义
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files').set
      if (nativeSetter) {
        nativeSetter.call(input, dt.files)
      } else {
        input.files = dt.files
      }
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
    }

    // 递归查找所有文件输入框（包括 shadow DOM 内）
    function findAllFileInputs(root) {
      const inputs = []
      // 查找当前层的 input[type="file"]
      const directInputs = root.querySelectorAll ? root.querySelectorAll('input[type="file"]') : []
      directInputs.forEach(inp => inputs.push(inp))
      // 递归查找 shadow DOM
      root.querySelectorAll ? root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) {
          inputs.push(...findAllFileInputs(el.shadowRoot))
        }
      }) : null
      return inputs
    }

    // 找底部「上传封面」区域并点击
    await sleep(2000)

    // 找同时包含"上传封面"和"拖拽图片"的元素（底部那个区域）
    const uploadArea = Array.from(document.querySelectorAll('*')).find(el => {
      const text = el.textContent
      return text.includes('上传封面') && text.includes('拖拽图片') && el.children.length <= 5
    })

    if (uploadArea) {
      onLog('找到上传封面区域')
    }

    if (!uploadArea) {
      onLog('提示: 未找到上传区域，请手动上传')
      await sleep(1500)
      const doneBtn = findButtonByText('完成')
      if (doneBtn) doneBtn.click()
      return
    }

    // 在整个页面查找 accept 包含 image 的 file input（封面专用 input）
    // 从 DOM 分析得知：封面 input 的 accept="image/png, image/jpeg"，display:none
    // 它位于 cover-editor-panel > bcc-upload cover-upload > bcc-upload-wrapper > input
    const allInputs = document.querySelectorAll('input[type="file"]')
    const coverInput = Array.from(allInputs).find(inp => {
      const accept = (inp.getAttribute('accept') || '').toLowerCase()
      return accept.includes('image')
    })

    if (!coverInput) {
      onLog('提示: 未找到封面 input (accept 含 image)，请手动上传')
      await sleep(1500)
      const doneBtn = findButtonByText('完成')
      if (doneBtn) doneBtn.click()
      return
    }

    onLog(`找到封面 input: accept="${coverInput.getAttribute('accept')}"`)

    // 直接设置文件到封面 input
    setFileToInput(coverInput, coverFile)
    onLog('已设置封面文件')

    // 等待 Vue 组件处理文件并上传
    await sleep(5000)

    const hasPreview = document.querySelector('img[src*="blob:"], img[src*="http"], canvas, img[src*="data:"]')
    if (hasPreview) {
      onLog('封面上传成功，预览图已显示')
    } else {
      onLog('警告: 未检测到封面预览')
    }

    await sleep(1500)

    const doneBtn = findButtonByText('完成')
    if (doneBtn) { doneBtn.click(); onLog('封面设置完成') }
    else onLog('提示: 未找到完成按钮')
    await sleep(500)
  }

  /**
   * Step 6: 点击「立即投稿」
   */
  async function stepSubmit(onLog) {
    onLog('准备提交稿件...')
    await sleep(1000)

    const submitBtn = findButtonByText('立即投稿')
    if (submitBtn) {
      submitBtn.click()
      onLog('已点击「立即投稿」！')
    } else {
      onLog('警告: 未找到「立即投稿」按钮，请手动提交')
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
    await stepUploadFile(file, onLog)

    // Step 2: 等待表单加载
    await stepWaitForForm(onLog)

    // Step 3: 设置创作声明
    await stepSetDeclaration(onLog)

    // Step 4: 设置可见范围
    await stepSetVisibility(onLog, targetText)

    // Step 5: 设置封面（第一个视频跳过截帧，B站自动推荐）
    await stepSetCover(file, onLog, true)

    // Step 6: 提交
    await stepSubmit(onLog)

    onLog('')
    onLog(`《${title}》处理完成`)
    return { title, success: true }
  }

  /**
   * 通过"添加分P"按钮上传文件（用于多P投稿）
   */
  async function uploadViaAddPart(file, onLog) {
    onLog('正在添加分P...')

    // 找"添加分P"按钮并点击
    const addPartBtn = findButtonByText('添加分P') || findButtonByText('+ 添加分P')
    if (addPartBtn) {
      addPartBtn.click()
      onLog('已点击添加分P，等待文件输入框...')
      await sleep(2000)
    }

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
    onLog('分P文件已选择，等待上传...')
  }

  /**
   * 点击队列中下一个待处理的视频卡片，进入其编辑页面
   */
  async function clickNextVideoInQueue(onLog) {
    onLog('正在查找队列中的下一个视频...')

    // 轮询查找并点击（最多等3分钟）
    for (let attempt = 0; attempt < 60; attempt++) {
      // 尝试多种选择器找视频卡片
      const candidates = document.querySelectorAll(
        '[class*="upload-card"], [class*="video-card"], [class*="part-item"], ' +
        '[class*="list-item"], [class*="queue-item"], .el-card, [role="listitem"]'
      )

      for (const card of candidates) {
        const text = card.textContent || ''
        // 找包含视频状态但不是已完成的卡片
        if ((text.includes('上传中') || text.includes('等待上传') || text.includes('转码中')) &&
            !text.includes('已上传') && !text.includes('已完成')) {
          // 跳过当前正在编辑的卡片（蓝色高亮的）
          const style = window.getComputedStyle(card)
          if (style.backgroundColor.includes('255, 255, 255') || style.backgroundColor === 'rgba(0, 0, 0, 0)') {
            // 白色背景或透明 = 未选中，可以点击
            if (!document.querySelector('input[placeholder*="标题"], textarea[placeholder*="标题"]')) {
              onLog(`找到待处理卡片，点击进入编辑页面...`)
              card.click()
              return true
            }
          }
        }
      }

      // 备用：找所有包含日期格式的可点击元素
      if (!document.querySelector('input[placeholder*="标题"], textarea[placeholder*="标题"]')) {
        const allClickable = document.querySelectorAll('a, [role="button"], button, [class*="card"], [class*="item"]')
        for (const el of allClickable) {
          const text = el.textContent || ''
          if (/\d{4}-\d{2}-\d{2}/.test(text) && text.length < 100) {
            // 跳过当前选中的（蓝色背景）
            const style = window.getComputedStyle(el)
            const bg = style.backgroundColor
            // 如果背景不是白色/透明，说明是当前选中的，跳过
            if (bg && !bg.includes('255, 255, 255') && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
              continue
            }
            if (!document.querySelector('input[placeholder*="标题"]')) {
              onLog(`找到视频元素，点击...`)
              el.click()
              return true
            }
          }
        }
      }

      await sleep(3000)
    }

    return false
  }

  /**
   * 批量上传：第一个视频正常上传，后续点击队列卡片进入编辑页面再上传
   */
  async function batchUpload(files, onLog, targetText) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
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

          // 等待视频卡片出现在队列中
          const titleKeyword = parseTitle(file.name)
          await new Promise((resolve, reject) => {
            const check = () => {
              const allEls = document.querySelectorAll('*')
              for (const el of allEls) {
                const text = el.textContent || ''
                if (text.includes(titleKeyword) && text.length < 200) {
                  const rect = el.getBoundingClientRect()
                  if (rect.width > 100 && rect.height > 30) {
                    return true
                  }
                }
              }
              return false
            }
            if (check()) return resolve()
            const timer = setInterval(() => {
              if (check()) { clearInterval(timer); resolve() }
            }, 2000)
            setTimeout(() => { clearInterval(timer); reject(new Error('等待视频卡片出现超时')) }, 60000)
          })
          onLog('视频卡片已出现在队列中')
          await sleep(2000)

          // 点击视频卡片进入编辑页面
          onLog('点击视频卡片...')
          const allEls = document.querySelectorAll('*')
          let clickedCard = false
          let bestEl = null
          let bestSize = Infinity

          // 找最小的匹配元素（最精确的）
          for (const el of allEls) {
            const text = el.textContent || ''
            if (text.includes(titleKeyword) && text.length < 200) {
              const rect = el.getBoundingClientRect()
              if (rect.width > 100 && rect.height > 30) {
                const size = rect.width * rect.height
                if (size < bestSize) {
                  bestSize = size
                  bestEl = el
                }
              }
            }
          }

          if (bestEl) {
            // 用 toClickable 找到真正的可点击父元素
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
            clickedCard = true
            onLog('已点击视频卡片')
          }

          if (!clickedCard) {
            throw new Error(`未能点击视频卡片: ${titleKeyword}`)
          }

          // 等待编辑页面加载
          onLog('等待编辑页面加载...')
          await waitForElement([
            'input[placeholder*="标题"]',
            'textarea[placeholder*="标题"]',
          ], 60000)
          await sleep(2000)
          onLog('已进入编辑页面')

          // 填表
          await stepWaitForForm(onLog)
          await stepSetDeclaration(onLog)
          await stepSetVisibility(onLog, targetText)
          await stepSetCover(file, onLog)
          await stepSubmit(onLog)

          onLog('')
          onLog(`第 ${i + 1} 个视频处理完成`)
        }
      } catch (err) {
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

      // 开始上传按钮
      document.getElementById('bili-helper-start').addEventListener('click', async () => {
        const startBtn = document.getElementById('bili-helper-start')
        startBtn.disabled = true
        startBtn.textContent = '上传中...'

        const logDiv = document.getElementById('bili-helper-log')
        const logContent = document.getElementById('bili-helper-log-content')
        logDiv.style.display = 'block'
        logContent.textContent = ''

        const onLog = (msg) => {
          logContent.textContent += msg + '\n'
          logDiv.scrollTop = logDiv.scrollHeight
        }

        try {
          const visText = document.getElementById('bili-helper-visibility').value
          await batchUpload(files, onLog, visText)
          startBtn.textContent = '全部完成'
        } catch (err) {
          onLog(`错误: ${err.message}`)
          startBtn.textContent = '出错，请重试'
        }
        startBtn.disabled = false
      })
    })
  }

  // 启动
  createPanel()
  console.log('[B站投稿助手] 面板已注入')

  // 检测 URL 参数，自动开始上传（来自视频合并 app 的联动）
  const urlParams = new URLSearchParams(window.location.search)
  const autoFilesParam = urlParams.get('autoFiles')
  if (autoFilesParam) {
    const fileUrls = autoFilesParam.split(',').map((u) => decodeURIComponent(u.trim())).filter(Boolean)
    if (fileUrls.length > 0) {
      console.log('[B站投稿助手] 检测到自动上传参数，文件数:', fileUrls.length)

      // 提取本地服务器基础 URL（用于发送完成信号）
      const serverBaseUrl = fileUrls[0].split('?')[0]

      // 延迟执行，等页面完全加载
      setTimeout(async () => {
        const logDiv = document.getElementById('bili-helper-log')
        const logContent = document.getElementById('bili-helper-log-content')
        if (logDiv) logDiv.style.display = 'block'

        const onLog = (msg) => {
          if (logContent) {
            logContent.textContent += msg + '\n'
            if (logDiv) logDiv.scrollTop = logDiv.scrollHeight
          }
          console.log('[B站投稿助手]', msg)
        }

        onLog('收到视频合并app的自动上传指令...')

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
          onLog(`错误: ${err.message}`)
        }
      }, 3000)
    }
  }
})()
