// core/find.js - DOM 定位工具：按选择器/文本/内容特征查找可点击元素与弹窗
import { SELECTORS, TEXT_KEYWORDS } from '../config.js'

/** 文本归一化：去全部空白（B站按钮文案常带空格/换行，如「确 定」，需归一化后比较） */
export const normalizeText = (s) => (s || '').replace(/\s+/g, '')

/** 查找B站上传页面的文件输入框 */
export function findFileInput() {
  for (const sel of SELECTORS.fileInputSelectors) {
    const el = document.querySelector(sel)
    if (el) {
      console.log('[B站投稿助手] 找到 file input:', sel)
      return el
    }
  }
  return null
}

/** 通过文本内容查找可点击元素 */
/** 元素自身的直接文本（不含子元素文本） */
function directTextOf(el) {
  let s = ''
  for (const n of el.childNodes) {
    if (n.nodeType === 3) s += n.nodeValue
  }
  return s.trim()
}

/**
 * 按「直接文本」精确查找元素：只扫文本节点（TreeWalker），不做全页元素遍历。
 *
 * 性能要点（这里是投稿页最大的热点）：
 * 旧实现是 querySelectorAll('*') + 给每个元素建一次 childNodes 数组，投稿页上万节点
 * 一次要几十毫秒。而 findButtonByText 会被轮询高频调用（等「立即投稿」最长 30s、
 * 等封面「完成」十几秒），全页遍历等于持续抢占主线程，连 B站 自己的上传进度都会被拖慢。
 * TreeWalker 只读 nodeValue，代价与文本节点数成正比。
 *
 * @param {string} text 目标文案（比较前统一去空白）
 * @param {Element|Document} [root=document.body] 查找范围
 * @returns {Element|null} 匹配到的最小元素（未转可点击父元素）
 */
export function findExactTextElement(text, root) {
  const target = normalizeText(text)
  if (!target) return null
  const scope = root || document.body
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null)
  let bestMatch = null
  let node
  while ((node = walker.nextNode())) {
    const raw = node.nodeValue
    if (!raw || !raw.trim()) continue
    // 先做最便宜的原始包含判断；文本明显长于目标且不包含目标，直接跳过
    if (!raw.includes(target) && raw.trim().length > target.length + 8) continue
    const el = node.parentElement
    if (!el || (el.closest && el.closest('#bili-helper-panel'))) continue
    // 元素级拼接二次校验：兼容「确 定」被拆成多个文本节点的情况
    if (normalizeText(directTextOf(el)) !== target) continue
    if (!bestMatch || el.childNodes.length < bestMatch.childNodes.length) bestMatch = el
  }
  return bestMatch
}

/** 通过文本内容查找可点击元素 */
export function findButtonByText(text) {
  const el = findExactTextElement(text)
  return el ? toClickable(el) : null
}

/** 在指定 scope 内按直接文本节点查找可点击元素 */
export function findButtonInScope(text, scope) {
  const el = findExactTextElement(text, scope)
  return el ? toClickable(el) : null
}

/**
 * 按关键词找「像卡片/区块」的最内层可见元素（用于定位视频卡片、文件名条目等）。
 * 同样走 TreeWalker，避免 querySelectorAll('*') 全页遍历。
 * @param {string} keyword 关键词（原始包含匹配）
 * @param {object} [opts]
 * @param {number} [opts.maxTextLen=200] 候选元素文本长度上限（排除大容器）
 * @param {number} [opts.minWidth=100] 命中区域最小宽度
 * @param {number} [opts.minHeight=30] 命中区域最小高度
 * @param {number} [opts.maxCandidates=30] 最多考察多少个命中文本节点
 * @param {number} [opts.maxDepth=10] 从文本元素向上最多爬几层
 * @returns {Element|null} 面积最小的那层容器（最贴近"卡片内文字"）
 */
export function findCardByText(keyword, opts = {}) {
  const {
    maxTextLen = 200, minWidth = 100, minHeight = 30,
    maxCandidates = 30, maxDepth = 10,
  } = opts
  if (!keyword) return null
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
  const candidates = []
  let node
  let seen = 0
  while ((node = walker.nextNode()) && seen < maxCandidates) {
    const raw = node.nodeValue
    if (!raw || raw.indexOf(keyword) === -1) continue
    let el = node.parentElement
    if (!el || (el.closest && el.closest('#bili-helper-panel'))) continue
    seen++
    for (let depth = 0; el && el !== document.body && depth < maxDepth; depth++) {
      if ((el.textContent || '').length > maxTextLen) break // 已到外层大容器
      const rect = el.getBoundingClientRect()
      if (rect.width >= minWidth && rect.height >= minHeight) {
        candidates.push({ el, area: rect.width * rect.height })
        break
      }
      el = el.parentElement
    }
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => a.area - b.area)
  return candidates[0].el
}

/** 从文本元素向上找到可点击的父元素 */
export function toClickable(el) {
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

/** 模拟完整点击序列（pointerdown → pointerup → click），兼容只监听 pointer 事件的组件 */
export function dispatchClickSequence(el) {
  const rect = el.getBoundingClientRect()
  const opts = {
    bubbles: true,
    cancelable: true,
    view: window,
    composed: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  }
  try {
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
  } catch (e) {
    // 环境不支持 PointerEvent 时退回仅 click
  }
  el.dispatchEvent(new MouseEvent('click', opts))
}

/** 通过文本查找并点击下拉选项 */
/**
 * 派发完整的鼠标事件序列：pointerdown → mousedown → pointerup → mouseup → click。
 *
 * 为什么不能只 dispatchClickSequence：那个只发 pointer 事件 + click，
 * 而不少组件（含 B站自研下拉）监听的是 **mousedown**，PointerEvent 不会触发 mousedown 监听。
 * 现象就是「下拉打开了，点选项却没反应」——打开用的是 click（有效），选中用的是 mousedown（没收到）。
 *
 * 重复触发是安全的：下拉选项的选中是幂等的，收到两次选中也不会变成取消。
 */
export function dispatchFullClickSequence(el) {
  const rect = el.getBoundingClientRect()
  const opts = {
    bubbles: true,
    cancelable: true,
    view: window,
    composed: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  }
  const pointerOpts = { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  try { el.dispatchEvent(new PointerEvent('pointerdown', pointerOpts)) } catch (e) { /* 环境不支持 PointerEvent */ }
  el.dispatchEvent(new MouseEvent('mousedown', opts))
  try { el.dispatchEvent(new PointerEvent('pointerup', pointerOpts)) } catch (e) { /* 同上 */ }
  el.dispatchEvent(new MouseEvent('mouseup', opts))
  el.dispatchEvent(new MouseEvent('click', opts))
}

/**
 * 通过内容特征检测封面弹窗（不依赖特定 class 名，兼容 B站 UI 改版）。
 * 策略：
 *   1. 先尝试已知 CSS 选择器
 *   2. 若失败，查找含封面上传特征（image file input / "上传封面" / "拖拽图片"）的弹窗容器
 * @returns {Element|null}
 */
export function findCoverDialog() {
  // 排除助手面板自身：面板是 fixed 定位、高 z-index、且内含 file input，
  // 不排除会被兜底检测误判为“封面弹窗”，导致弹窗关闭验证/按钮查找全部失效
  const isSelfPanel = (el) => el && (el.id === 'bili-helper-panel' || (el.closest && el.closest('#bili-helper-panel')))

  // 0. 新版「封面制作」编辑器（bcc-dialog 结构）：以 .cover-editor-head 为锚点，
  //    向上取「最外层的 dialog/modal 类祖先」作为完整弹窗容器（含 header + body + footer）。
  //    不能用策略 2 的首个遮罩类祖先：中途带 cover/crop 类的内部小容器会先命中，
  //    返回的容器不含 footer，「完成」按钮查找必然落空（2026-08 批量投稿失败主因）
  for (const head of document.querySelectorAll(SELECTORS.coverEditorHead)) {
    if (isSelfPanel(head)) continue
    let node = head.parentElement
    let dialogRoot = null
    while (node && node !== document.body) {
      if (node.id === 'bili-helper-panel') break
      const cls = (node.className || '').toString().toLowerCase()
      if (cls.includes('dialog') || cls.includes('modal')) dialogRoot = node // 持续上溯，保留最外层
      node = node.parentElement
    }
    if (dialogRoot) {
      const style = window.getComputedStyle(dialogRoot)
      if (style.display !== 'none' && style.visibility !== 'hidden') return dialogRoot
    }
  }

  // 1. 已知选择器（兼容旧版）
  const known = document.querySelector(SELECTORS.coverDialogKnown.join(', '))
  if (known && !isSelfPanel(known)) return known

  // 2. 内容特征检测：找到封面相关的 file input 或上传提示文本，向上追溯弹窗容器
  const candidates = []

  // 2a. 通过 image file input 定位
  const imgInputs = document.querySelectorAll(SELECTORS.imageFileInput)
  for (const inp of imgInputs) {
    if (isSelfPanel(inp)) continue
    if (inp.offsetParent !== null || inp.closest('[style*="display: none"]') === null) {
      candidates.push(inp)
    }
  }

  // 2b. 通过文本特征定位（"上传封面"、"拖拽图片"、"更换封面"、"裁剪"、"封面裁剪"）
  if (candidates.length === 0) {
    const allEls = document.querySelectorAll('div, section, aside')
    for (const el of allEls) {
      if (isSelfPanel(el)) continue
      const text = el.textContent || ''
      if (text.length < 500 && (
        TEXT_KEYWORDS.coverFeatures.some((kw) => text.includes(kw)) ||
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
      if (isSelfPanel(cvs)) continue
      const style = window.getComputedStyle(cvs)
      if (style.display !== 'none' && cvs.width > 100 && cvs.height > 100) {
        candidates.push(cvs)
      }
    }
  }

  // 从候选元素向上查找弹窗/遮罩容器
  for (const el of candidates) {
    let node = el
    let outermostDialog = null // 最外层的 dialog/modal 容器（范围完整，包含 footer 按钮）
    let firstOverlay = null // 首个命中的遮罩类容器（找不到 dialog 类祖先时的兜底）
    while (node && node !== document.body) {
      if (node.id === 'bili-helper-panel') break // 绝不把助手面板当弹窗返回
      const style = window.getComputedStyle(node)
      const cls = (node.className || '').toString().toLowerCase()
      const zIndex = parseInt(style.zIndex) || 0
      const visible = style.display !== 'none' && style.visibility !== 'hidden'
      const isDialogish = (
        cls.includes('dialog') || cls.includes('modal') ||
        node.getAttribute('role') === 'dialog' || node.getAttribute('role') === 'alertdialog'
      )
      const isOverlay = (
        isDialogish ||
        style.position === 'fixed' || style.position === 'absolute' ||
        cls.includes('overlay') || cls.includes('popup') || cls.includes('drawer') || cls.includes('mask') ||
        cls.includes('crop') || cls.includes('cover') ||
        zIndex > 50
      )
      if (visible && isDialogish) outermostDialog = node
      if (visible && isOverlay && !firstOverlay) firstOverlay = node
      node = node.parentElement
    }
    // 优先返回最外层 dialog 容器（范围完整），其次首个遮罩容器（旧行为兜底）
    if (outermostDialog) return outermostDialog
    if (firstOverlay) return firstOverlay
  }

  // 3. 兜底：查找任何 fixed/absolute 遮罩层（z-index > 50）内含封面相关内容
  const allContainers = document.querySelectorAll('div, section, aside, article')
  for (const ov of allContainers) {
    if (isSelfPanel(ov)) continue
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
