// @vitest-environment happy-dom
// tests/dom.test.js - DOM 夹具测试：覆盖按钮定位 / 卡片查找 / 封面弹窗识别 / 页面结构自检
//
// 为什么要有这层：find.js、healthCheck.js 的故障全部发生在 DOM 结构变化时，
// 纯函数测试覆盖不到；这里把「新版封面编辑器」等真实结构固化成夹具，
// 以后改 findCoverDialog 策略或选择器时，跑一遍就知道有没有把老结构改坏。
//
// happy-dom 限制：getBoundingClientRect 恒返回 0，所以用 data-w / data-h 属性驱动打桩，
// 需要尺寸的场景自己标。<style> 里的 display 等能通过 getComputedStyle 读到。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  findButtonByText,
  findExactTextElement,
  findVisibleTextElement,
  findCoverDialog,
} from '../src/content/core/find.js'
import { waitForStable } from '../src/content/core/wait.js'
import { runHealthCheck, renderHealthBanner } from '../src/content/core/healthCheck.js'

beforeEach(() => {
  document.body.innerHTML = ''
  // 尺寸打桩：元素带 data-w / data-h 就按它返回，否则 0（与 happy-dom 默认一致）
  Element.prototype.getBoundingClientRect = function () {
    const w = Number(this.getAttribute('data-w') || 0)
    const h = Number(this.getAttribute('data-h') || 0)
    return { width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON() { return this } }
  }
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

/** 新版「封面制作」编辑器结构（2026-08 版）：外层 bcc-dialog 含 header/body/footer，中间还有一层只带 cover 类的小容器 */
const NEW_COVER_DIALOG = `
  <div class="bcc-dialog" id="cover-dialog">
    <div class="bcc-dialog__header"><span>封面制作</span></div>
    <div class="cover-editor">
      <div class="cover-editor-head"><span>封面制作</span><button class="close">×</button></div>
      <div class="cover-crop-wrap"><img src="blob:http://x/1"></div>
      <div class="bcc-dialog__footer">
        <button class="bcc-button">取消</button>
        <button class="bcc-button bcc-button-primary">完成</button>
      </div>
    </div>
  </div>
`

describe('findExactTextElement / findButtonByText - 文案定位', () => {
  it('按直接文本命中按钮', () => {
    document.body.innerHTML = '<button>立即投稿</button>'
    const el = findButtonByText('立即投稿')
    expect(el).not.toBeNull()
    expect(el.tagName).toBe('BUTTON')
  })

  it('文案带空格也能命中（「完 成」→「完成」）', () => {
    document.body.innerHTML = '<div class="bcc-button"><span>完 成</span></div>'
    expect(findButtonByText('完成')).not.toBeNull()
  })

  it('文案被拆成多个文本节点时仍能命中', () => {
    document.body.innerHTML = '<button class="btn">立<span></span>即投稿</button>'
    // 「立即投稿」被 <span> 打断成两个文本节点，元素级拼接后依然相等
    expect(findExactTextElement('立即投稿')).not.toBeNull()
  })

  it('不命中助手面板内部的同名文案', () => {
    document.body.innerHTML = `
      <div id="bili-helper-panel"><button>完成</button></div>
      <div class="page">无关内容</div>
    `
    expect(findButtonByText('完成')).toBeNull()
  })

  it('重复文案取直接子节点更少的那个（最贴近"按钮本身"）', () => {
    document.body.innerHTML = `
      <div class="outer"><button>完成</button><i></i><i></i></div>
    `
    const el = findExactTextElement('完成')
    expect(el.tagName).toBe('BUTTON')
  })
})

describe('findVisibleTextElement - 按关键词找卡片', () => {
  it('跳过尺寸过小的文本元素，向上取达标的卡片容器', () => {
    document.body.innerHTML = `
      <div class="card" data-w="240" data-h="120">
        <span class="raw-name">2026-10-29 直播回放</span>
      </div>
    `
    // 文本节点所在 span 尺寸 0（未标 data-w）→ 不达标 → 向上到 .card
    const el = findVisibleTextElement('2026-10-29 直播回放')
    expect(el).not.toBeNull()
    expect(el.className).toBe('card')
  })

  it('多个候选时取面积最小的（与原"取最小面积"语义一致）', () => {
    document.body.innerHTML = `
      <div class="big-card" data-w="800" data-h="600">
        <div class="inner-card" data-w="200" data-h="100">
          <span>同一个文件名.mp4</span>
        </div>
      </div>
    `
    const el = findVisibleTextElement('同一个文件名.mp4')
    expect(el.className).toBe('inner-card')
  })

  it('全部不达标时返回 null（不会误返回 body）', () => {
    document.body.innerHTML = '<div><span>不达标文本</span></div>'
    expect(findVisibleTextElement('不达标文本')).toBeNull()
  })
})

describe('findCoverDialog - 新版封面编辑器', () => {
  it('返回含 footer 的最外层 dialog，而不是内部只带 cover 类的小容器', () => {
    document.body.innerHTML = NEW_COVER_DIALOG
    const dialog = findCoverDialog()
    expect(dialog).not.toBeNull()
    expect(dialog.id).toBe('cover-dialog')
    // 关键断言：返回的容器必须包含「完成」按钮所在的 footer
    expect(dialog.querySelector('.bcc-dialog__footer')).not.toBeNull()
    expect(findButtonByText('完成')).not.toBeNull()
  })

  it('弹窗 display:none 时不认（避免把常驻 DOM 的容器当打开状态）', () => {
    document.body.innerHTML = NEW_COVER_DIALOG
    document.getElementById('cover-dialog').style.display = 'none'
    // 策略 0 会跳过不可见容器；其它策略在没有遮罩/弹窗特征时也不该命中新版结构
    expect(findCoverDialog()).toBeNull()
  })

  it('助手面板自己的容器不会被误判为封面弹窗', () => {
    document.body.innerHTML = `
      <div id="bili-helper-panel"><div class="cover-editor-head"><span>封面</span></div></div>
    `
    expect(findCoverDialog()).toBeNull()
  })
})

describe('runHealthCheck - 页面结构自检', () => {
  /** 造一份"结构正常"的投稿编辑页 */
  const FULL_FORM = `
    <input placeholder="请输入标题" />
    <div class="check-radio-v2-container"><span class="check-radio-v2-name">仅自己可见</span></div>
    <div class="el-select"><div class="el-select__wrapper">内容无需标注</div></div>
    <div class="cover-entry"><span>添加封面</span></div>
    <button>立即投稿</button>
  `

  it('结构完整时全部通过', () => {
    document.body.innerHTML = FULL_FORM
    const r = runHealthCheck()
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
  })

  it('缺「立即投稿」时计入 critical（会让本批次必然失败）', () => {
    document.body.innerHTML = FULL_FORM.replace('<button>立即投稿</button>', '')
    const r = runHealthCheck()
    expect(r.ok).toBe(false)
    expect(r.criticalMissing).toContain('「立即投稿」按钮')
  })

  it('缺可见范围只算非关键缺失（有备用方案）', () => {
    document.body.innerHTML = FULL_FORM.replace(/<div class="check-radio-v2-container">[\s\S]*?<\/div><\/div>/, '')
    const r = runHealthCheck()
    expect(r.ok).toBe(false)
    expect(r.missing).toContain('可见范围选择器')
    expect(r.criticalMissing).toEqual([])
  })

  it('缺失项会画到助手面板黄条/红条上', () => {
    document.body.innerHTML = `<div id="bili-helper-panel"><div class="bili-helper-body"></div></div>`
    renderHealthBanner({ ok: false, missing: ['「立即投稿」按钮'], criticalMissing: ['「立即投稿」按钮'] })
    const banner = document.getElementById('bili-helper-health')
    expect(banner).not.toBeNull()
    expect(banner.textContent).toContain('页面结构异常')
    // 恢复后黄条要消失
    renderHealthBanner({ ok: true, missing: [], criticalMissing: [] })
    expect(document.getElementById('bili-helper-health')).toBeNull()
  })
})

describe('waitForStable - DOM 安静即继续', () => {
  it('DOM 无变动时在下限附近返回，不等满上限', async () => {
    document.body.innerHTML = '<div>安静页面</div>'
    const t0 = Date.now()
    await waitForStable({ quietMs: 60, maxMs: 2000, minMs: 40 })
    const cost = Date.now() - t0
    expect(cost).toBeLessThan(600) // 远小于 maxMs 2000，说明没有死等
  })

  it('持续变动时不会超过上限', async () => {
    const t0 = Date.now()
    let i = 0
    const timer = setInterval(() => {
      const d = document.createElement('div')
      d.textContent = `churn-${i++}`
      document.body.appendChild(d)
    }, 20)
    await waitForStable({ quietMs: 100, maxMs: 400, minMs: 50 })
    clearInterval(timer)
    expect(Date.now() - t0).toBeLessThan(900)
  })
})
