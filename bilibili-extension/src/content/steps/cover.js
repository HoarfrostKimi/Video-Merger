// steps/cover.js - Step 6: 视频截帧 + 封面上传与确认（逻辑最重的一步）
import { sleep, waitFor } from '../core/wait.js'
import { findButtonByText, findButtonInScope, findCoverDialog } from '../core/find.js'
import { BUTTON_LABELS, TIMEOUTS } from '../config.js'

/**
 * 从视频文件中截取一帧作为封面图片
 */
export async function captureFrameFromFile(file) {
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

    // 截帧超时
    setTimeout(() => {
      URL.revokeObjectURL(video.src)
      reject(new Error('截帧超时'))
    }, TIMEOUTS.frameCapture)
  })
}

/** 设置文件到 input（浏览器原生 setter，兼容 Vue） */
export function setFileToInput(input, file) {
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

/**
 * 等待封面上传完成。
 * 使用 findCoverDialog() 动态定位弹窗，避免 Vue 重渲染导致引用失效。
 * @param {number} timeout
 * @returns {Promise<boolean>}
 */
export function waitForCoverUploaded(timeout = TIMEOUTS.coverUploaded) {
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
export async function confirmCoverDialog(onLog) {
  // 在当前 DOM 中找到封面弹窗（限缩小查找范围）
  const dialog = findCoverDialog()
  const scope = dialog || document

  // 等待确认按钮出现（取代固定 1.5s，避免弹窗刚开时按钮尚未渲染）
  // 新版「封面制作」编辑器的确认按钮文案可能不同，故按候选列表依次匹配
  const findConfirm = (root) => {
    for (const lbl of BUTTON_LABELS.coverConfirm) {
      const b = findButtonInScope(lbl, root)
      if (b) return b
    }
    return null
  }
  const doneBtn = await waitFor(() => findConfirm(scope), TIMEOUTS.coverConfirmBtn)
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
    const enabled = await waitFor(() => isBtnEnabled(doneBtn) ? doneBtn : null, TIMEOUTS.coverConfirmEnabled)
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
          if (isDialogGone(dialog) || tries > TIMEOUTS.dialogGoneMaxTries) resolve()
          else setTimeout(check, TIMEOUTS.dialogGoneInterval)
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
    const fallback = findButtonByText(BUTTON_LABELS.coverConfirm[0])
    if (fallback) { fallback.click(); onLog('（备用方案）封面设置完成') }
  }
  await sleep(500)
}

/**
 * Step 6: 设置封面（所有视频统一走「视频截帧」封面）
 */
export async function stepSetCover(file, onLog) {
  onLog('设置封面...')

  // ---- 1. 找到封面上传入口按钮 ----
  // 新版 B站投稿页入口按钮文案多次变化：封面设置 → 添加主封面 → 添加封面，
  // 这里按顺序尝试多种候选文案，兼容不同版本的 UI（最新文案置前）
  let coverBtn = null
  for (const label of BUTTON_LABELS.coverEntry) {
    coverBtn = findButtonByText(label)
    if (coverBtn) { onLog(`找到封面入口按钮: 「${label}」`); break }
  }
  if (!coverBtn) {
    onLog('尝试通过页面结构定位封面区域...')
    for (const el of document.querySelectorAll('*')) {
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
      if (!BUTTON_LABELS.coverFallbackEntry.includes(directText)) continue
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

  let dialog = await waitForDialog(TIMEOUTS.coverDialogFirst)

  if (!dialog) {
    // 重试：再点一次封面按钮并等待
    onLog('封面弹窗未出现，重试(2/3)...')
    coverBtn.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, view: window,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
    }))
    dialog = await waitForDialog(TIMEOUTS.coverDialogRetry1)
  }

  if (!dialog) {
    // 第三次重试：B站可能因 getMeta 超时而延迟显示
    onLog('封面弹窗仍未出现，重试(3/3)...')
    coverBtn.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, view: window,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
    }))
    dialog = await waitForDialog(TIMEOUTS.coverDialogRetry2)
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
  const uploaded = await waitForCoverUploaded()
  if (uploaded) {
    onLog('封面上传完成，预览图已显示')
  } else {
    // 超时兜底：再宽限一次，仍未完成则提示但继续（避免整批卡死）
    onLog(`警告: ${TIMEOUTS.coverUploaded / 1000}s 内未确认封面上传完成，再宽限 ${TIMEOUTS.coverGrace / 1000}s...`)
    await sleep(TIMEOUTS.coverGrace)
    const currentDialog = findCoverDialog() || document
    const hasPreview = currentDialog.querySelector('img[src^="blob:"], img[src^="http"], img[src^="data:"]')
    onLog(hasPreview ? '检测到封面预览' : '警告: 仍未检测到封面预览，可能上传较慢')
  }

  await confirmCoverDialog(onLog)
}
