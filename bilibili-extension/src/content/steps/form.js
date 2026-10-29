// steps/form.js - Step 2~5: 等待表单 / 填写标题 / 创作声明 / 可见范围
import { waitFor, waitForElement, waitForStable } from '../core/wait.js'
import { clickDropdownOption } from '../core/find.js'
import { SELECTORS, BUTTON_LABELS, TEXT_KEYWORDS, TIMEOUTS } from '../config.js'

/**
 * Step 2: 等待表单出现（不需要等上传完成，B站允许边上传边填表）
 */
export async function stepWaitForForm(onLog) {
  onLog('等待表单加载...')
  await waitForElement(SELECTORS.titleAny, TIMEOUTS.waitForForm)
  // 等表单渲染稳定（上限保持 2s；快时提前继续）
  await waitForStable({ maxMs: TIMEOUTS.afterFormLoad })
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
  // 等 Vue 消化这次输入（上限仍是 300ms，正常几十毫秒就继续）
  await waitForStable({ quietMs: 80, maxMs: TIMEOUTS.afterTitleSet, minMs: 60 })
  // 校验：编辑器可能截断或异步清空，未生效则重填一次
  if ((input.value || '').trim() !== title.trim()) {
    applyTitle()
    await waitForStable({ quietMs: 80, maxMs: TIMEOUTS.afterTitleSet, minMs: 60 })
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
export async function stepSetDeclaration(onLog) {
  onLog('设置创作声明...')

  /** 打开 select 并点击目标选项 */
  async function trySelectDeclaration(selectEl) {
    const trigger = selectEl.querySelector(SELECTORS.declarationTrigger)
    if (!trigger) return false
    trigger.click()
    // 下拉项一渲染出来就点（原来是无条件等满 500ms 再点一次，
    // 慢网时会漏点导致主方案失败、白跑备用方案）
    return !!(await waitFor(
      () => clickDropdownOption(TEXT_KEYWORDS.declarationTarget),
      TIMEOUTS.clickDropdownDelay + 1000,
      100
    ))
  }

  // 主方案：通过"创作声明"标签文本精确定位
  for (const label of document.querySelectorAll('span, label, div')) {
    if (label.textContent.trim() === TEXT_KEYWORDS.declarationLabel) {
      const parent = label.closest(SELECTORS.declarationFormItem) || label.parentElement
      const targetSelect = parent?.querySelector(`${SELECTORS.declarationSelect}, select, [class*="select"]`)
      if (targetSelect && await trySelectDeclaration(targetSelect)) {
        return onLog('创作声明已设置为「内容无需标注」')
      }
      break
    }
  }

  // 备用方案：遍历所有 el-select，找到关联"创作声明"的那一个
  for (const sel of document.querySelectorAll(SELECTORS.declarationSelect)) {
    if (sel.closest('.el-form-item')?.textContent.includes(TEXT_KEYWORDS.declarationLabel)) {
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
        await waitForStable({ maxMs: TIMEOUTS.visibilitySettle })
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
        await waitForStable({ maxMs: TIMEOUTS.visibilitySettle })
        return
      }
    }
  }

  onLog(`提示: 未找到可见范围「${text}」，请手动设置`)
  await waitForStable({ maxMs: TIMEOUTS.visibilitySettle })
}
