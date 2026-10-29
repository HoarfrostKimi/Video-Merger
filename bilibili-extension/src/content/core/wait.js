// core/wait.js - 等待与延时工具
import { findVisibleTextElement } from './find.js'

/** 延时 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 等「DOM 安静下来」再继续：连续 quietMs 无 DOM 变动即视为渲染完成，最多等 maxMs。
 *
 * 用来替代固定 sleep —— 慢的时候依然能等到上限（与固定等待等价，不会更不稳），
 * 快的时候提前几秒继续。固定 sleep 的毛病是无论页面多快都要干等满额。
 *
 * 不用 requestAnimationFrame：页面不可见（黑屏/最小化）时 rAF 会被浏览器挂起，
 * 而 MutationObserver + timer 不受影响，正好匹配「黑屏也要投稿」的场景。
 * 只监听 childList/characterData、不监听 attributes：上传进度条走 style 变化，
 * 监听属性会让条件永远不满足，退化成死等满额。
 *
 * @param {object} [opts]
 * @param {number} [opts.quietMs=150] 判定安静所需的无变动时长
 * @param {number} [opts.maxMs=2000] 最长等待（建议填原 sleep 的时长，保持上限不变）
 * @param {number} [opts.minMs=100] 最短等待（给布局/样式计算留一帧以上）
 * @returns {Promise<void>}
 */
export function waitForStable({ quietMs = 150, maxMs = 2000, minMs = 100 } = {}) {
  return new Promise((resolve) => {
    const start = Date.now()
    let lastChange = start
    let done = false
    let timer = null
    let tick = null
    const finish = () => {
      if (done) return
      done = true
      obs.disconnect()
      clearTimeout(timer)
      clearInterval(tick)
      resolve()
    }
    const obs = new MutationObserver(() => { lastChange = Date.now() })
    try {
      obs.observe(document.body, { childList: true, subtree: true, characterData: true })
    } catch (e) {
      // body 还没就绪等极端情况：直接退回纯计时
      setTimeout(finish, minMs)
      return
    }
    timer = setTimeout(finish, maxMs)
    tick = setInterval(() => {
      const now = Date.now()
      if (now - start < minMs) return
      if (now - lastChange >= quietMs) finish()
    }, 50)
  })
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
  // 查找逻辑走 TreeWalker 文本节点扫描（见 findVisibleTextElement），
  // 不再每次回调都全页 querySelectorAll('*') —— 上传期间 DOM 变动频繁，
  // 旧写法会持续强制同步布局，把主线程吃满、连 B站 自己的上传进度都卡
  const check = () => findVisibleTextElement(keyword)
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
