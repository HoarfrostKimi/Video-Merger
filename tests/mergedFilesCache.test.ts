import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * 测试 mergedFiles 模块的缓存机制
 * 对应 src/main/mergedFiles.ts 中的 scanCache、invalidateCache、scanFolder
 */

// mock fs 模块
const mockReaddirSync = vi.fn()
const mockStatSync = vi.fn()
const mockExistsSync = vi.fn()

vi.mock('fs', () => ({
  readdirSync: (...args: any[]) => mockReaddirSync(...args),
  statSync: (...args: any[]) => mockStatSync(...args),
  existsSync: (...args: any[]) => mockExistsSync(...args)
}))

// 导入被测模块
const { scanFolder, invalidateCache } = await import('../src/main/mergedFiles')

describe('mergedFiles 缓存 TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    // 每次测试前使缓存失效，确保测试隔离
    invalidateCache()
    // 默认 mock：目录存在
    mockExistsSync.mockReturnValue(true)
    // 默认 mock：目录中有一个 MP4 文件
    mockReaddirSync.mockReturnValue(['test.mp4'])
    mockStatSync.mockReturnValue({ mtimeMs: 1000000 })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('首次 scanFolder 应触发 readdirSync', () => {
    scanFolder('/output')
    expect(mockReaddirSync).toHaveBeenCalledTimes(1)
  })

  it('连续两次 scanFolder 第二次应命中缓存（不触发新的 readdir）', () => {
    scanFolder('/output')
    expect(mockReaddirSync).toHaveBeenCalledTimes(1)

    // 第二次调用应在 TTL 内命中缓存
    scanFolder('/output')
    expect(mockReaddirSync).toHaveBeenCalledTimes(1) // 仍然是 1 次
  })

  it('invalidateCache 后下次 scanFolder 应重新扫描', () => {
    scanFolder('/output')
    expect(mockReaddirSync).toHaveBeenCalledTimes(1)

    // 使缓存失效
    invalidateCache()
    scanFolder('/output')
    expect(mockReaddirSync).toHaveBeenCalledTimes(2)
  })

  it('缓存 TTL 过期后应重新扫描', () => {
    scanFolder('/output')
    expect(mockReaddirSync).toHaveBeenCalledTimes(1)

    // 快进 13 秒（超过 12 秒 TTL）
    vi.advanceTimersByTime(13000)

    scanFolder('/output')
    expect(mockReaddirSync).toHaveBeenCalledTimes(2)
  })

  it('不同路径应独立缓存', () => {
    scanFolder('/output1')
    expect(mockReaddirSync).toHaveBeenCalledTimes(1)

    scanFolder('/output2')
    expect(mockReaddirSync).toHaveBeenCalledTimes(2)

    // 再次访问 output1 应命中缓存
    scanFolder('/output1')
    expect(mockReaddirSync).toHaveBeenCalledTimes(2) // 不变
  })

  it('scanFolder 应只返回 .mp4 文件', () => {
    mockReaddirSync.mockReturnValue(['video1.mp4', 'video2.flv', 'readme.txt', 'video3.MP4'])
    invalidateCache()

    const result = scanFolder('/output')
    // 应包含 video1.mp4 和 video3.MP4（不区分大小写）
    const names = result.map(f => f.name)
    expect(names).toContain('video1.mp4')
    expect(names).toContain('video3.MP4')
    expect(names).not.toContain('video2.flv')
    expect(names).not.toContain('readme.txt')
  })

  it('路径不存在时应返回空数组', () => {
    mockExistsSync.mockReturnValue(false)
    invalidateCache()

    const result = scanFolder('/nonexistent')
    expect(result).toEqual([])
  })
})
