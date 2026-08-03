// core/find.js - DOM 定位工具：按选择器/文本/内容特征查找可点击元素与弹窗
import { SELECTORS, TEXT_KEYWORDS } from '../config.js'

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
    if (directText === text) {
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
    if (directText === text) {
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
export function findCoverDialog() {
  // 1. 已知选择器（兼容旧版）
  const known = document.querySelector(SELECTORS.coverDialogKnown.join(', '))
  if (known) return known

  // 2. 内容特征检测：找到封面相关的 file input 或上传提示文本，向上追溯弹窗容器
  const candidates = []

  // 2a. 通过 image file input 定位
  const imgInputs = document.querySelectorAll(SELECTORS.imageFileInput)
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
