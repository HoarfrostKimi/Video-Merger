import { describe, it, expect } from 'vitest'

/**
 * 测试配置管理逻辑
 * 对应 src/main/index.ts 中的 loadConfig / saveConfig 合并逻辑
 */

describe('配置合并逻辑', () => {
  function mergeConfig(current: Record<string, any>, incoming: Record<string, any>): Record<string, any> {
    return { ...current, ...incoming }
  }

  it('全新配置 - 应直接使用传入的配置', () => {
    const current = {}
    const incoming = { inputFolder: '/videos', outputFolder: '/output' }
    const result = mergeConfig(current, incoming)
    expect(result).toEqual({ inputFolder: '/videos', outputFolder: '/output' })
  })

  it('部分更新 - 应保留旧配置中未更新的字段', () => {
    const current = { inputFolder: '/old', outputFolder: '/output', outputFileName: 'merged' }
    const incoming = { inputFolder: '/new' }
    const result = mergeConfig(current, incoming)
    expect(result).toEqual({ inputFolder: '/new', outputFolder: '/output', outputFileName: 'merged' })
  })

  it('完全覆盖 - 新值应替换旧值', () => {
    const current = { inputFolder: '/old' }
    const incoming = { inputFolder: '/new' }
    expect(mergeConfig(current, incoming).inputFolder).toBe('/new')
  })

  it('空配置更新 - 应保留所有旧配置', () => {
    const current = { inputFolder: '/videos' }
    const incoming = {}
    expect(mergeConfig(current, incoming)).toEqual({ inputFolder: '/videos' })
  })

  it('可以将字段设为 undefined 来"清除"', () => {
    const current = { inputFolder: '/videos', outputFolder: '/output' }
    const incoming = { inputFolder: undefined }
    const result = mergeConfig(current, incoming)
    expect(result.inputFolder).toBeUndefined()
    expect(result.outputFolder).toBe('/output')
  })
})

describe('已合并视频检测逻辑', () => {
  /**
   * 对应 src/main/index.ts 中的 hasMergedVideo 判断逻辑
   * 通过文件名中是否包含日期和标题来判断是否已存在合并后的视频
   */
  function isAlreadyMerged(mp4FileName: string, date: string, title: string): boolean {
    const entryLower = mp4FileName.toLowerCase()
    const dateLower = date.toLowerCase()
    const titleLower = title.toLowerCase()
    return entryLower.includes(dateLower) && entryLower.includes(titleLower)
  }

  it('文件名包含日期和标题 - 应判定为已合并', () => {
    expect(isAlreadyMerged('2024-06-15 英雄联盟直播.mp4', '2024-06-15', '英雄联盟直播')).toBe(true)
  })

  it('大小写不敏感匹配', () => {
    expect(isAlreadyMerged('2024-06-15 LOL直播.mp4', '2024-06-15', 'LOL直播')).toBe(true)
  })

  it('只有日期没有标题 - 不应判定为已合并', () => {
    expect(isAlreadyMerged('2024-06-15.mp4', '2024-06-15', '英雄联盟直播')).toBe(false)
  })

  it('只有标题没有日期 - 不应判定为已合并', () => {
    expect(isAlreadyMerged('英雄联盟直播.mp4', '2024-06-15', '英雄联盟直播')).toBe(false)
  })

  it('完全不同的文件名 - 不应判定为已合并', () => {
    expect(isAlreadyMerged('random_video.mp4', '2024-06-15', '英雄联盟直播')).toBe(false)
  })

  it('中文标题匹配', () => {
    expect(isAlreadyMerged('2024-12-25 圣诞节特别直播.mp4', '2024-12-25', '圣诞节特别直播')).toBe(true)
  })
})

describe('文件路径转义逻辑', () => {
  /**
   * 对应 src/main/ffmpeg.ts 中生成 concat 列表文件时的路径转义
   * 单引号需要转义为 '\''
   */
  function escapeFilePath(filePath: string): string {
    return `file '${filePath.replace(/'/g, "'\\''")}'`
  }

  it('普通路径 - 无需转义', () => {
    expect(escapeFilePath('D:/videos/test.flv')).toBe("file 'D:/videos/test.flv'")
  })

  it('路径包含单引号 - 应正确转义', () => {
    expect(escapeFilePath("D:/my'videos/test.flv")).toBe("file 'D:/my'\\''videos/test.flv'")
  })

  it('路径包含中文 - 无需转义', () => {
    expect(escapeFilePath('D:/视频/测试.flv')).toBe("file 'D:/视频/测试.flv'")
  })

  it('路径包含空格 - 无需额外转义（已在引号内）', () => {
    expect(escapeFilePath('D:/my videos/test.flv')).toBe("file 'D:/my videos/test.flv'")
  })
})
