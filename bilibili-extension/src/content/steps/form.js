// steps/form.js - Step 2~5: 等待表单 / 填写标题 / 创作声明 / 可见范围
import { sleep, waitFor, waitForElement } from '../core/wait.js'
import { normalizeText, dispatchFullClickSequence } from '../core/find.js'
import { SELECTORS, BUTTON_LABELS, TEXT_KEYWORDS, TIMEOUTS } from '../config.js'

/** 文案配置既可以是字符串也可以是数组，统一成数组 */
const toArray = (v) => (Array.isArray(v) ? v : [v]).filter(Boolean)

/** 元素是否可见（尺寸 > 0 且祖先链上没有 display:none / visibility:hidden） */
function isVisible(el) {
  if (!el) return false
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return false
  let node = el
  for (let i = 0; i < 10 && node && node !== document.body; i++) {
    const s = window.getComputedStyle(node)
    if (s.display === 'none' || s.visibility === 'hidden') return false
    node = node.parentElement
  }
  return true
}

/**
 * 找「创作声明」标签元素：按文本关键词命中，取文本最短的那个（最内层）。
 * 兼容标签带必填标记的情况（如「* 创作声明」「创作者声明（必填）」）。
 */
function findLabelElement(labels, maxLen) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
  let node
  let best = null
  while ((node = walker.nextNode())) {
    const t = normalizeText(node.nodeValue)
    if (!t || t.length > maxLen) continue
    if (!labels.some((l) => t.includes(normalizeText(l)))) continue
    const el = node.parentElement
    if (!el || (el.closest && el.closest('#bili-helper-panel'))) continue
    if (!isVisible(el)) continue
    if (!best || (el.textContent || '').length < (best.textContent || '').length) best = el
  }
  return best
}

/**
 * Step 2: 等待表单出现（不需要等上传完成，B站允许边上传边填表）
 */
export async function stepWaitForForm(onLog) {
  onLog('等待表单加载...')
  await waitForElement(SELECTORS.titleAny, TIMEOUTS.waitForForm)
  await sleep(TIMEOUTS.afterFormLoad)
  onLog('表单已加载，开始设置')
}

/**
 * Step 3: 填写标题
 * B站上传后默认以文件名作为标题，但该行为可能随版本变化；
 * 显式填入解析出的标题，避免投稿出现空标题/错误标题。
 */
export async function stepSetTitle(title, onLog) {
  onLog(`填写标题: ${title}`)
  let input
  // 优先匹配更具体的主标题占位文案，避免命中分P标题框（分P编辑页同时存在多个标题框）
  try {
    input = await waitForElement(SELECTORS.titlePrecise, TIMEOUTS.titlePrecise)
  } catch (err) { /* 精确匹配超时，回退到模糊选择器 */ }
  if (!input) {
    try {
      input = await waitForElement(SELECTORS.titleFallback, TIMEOUTS.titleFallback)
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
  await sleep(TIMEOUTS.afterTitleSet)
  // 校验：编辑器可能截断或异步清空，未生效则重填一次
  if ((input.value || '').trim() !== title.trim()) {
    applyTitle()
    await sleep(TIMEOUTS.afterTitleSet)
  }
  if ((input.value || '').trim() !== title.trim()) {
    onLog(`警告: 标题填写后未生效（当前值: ${input.value || '(空)'}），请检查标题框是否被锁定`)
  } else {
    onLog('标题已填写')
  }
}

/**
 * Step 4: 设置创作声明为「内容无需标注」
 *
 * 2026 改版后该字段变成必填：标签带红色星号、组件可能换成 B站自研 bcc-* 下拉，
 * 选项文案也可能微调。所以不绑死单一选择器和精确文案：
 *   1. 关键词定位「创作声明」标签（兼容「创作者声明」、带必填标记）
 *   2. 沿祖先链找同一行的下拉容器（el-select / bcc-select / 自定义）
 *   3. 依次尝试「组件触发器 → 组件本身 → 整行」打开下拉，再点目标选项
 *   4. 点完必须校验行内真的变成目标值才算成功
 */
export async function stepSetDeclaration(onLog) {
  const labels = toArray(TEXT_KEYWORDS.declarationLabel || '创作声明')
  const targets = toArray(TEXT_KEYWORDS.declarationTarget || '无需标注')
  const maxLen = TEXT_KEYWORDS.declarationTextLimit || 16

  onLog('设置创作声明...')

  // 诊断日志走 console：面板日志太长不方便翻，F12 一搜「[声明诊断]」就能定位
  const dbg = (...args) => { try { console.log('[声明诊断]', ...args) } catch (e) { /* 忽略 */ } }
  const descEl = (el) => {
    if (!el) return 'null'
    const cls = (el.className || '').toString().trim().replace(/\s+/g, '.')
    const r = el.getBoundingClientRect()
    const txt = (el.textContent || '').replace(/\s+/g, '').slice(0, 20)
    return `<${el.tagName.toLowerCase()}${cls ? '.' + cls.slice(0, 40) : ''}> ${Math.round(r.width)}x${Math.round(r.height)} "${txt}"`
  }
  dbg('开始', { labels, targets, maxLen })

  const labelEl = findLabelElement(labels, maxLen)
  dbg('标签', descEl(labelEl))
  if (!labelEl) {
    onLog('未找到「创作声明」标签，跳过（可手动设置）')
    return
  }

  // 沿祖先链找同行内的下拉组件
  let row = labelEl
  let selectEl = null
  for (let i = 0; i < 6 && row && row !== document.body; i++) {
    selectEl = row.querySelector(SELECTORS.declarationSelect)
    if (selectEl) break
    row = row.parentElement
  }
  const scope = row && row !== document.body ? row : labelEl.parentElement
  dbg('下拉', descEl(selectEl), '| 行容器', descEl(scope))

  // 显示区是否已经写着目标值。
  // 注意 B站 bcc-select 用 <input readonly> 显示选中值 —— input.value 不在文本节点里，
  // 只扫文本节点永远检测不到，必须先查 input/textarea。
  // 用「包含」而不是「严格相等」：显示值可能带图标/额外字符。
  const valueShown = () => {
    if (!scope) return false
    const norms = targets.map(normalizeText)
    const hit = (v) => norms.some((x) => v === x || v.includes(x))

    for (const inp of scope.querySelectorAll('input, textarea')) {
      const v = normalizeText(inp.value || '')
      if (v && hit(v)) return true
    }

    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null)
    let node
    while ((node = walker.nextNode())) {
      const t = normalizeText(node.nodeValue)
      if (!t || t.length > maxLen) continue
      if (!hit(t)) continue
      if (!isVisible(node.parentElement)) continue
      return true
    }
    return false
  }

  // 行内已显示目标值（B站可能记住了上次选择）
  if (valueShown()) {
    dbg('行内已有目标值，跳过')
    onLog('创作声明已是目标状态，无需操作')
    return
  }

  // 只找选项元素、不点击：这样可以对「同一次命中」尝试不同的点击方式
  const findOption = () => {
    const norms = targets.map(normalizeText)
    // 文本长度上限：超过的大概率是「装着所有选项的容器」，点它等于点空白
    const maxHitLen = Math.min(maxLen, Math.min(...norms.map((t) => t.length)) + 4)
    let best = null
    for (const root of [scope, document]) {
      if (!root) continue
      for (const el of root.querySelectorAll('[class*="option"], li')) {
        const cls = (el.className || '').toString()
        // 排除 tooltip 包裹层：B站结构是
        // <article class="vu-hover-tips option-hover-tips"><li class="bcc-option">…
        // 外层 class 也含 "option"，点它等于点空白
        if (/hover-tips|tooltip|wrapper/i.test(cls)) continue
        if (el.closest && el.closest('#bili-helper-panel')) continue
        if (labelEl.contains(el)) continue
        const t = normalizeText(el.textContent)
        if (!t || t.length > maxHitLen) continue
        const exact = norms.includes(t)
        if (!exact && !norms.some((x) => t.includes(x))) continue
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0 || !isVisible(el)) continue
        // 严格相等最优先；同分时「更像选项」的优先（class 带 option / option-item）
        const looksOption = /bcc-option|option-item|(^|[-_ ])option([-_ ]|$)/i.test(cls) ? 0 : 1
        const score = (exact ? 0 : 1000) + looksOption * 10 + t.length + el.childElementCount * 0.1
        if (!best || score < best.score) best = { el, score }
      }
      if (best) return best.el
    }
    return null
  }

  // 目标选项此刻是否还显示着。bcc-select 的选项常驻 DOM，只有展开时才可见 ——
  // 「点完后目标选项仍然可见」= 菜单还开着 = 没选中。
  const optionStillVisible = () => !!findOption()

  // 校验两步：① 下拉收起 ② 显示区出现目标值。
  // 只看 ② 会把「刚把下拉点开」误判成「已选中」——之前就是这么假成功的。
  const isApplied = async () => {
    const closed = await waitFor(() => (optionStillVisible() ? null : true), 1500, 100)
    if (!closed) return false
    return !!(await waitFor(valueShown, 600, 100))
  }

  // 同一次命中先试完整指针序列（pointerdown→mousedown→pointerup→mouseup→click），
  // 它包含 click，能同时覆盖「只认 mousedown」和「只认 click」两类组件；
  // 纯 click 留作兜底，因为有些组件被 click 一碰就关菜单、值反而不写。
  const pickAndApply = async () => {
    let opt = await waitFor(findOption, 1000, 100)
    if (!opt) return 'no-option'
    dbg('  命中选项', descEl(opt))
    dispatchFullClickSequence(opt)
    if (await isApplied()) return 'ok'
    opt = findOption()
    if (!opt) return 'closed-but-empty' // 菜单关了却没写值：点错了元素
    opt.click()
    return (await isApplied()) ? 'ok' : 'failed'
  }

  const tryOpenAndPick = async (opener, useSequence) => {
    if (useSequence) dispatchFullClickSequence(opener)
    else opener.click()
    const r = await pickAndApply()
    const msg = r === 'ok' ? '成功'
      : r === 'no-option' ? '没找到选项（下拉没打开）'
      : r === 'closed-but-empty' ? '点了，菜单关了但值没写进去'
      : '点了，值仍未生效'
    dbg(`  → ${msg}`)
    return r === 'ok'
  }

  // 候选可点区域：组件触发器 → 组件本身 → 标签 → 整行 → 行容器的父级
  const openers = []
  if (selectEl) openers.push(selectEl.querySelector(SELECTORS.declarationTrigger), selectEl)
  openers.push(labelEl, scope, scope && scope.parentElement)

  // 每个候选先试普通 click，再试完整指针序列（覆盖监听 pointerdown 的组件）。
  // 总时长封顶：失败宁可尽快报出来，不让投稿流程在这里空转。
  const deadline = Date.now() + 12000
  let i = 0
  for (const opener of openers) {
    i++
    if (!opener || Date.now() > deadline) continue
    dbg(`尝试 #${i}`, descEl(opener))
    if (await tryOpenAndPick(opener, false)) {
      onLog('创作声明已设置为「内容无需标注」')
      return
    }
    if (Date.now() > deadline) break
    dbg(`尝试 #${i} 指针序列`, descEl(opener))
    if (await tryOpenAndPick(opener, true)) {
      onLog('创作声明已设置为「内容无需标注」')
      return
    }
  }

  // 兜底：非下拉形态（选项平铺在页面上），直接点目标文案
  const flat = findLabelElement(targets, maxLen)
  dbg('平铺兜底', descEl(flat))
  if (flat && flat !== labelEl) {
    dispatchFullClickSequence(flat)
    if (await isApplied()) {
      onLog('创作声明已设置为「内容无需标注」（平铺选项）')
      return
    }
  }

  onLog('提示: 未能自动设置创作声明，请在页面上手动选择')

  // 失败时把页面实况打到 console：这是定位改版细节最直接的一份数据
  try {
    const near = []
    for (const el of document.querySelectorAll('div, span, label')) {
      const t = (el.textContent || '').replace(/\s+/g, '')
      if (!t.includes('声明') || t.length > 30) continue
      if (!isVisible(el)) continue
      near.push(descEl(el))
      if (near.length >= 6) break
    }
    dbg('失败快照·含「声明」元素:', near.length ? near.join(' ｜ ') : '(无)')

    const sels = []
    for (const el of document.querySelectorAll('[class*="select"], [class*="dropdown"], [class*="option"], [class*="list"]')) {
      if (!isVisible(el)) continue
      sels.push(descEl(el))
      if (sels.length >= 8) break
    }
    dbg('失败快照·下拉类元素:', sels.length ? sels.join(' ｜ ') : '(无)')

    // 组件真实结构：选项是什么元素、选中态用什么 class，看这一段最直接
    dbg('失败快照·bcc-select HTML:', (selectEl ? selectEl.outerHTML : '(无)').replace(/\s+/g, ' ').slice(0, 900))
  } catch (e) { /* 诊断失败不影响主流程 */ }
}

/**
 * Step 5: 设置可见范围
 * 可见范围是自定义 check-radio-v2 组件，非原生 radio 也非 el-select
 * @param {string} targetText - 要选中的可见范围文本，如'公开可见'、'仅自己可见'
 */
export async function stepSetVisibility(onLog, targetText) {
  const text = targetText || '仅自己可见'
  onLog(`设置可见范围为「${text}」...`)

  // 查找包含目标文本的 check-radio-v2-container
  const nameSpans = document.querySelectorAll(SELECTORS.visibilityName)
  for (const span of nameSpans) {
    if (span.textContent.trim() === text) {
      const container = span.closest(SELECTORS.visibilityContainer)
      if (container) {
        if (container.classList.contains('active') || container.classList.contains('checked') || container.querySelector(SELECTORS.visibilityBox)?.classList.contains('checked')) {
          onLog(`可见范围已是「${text}」`)
        } else {
          container.click()
          onLog(`可见范围已设置为「${text}」`)
        }
        await sleep(TIMEOUTS.visibilitySettle)
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
      const clickable = el.closest(SELECTORS.visibilityContainer) || el.parentElement
      if (clickable) {
        clickable.click()
        onLog(`可见范围已设置为「${text}」（备用方案）`)
        await sleep(TIMEOUTS.visibilitySettle)
        return
      }
    }
  }

  onLog(`提示: 未找到可见范围「${text}」，请手动设置`)
  await sleep(TIMEOUTS.visibilitySettle)
}
