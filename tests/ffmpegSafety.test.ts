import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

/**
 * 测试 FFmpeg 安全机制：超时兜底、进程取消、错误处理
 * 对应 src/main/ffmpeg.ts 中的 ffmpegProbe 超时、mergeVideos 超时 kill、cancelMerge
 */

// 创建 mock child process
function createMockChild(): EventEmitter & { kill: ReturnType<typeof vi.fn>; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn>; stderr: EventEmitter }
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

// 让 probe 的 child 立即返回有效数据并关闭
function makeProbeChildResolve(child: EventEmitter & { kill: ReturnType<typeof vi.fn>; stderr: EventEmitter }): void {
  // 模拟 ffmpeg 输出 Duration 信息后立即 close
  setTimeout(() => {
    child.stderr.emit('data', Buffer.from('  Duration: 00:05:00.00, start: 0.000000\n  Stream #0:0: Video: h264, 1920x1080'))
    child.emit('close', 0)
  }, 0)
}

vi.mock('@ffmpeg-installer/ffmpeg', () => ({
  default: { path: '/mock/ffmpeg' }
}))

vi.mock('fluent-ffmpeg', () => {
  const ffmpegFn = vi.fn()
  ;(ffmpegFn as any).setFfmpegPath = vi.fn()
  return { default: ffmpegFn }
})

let spawnCallCount = 0
let latestMergeChild: (EventEmitter & { kill: ReturnType<typeof vi.fn>; stderr: EventEmitter }) | null = null

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    spawnCallCount++
    // 奇数次调用 = ffmpegProbe，偶数次 = mergeVideos 的实际 spawn
    if (spawnCallCount % 2 === 1) {
      // probe child：立即返回数据
      const probeChild = createMockChild()
      makeProbeChildResolve(probeChild)
      return probeChild
    } else {
      // merge child：由测试控制
      const mergeChild = createMockChild()
      latestMergeChild = mergeChild
      return mergeChild
    }
  })
}))

// mock fs 相关函数
vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => false),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 999),
  closeSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 1000000, mtimeMs: Date.now() })),
  copyFileSync: vi.fn()
}))

// 导入被测模块（在 mock 之后）
const { cancelMerge, getActiveMergeTaskId, mergeVideos, getVideoInfo } = await import('../src/main/ffmpeg')
const { spawn } = await import('child_process')

describe('ffmpegProbe 超时兜底', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    spawnCallCount = 0
    // 覆盖 spawn mock：只返回一个不回应的 probe child
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = createMockChild()
      // 不发送任何数据，模拟无响应
      return child
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('spawn 无响应时 10 秒后应 resolve 默认值（duration=0）', async () => {
    const promise = getVideoInfo('/fake/path.flv')

    // 快进 10 秒触发超时
    await vi.advanceTimersByTimeAsync(10500)

    const result = await promise
    expect(result.duration).toBe(0)
    expect(result.codec).toBe('')
    expect(result.width).toBe(0)
    expect(result.height).toBe(0)
  })
})

describe('ffmpegProbe 正常解析', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    spawnCallCount = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('spawn 正常返回 Duration 时应正确解析', async () => {
    const child = createMockChild()
    vi.mocked(spawn).mockReturnValueOnce(child as any)

    const promise = getVideoInfo('/fake/path.flv')

    // 模拟 ffmpeg 输出 Duration 信息
    child.stderr.emit('data', Buffer.from(
      '  Duration: 00:05:00.00, start: 0.000000\n  Stream #0:0: Video: h264, 1920x1080'
    ))
    child.emit('close', 0)

    const result = await promise
    expect(result.duration).toBeCloseTo(300, 0)
  })
})

describe('cancelMerge 取消合并', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    spawnCallCount = 0
    latestMergeChild = null
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('取消不存在的任务应返回 false', () => {
    expect(cancelMerge('non-existent-id')).toBe(false)
  })

  it('取消存在的任务应调用 child.kill 并返回 true', async () => {
    // mergeVideos 是 async，先启动合并
    const mergePromise = mergeVideos(
      ['/fake/file1.flv'],
      '/fake/output.mp4',
      undefined,
      'test-task-1'
    )
    // 立即附加 catch 防止 unhandled rejection
    mergePromise.catch(() => {})

    // 让出执行权，使 async 函数跑到 spawn 调用
    await vi.advanceTimersByTimeAsync(100)

    // 验证 merge child 已创建
    expect(latestMergeChild).not.toBeNull()
    expect(getActiveMergeTaskId()).toBe('test-task-1')

    // 取消合并
    const result = cancelMerge('test-task-1')
    expect(result).toBe(true)
    expect(latestMergeChild!.kill).toHaveBeenCalledWith('SIGTERM')

    // 清理：触发 close
    latestMergeChild!.emit('close', null)
    await vi.advanceTimersByTimeAsync(0)
  })
})

describe('mergeVideos 超时 kill 子进程', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    spawnCallCount = 0
    latestMergeChild = null
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('超时后应调用 child.kill 并 reject', async () => {
    const mergePromise = mergeVideos(
      ['/fake/file1.flv'],
      '/fake/output.mp4',
      undefined,
      'timeout-task'
    )
    // 立即附加 catch 防止 unhandled rejection
    mergePromise.catch(() => {})

    // 让 async 函数跑到 spawn 调用
    await vi.advanceTimersByTimeAsync(100)

    expect(latestMergeChild).not.toBeNull()

    // 快进到 30 分钟超时
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

    // 验证 kill 被调用（SIGTERM 先于 SIGKILL）
    expect(latestMergeChild!.kill).toHaveBeenCalledWith('SIGTERM')

    // 验证 promise 被 reject
    const result = await mergePromise.then(
      () => 'resolved',
      (err) => err.message
    )
    expect(result).toContain('超时')
  })
})
