// core/errorReport.js - 错误自证：日志缓冲、步骤追踪、错误报告收集与格式化
import { findButtonByText, findCoverDialog } from './find.js'
import { SELECTORS, STORAGE_KEYS } from '../config.js'

/** 日志缓冲：onLog 的所有输出同时累积于此，供错误包取尾部 */
export const logBuffer = []
export const MAX_LOG_BUFFER = 300

/** 当前执行步骤（由 runStep 维护），出错时用于定位步骤名与源码 */
let currentStep = null

/** 任务运行标志：批量上传进行中为 true（visibilitychange 提示据此避免误报） */
export let isUploading = false

export function setCurrentStep(step) { currentStep = step }
export function setIsUploading(v) { isUploading = v }

/**
 * 记录当前执行步骤：保存步骤名与函数源码（函数 toString() 无需任何权限）。
 * 后续步骤出错时，错误包能带上「当时在跑哪个函数、源码长什么样」。
 */
export async function runStep(name, fn, ...args) {
  currentStep = { name, source: fn.toString() }
  return fn(...args)
}

/** 收集关键 DOM 快照（出错瞬间页面长什么样），供 AI 定位选择器 */
export function collectDomSnapshot() {
  const snap = {}
  const grab = (key, selectors) => {
    try {
      const el = document.querySelector(selectors)
      snap[key] = el ? el.outerHTML.slice(0, 600) : null
    } catch (e) {
      snap[key] = null
    }
  }
  grab('标题框', SELECTORS.titleAny.join(', '))
  grab('可见范围radio', SELECTORS.visibilityContainer)
  grab('创作声明select', SELECTORS.declarationSelect)
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
export function recordError(err, extra) {
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
    const key = STORAGE_KEYS.errorReports
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
export function formatReportMarkdown(report) {
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
