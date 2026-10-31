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
export function findButtonByText(text) {
  const all = document.querySelectorAll('*')

  // 第一轮：找直接文本节点匹配的最小元素，然后向上找可点击父元素
  let bestMatch = null
  for (const el of all) {
    const directText = Array.from(el.childNodes)
      .filter(n => n.nodeType === 3)
      .map(n => n.textContent)
      .join('')
      .trim()
    if (normalizeText(directText) === normalizeText(text)) {
      if (!bestMatch || el.childNodes.length < bestMatch.childNodes.length) {
        bestMatch = el
      }
    }
  }
  return bestMatch ? toClickable(bestMatch) : null
}

/** 在指定 scope 内按直接文本节点查找可点击元素 */
export function findButtonInScope(text, scope) {
  const all = scope.querySelectorAll('*')
  let bestMatch = null
  for (const el of all) {
    const directText = Array.from(el.childNodes)
      .filter(n => n.nodeType === 3)
      .map(n => n.textContent)
      .join('')
      .trim()
    if (normalizeText(directText) === normalizeText(text)) {
      if (!bestMatch || el.childNodes.length < bestMatch.childNodes.length) {
        bestMatch = el
      }
    }
  }
  return bestMatch ? toClickable(bestMatch) : null
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
 * 通过文本查找并点击下拉选项。
 * 文案比较用 normalizeText：B站选项常带空格/换行，且改版会微调措辞
 * （「内容无需标注」→「无需标注」），所以传数组、按「任一命中」处理。
 *
 * 两处关键实现细节（2026-10 实测）：
 *   1. 必须用 dispatchFullClickSequence（含 mousedown/mouseup）。
 *      纯 el.click() 和只有 pointer 事件的序列都点不动 B站自研下拉的选项。
 *   2. 命中多个元素时取面积最小的（最内层）。`[class*="option"]` 很容易同时命中
 *      整个选项列表容器，点容器等于点空白，同样选不中。
 *
 * @param {string|string[]} texts 目标文案
 * @param {number} [maxLen=30] 选项文本长度上限，避免命中含关键词的长说明段落
 */
export function clickDropdownOption(texts, maxLen = 30) {
  const targets = (Array.isArray(texts) ? texts : [texts]).map(normalizeText).filter(Boolean)
  if (!targets.length) return false

  // 命中文本的长度上限：目标文案长度 + 4。
  // 超过这个长度的基本都是「装着所有选项的容器」（textContent 会把全部选项拼起来），
  // 点容器等于点空白 —— 这正是「命中了下拉项却选不中」的真正原因。
  const maxHitLen = Math.min(maxLen, Math.min(...targets.map((t) => t.length)) + 4)

  const hits = []
  for (const item of document.querySelectorAll(SELECTORS.dropdownItems)) {
    const t = normalizeText(item.textContent)
    if (!t || t.length > maxHitLen) continue
    const exact = targets.includes(t)
    const partial = !exact && targets.some((x) => t.includes(x))
    if (!exact && !partial) continue
    const rect = item.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    hits.push({ item, exact, len: t.length, area: rect.width * rect.height })
  }
  if (!hits.length) return false

  // 严格相等 > 文本更短（更接近选项本身） > 面积更小
  hits.sort((a, b) => (Number(b.exact) - Number(a.exact)) || (a.len - b.len) || (a.area - b.area))
  dispatchFullClickSequence(hits[0].item)
  return true
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
