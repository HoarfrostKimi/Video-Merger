// core/wait.js - 等待与延时工具

/** 延时 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 轮询等待某个条件成立（取代「固定 sleep 后直接判定」，避免时序竞态）
 * @param {() => any} condition 判定函数，返回真值即视为成功
 * @param {number} [timeout=8000] 最长等待毫秒
 * @param {number} [interval=300] 轮询间隔
 * @returns {Promise<any>} 条件成立时的返回值，超时则返回 null
 */
export async function waitFor(condition, timeout = 8000, interval = 300) {
  const start = Date.now()
  for (;;) {
    const res = condition()
    if (res) return res
    if (Date.now() - start >= timeout) return null
    await sleep(interval)
  }
}

/** 等待元素出现（支持多个 selector） */
export function waitForElement(selectors, timeout = 30000) {
  const selectorList = Array.isArray(selectors) ? selectors : [selectors]
  return new Promise((resolve, reject) => {
    for (const sel of selectorList) {
      const el = document.querySelector(sel)
      if (el) return resolve(el)
    }
    const observer = new MutationObserver(() => {
      for (const sel of selectorList) {
        const el = document.querySelector(sel)
        if (el) {
          observer.disconnect()
          return resolve(el)
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => {
      observer.disconnect()
      reject(new Error(`等待元素超时`))
    }, timeout)
  })
}

/** 等待 DOM 中出现包含指定文本的可见元素 */
export function waitForElementByText(keyword, timeout = 60000) {
  const check = () => {
    for (const el of document.querySelectorAll('*')) {
      const text = el.textContent || ''
      if (text.includes(keyword) && text.length < 200) {
        const rect = el.getBoundingClientRect()
        if (rect.width > 100 && rect.height > 30) return el
      }
    }
    return null
  }
  const existing = check()
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const obs = new MutationObserver(() => {
      const el = check()
      if (el) { obs.disconnect(); resolve(el) }
    })
    obs.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => { obs.disconnect(); reject(new Error(`等待「${keyword}」超时`)) }, timeout)
  })
}
