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

/** 元素自身的直接文本（不含子元素文本） */
function directTextOf(el) {
  let s = ''
  for (const n of el.childNodes) {
    if (n.nodeType === 3) s += n.nodeValue
  }
  return s.trim()
}

/**
 * 按「直接文本」精确查找元素：只扫文本节点（TreeWalker），不再全页遍历元素。
 * 性能要点：旧实现 querySelectorAll('*') + 每元素建一次 childNodes 数组，
 * 在投稿页上万节点时要几毫秒到几十毫秒；而 findButtonByText 被轮询高频调用
 * （submit/封面确认都是每 300~1000ms 一次），会持续抢占主线程拖慢整个流程。
 * TreeWalker 只读 nodeValue，代价与文本节点数成正比。
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
    // 先做最便宜的原始包含判断（命中即必然归一化命中），
    // 只有原始文本既不包含目标、又明显长于目标时才跳过——留出「目标文案被拆成
    // 多个文本节点」的余地（如 <button>立<span></span>即投稿</button>），
    // 同时避免给页面上的长段落逐个分配归一化字符串
    if (!raw.includes(target) && raw.trim().length > target.length + 8) continue
    const el = node.parentElement
    if (!el || el.id === 'bili-helper-panel' || (el.closest && el.closest('#bili-helper-panel'))) continue
    // 用元素级拼接结果二次校验：兼容「确 定」被拆成多个文本节点的情况
    if (normalizeText(directTextOf(el)) !== target) continue
    if (!bestMatch || el.childNodes.length < bestMatch.childNodes.length) bestMatch = el
  }
  return bestMatch
}

/** 通过文本内容查找可点击元素 */
export function findButtonByText(text) {
  const el = findExactTextElement(text, document.body)
  return el ? toClickable(el) : null
}

/** 在指定 scope 内按直接文本节点查找可点击元素 */
export function findButtonInScope(text, scope) {
  const el = findExactTextElement(text, scope)
  return el ? toClickable(el) : null
}

/**
 * 查找「包含指定关键词、且尺寸像卡片/区块」的最内层可见元素。
 * 用于等视频卡片出现、找封面入口这类"按关键词找块"的场景。
 * 性能要点：从文本节点入手（TreeWalker）而不是全页 querySelectorAll('*')，
 * 且 getBoundingClientRect（会强制同步布局）只对少量候选调用。
 * @param {string} keyword 关键词（原始包含匹配，不归一化，供文件名/分区名等使用）
 * @param {object} [opts]
 * @param {number} [opts.maxTextLen=200] 候选元素文本长度上限（排除大容器）
 * @param {number} [opts.minWidth=100] 命中区域最小宽度
 * @param {number} [opts.minHeight=30] 命中区域最小高度
 * @param {number} [opts.maxCandidates=30] 最多考察多少个命中文本节点，防极端页面拖死
 * @param {number} [opts.maxDepth=10] 从文本元素向上最多爬几层
 * @returns {Element|null} 候选里面积最小（最内层）的达标元素——与原「取最小面积」语义一致
 */
export function findVisibleTextElement(keyword, opts = {}) {
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
    // 从文本所在元素向上，取第一个「文本量像卡片、尺寸达标」的容器
    for (let depth = 0; el && el !== document.body && depth < maxDepth; depth++) {
      if ((el.textContent || '').length > maxTextLen) break // 已到外层大容器，本候选无解
      const rect = el.getBoundingClientRect()
      if (rect.width >= minWidth && rect.height >= minHeight) {
        candidates.push({ el, area: rect.width * rect.height })
        break
      }
      el = el.parentElement
    }
  }
  if (!candidates.length) return null
  // 与旧实现一致：多个候选时取面积最小的那个（最贴近"卡片内文字"的那层）
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
export function clickDropdownOption(text) {
  // 查找所有可见的下拉菜单项
  const items = document.querySelectorAll(SELECTORS.dropdownItems)
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

/**
 * 通过内容特征检测封面弹窗（不依赖特定 class 名，兼容 B站 UI 改版）。
 * 策略：
 *   1. 先尝试已知 CSS 选择器
 *   2. 若失败，查找含封面上传特征（image file input / "上传封面" / "拖拽图片"）的弹窗容器
 * @returns {Element|null}
 */
/**
 * 元素（含祖先链）是否真的可见。
 *
 * 必须查祖先：computed display 不会从父级继承 'none'，所以 bcc-dialog 常驻 DOM 且
 * 被 display:none 隐藏时，里面 .bcc-dialog__header 的 computed display 仍是 'block'。
 * 只查元素自身会把「已关闭的封面编辑器」当成开着的弹窗返回 —— 表现为
 * 「点了完成、弹窗却一直显示未关闭」，是封面步骤间歇失败的根源之一。
 * @param {Element} el
 * @param {number} [maxDepth=12] 上溯层数上限（防止极端嵌套拖慢轮询）
 */
export function isVisibleInTree(el, maxDepth = 12) {
  let node = el
  let depth = 0
  while (node && node !== document.body && depth < maxDepth) {
    const style = window.getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    node = node.parentElement
    depth++
  }
  return true
}

/**
 * 查找封面弹窗容器。
 * @returns {Element|null} 含 footer 的最外层弹窗容器；没打开时返回 null
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
    if (dialogRoot && isVisibleInTree(dialogRoot)) return dialogRoot
  }

  // 1. 已知选择器（兼容旧版）：取第一个真正可见的（常驻 DOM 的旧弹窗可能只是 display:none）
  for (const known of document.querySelectorAll(SELECTORS.coverDialogKnown.join(', '))) {
    if (isSelfPanel(known)) continue
    if (isVisibleInTree(known)) return known
  }

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
        // 祖先链隐藏的（常驻 DOM 的旧弹窗）直接排除，否则会在弹窗关闭后继续被当成候选
        if (isVisibleInTree(el)) candidates.push(el)
      }
    }
  }

  // 2c. 通过 canvas 元素定位（B站新版封面裁剪用 canvas 预览）
  if (candidates.length === 0) {
    const canvases = document.querySelectorAll('canvas')
    for (const cvs of canvases) {
      if (isSelfPanel(cvs)) continue
      const style = window.getComputedStyle(cvs)
      if (style.display !== 'none' && cvs.width > 100 && cvs.height > 100 && isVisibleInTree(cvs)) {
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
    if (!isVisibleInTree(ov)) continue
    const text = ov.textContent || ''
    if (text.includes('封面') || text.includes('裁剪') || ov.querySelector('input[type="file"], canvas, img[src^="blob:"]')) {
      return ov
    }
  }

  return null
}
