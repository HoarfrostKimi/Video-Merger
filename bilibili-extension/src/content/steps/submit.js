// steps/submit.js - Step 7: 点击「立即投稿」（加固版）
import { waitFor } from '../core/wait.js'
import { findButtonByText } from '../core/find.js'
import { BUTTON_LABELS, SELECTORS, TIMEOUTS } from '../config.js'

/**
 * Step 7: 点击「立即投稿」（加固版）
 * 原实现只点一次、不检查按钮是否可用：disabled 按钮点击无效却日志报成功（假成功）。
 * 现在：等按钮出现且可用 → 点击 → 验证生效（按钮禁用/出现提交反馈），未生效则重试一次。
 */
export async function stepSubmit(onLog) {
  onLog('准备提交稿件...')

  const MAX_WAIT = TIMEOUTS.submitWait
  const isDisabled = (btn) => {
    if (btn.disabled) return true
    if (btn.getAttribute('aria-disabled') === 'true') return true
    const cls = btn.className || ''
    return typeof cls === 'string' && /disabled/.test(cls)
  }

  // 1. 等「立即投稿」按钮出现且可用（不 disabled）
  const submitBtn = await waitFor(() => {
    const btn = findButtonByText(BUTTON_LABELS.submit)
    if (!btn || isDisabled(btn)) return null
    return btn
  }, MAX_WAIT, 1000)

  if (!submitBtn) {
    const exists = findButtonByText(BUTTON_LABELS.submit)
    if (exists) {
      onLog(`警告: 「立即投稿」按钮 ${MAX_WAIT / 1000}s 内始终禁用，可能上传/封面未完成，请手动检查`)
    } else {
      onLog('警告: 未找到「立即投稿」按钮，请手动提交')
    }
    return
  }

  // 2. 点击
  submitBtn.click()
  onLog('已点击「立即投稿」')

  // 3. 验证生效：按钮进入禁用状态，或连续 3 次（约 1.5s）都找不到按钮（避免渲染间隙误判）才算提交成功；未生效则重试一次
  let disappearCount = 0
  const confirmed = await waitFor(() => {
    const btn = findButtonByText(BUTTON_LABELS.submit)
    if (btn) {
      disappearCount = 0
      return isDisabled(btn) ? true : null
    }
    disappearCount++
    return disappearCount >= 3 ? true : null
  }, TIMEOUTS.submitVerify, 500)

  if (confirmed) {
    onLog('投稿已提交')
    return
  }

  // 若已出现确认弹窗（部分场景点「立即投稿」后有二次确认），交给用户手动确认，避免程序化重复点击
  const msgBox = document.querySelector(SELECTORS.messageBox)
  if (msgBox) {
    onLog('检测到确认弹窗，请手动确认投稿')
    return
  }
  onLog('警告: 未确认投稿生效，重试点击...')
  const retryBtn = findButtonByText(BUTTON_LABELS.submit)
  if (retryBtn && !isDisabled(retryBtn)) {
    retryBtn.click()
    onLog('已重试点击「立即投稿」')
  } else {
    onLog('警告: 按钮状态异常，请手动确认投稿状态')
  }
}
