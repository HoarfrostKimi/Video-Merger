// core/healthCheck.js - 进入编辑页后自检关键锚点：B站改版时提前预警
//
// 为什么不在注入时自检：注入时页面还在"拖拽上传"状态，没有标题框也没有投稿按钮，
// 那时检查必然全是误报。正确时机是 stepWaitForForm 之后（表单已渲染）。
//
// 目的：把"跑到第 6 步封面才失败"提前成"一进表单就告诉你哪儿没了"，
// 省掉一轮 10 分钟的批量上传才发现全废。

import { SELECTORS, BUTTON_LABELS, TEXT_KEYWORDS } from '../config.js'
import { findButtonByText } from './find.js'

const BANNER_ID = 'bili-helper-health'

/** 任一选择器能命中即算存在 */
function anyPresent(selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors]
  for (const sel of list) {
    if (document.querySelector(sel)) return true
  }
  return false
}

/** 页面上是否存在某段文本（用于没有稳定选择器的项） */
function anyText(keyword) {
  return (document.body?.textContent || '').includes(keyword)
}

/**
 * 检查项定义。
 * critical：缺了这一步必失败，直接红条；
 * 非 critical：有备用方案，缺了只提示（避免改版小改动就天天报警）。
 */
export const HEALTH_CHECKS = [
  { id: 'title', label: '标题输入框', critical: true, test: () => anyPresent(SELECTORS.titleAny) },
  { id: 'submit', label: '「立即投稿」按钮', critical: true, test: () => !!findButtonByText(BUTTON_LABELS.submit) },
  { id: 'coverEntry', label: '封面入口', critical: false, test: () => coverEntryExists() },
  { id: 'visibility', label: '可见范围选择器', critical: false, test: () => anyPresent(SELECTORS.visibilityName) },
  {
    id: 'declaration',
    label: '创作声明下拉',
    critical: false,
    test: () => anyPresent(SELECTORS.declarationSelect) || anyText(TEXT_KEYWORDS.declarationTarget),
  },
]

function coverEntryExists() {
  for (const label of BUTTON_LABELS.coverEntry) {
    if (findButtonByText(label)) return true
  }
  return anyText('封面')
}

/**
 * 执行一次自检（同步、只读 DOM）。
 * @returns {{ok:boolean, missing:string[], criticalMissing:string[]}}
 */
export function runHealthCheck() {
  const missing = []
  const criticalMissing = []
  for (const c of HEALTH_CHECKS) {
    let ok = false
    try {
      ok = !!c.test()
    } catch (e) {
      ok = false
    }
    if (!ok) {
      missing.push(c.label)
      if (c.critical) criticalMissing.push(c.label)
    }
  }
  return { ok: missing.length === 0, missing, criticalMissing }
}

/**
 * 把结果画到助手面板上。直接操作 DOM 而不引入 import，
 * 是为了避免 healthCheck ←→ panel 的循环依赖（panel 依赖 flow，flow 依赖这里）。
 * @param {{ok:boolean, missing:string[], criticalMissing:string[]}} result
 */
export function renderHealthBanner(result) {
  const panel = document.getElementById('bili-helper-panel')
  if (!panel) return
  let banner = document.getElementById(BANNER_ID)
  if (result.ok) {
    if (banner) banner.remove()
    return
  }
  const isCritical = result.criticalMissing.length > 0
  const text = isCritical
    ? `页面结构异常：未找到 ${result.criticalMissing.map((s) => `「${s}」`).join('、')}。B站可能已改版，本批次大概率失败，建议先更新扩展再传。`
    : `提示：未找到 ${result.missing.map((s) => `「${s}」`).join('、')}（有备用方案，若流程卡住可能是B站改版）`

  if (!banner) {
    banner = document.createElement('div')
    banner.id = BANNER_ID
    // 插到面板 body 最前面，不打断原有布局
    const body = panel.querySelector('.bili-helper-body') || panel
    body.insertBefore(banner, body.firstChild)
  }
  banner.style.cssText = [
    'margin:8px 0',
    'padding:8px 10px',
    'border-radius:6px',
    'font-size:12px',
    'line-height:1.5',
    isCritical ? 'background:#fff1f0' : 'background:#fffbe6',
    isCritical ? 'border:1px solid #ffa39e' : 'border:1px solid #ffe58f',
    isCritical ? 'color:#a8071a' : 'color:#874d00',
  ].join(';')
  banner.textContent = text
  banner.title = text
}
