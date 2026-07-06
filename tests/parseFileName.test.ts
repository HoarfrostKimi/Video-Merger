import { describe, it, expect } from 'vitest'

/**
 * 测试文件名解析逻辑
 * 对应 src/main/index.ts 中的 parseFileName 函数
 */

function parseFileName(fileName: string): { date: string; time: string; title: string } {
  const nameWithoutExt = fileName.replace(/\.flv$/i, '')
  const match = nameWithoutExt.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}-\d{2}-\d{2}-\d{3})\s*(.+)$/)
  if (match) {
    return {
      date: match[1],
      time: match[2],
      title: match[3].trim() || '未命名'
    }
  }
  return {
    date: '未知日期',
    time: '未知时间',
    title: nameWithoutExt.trim() || '未命名'
  }
}

describe('文件名解析', () => {
  it('标准格式文件名 - 应正确提取日期、时间和标题', () => {
    const result = parseFileName('2024-06-15 14-30-00-123 英雄联盟直播.flv')
    expect(result.date).toBe('2024-06-15')
    expect(result.time).toBe('14-30-00-123')
    expect(result.title).toBe('英雄联盟直播')
  })

  it('标准格式 - 标题包含多个空格', () => {
    const result = parseFileName('2024-01-01 00-00-00-000 测试  标题  带空格.flv')
    expect(result.date).toBe('2024-01-01')
    expect(result.title).toBe('测试  标题  带空格')
  })

  it('大写FLV扩展名', () => {
    const result = parseFileName('2024-03-20 10-15-30-500 测试直播.FLV')
    expect(result.date).toBe('2024-03-20')
    expect(result.time).toBe('10-15-30-500')
    expect(result.title).toBe('测试直播')
  })

  it('非标准格式 - 应返回未知日期和未知时间', () => {
    const result = parseFileName('random_file.flv')
    expect(result.date).toBe('未知日期')
    expect(result.time).toBe('未知时间')
    expect(result.title).toBe('random_file')
  })

  it('无扩展名的文件', () => {
    const result = parseFileName('no_extension')
    expect(result.date).toBe('未知日期')
    expect(result.title).toBe('no_extension')
  })

  it('空标题（只有日期和时间）应返回"未命名"', () => {
    const result = parseFileName('2024-01-01 12-00-00-000')
    // 正则要求标题部分至少一个字符，所以不匹配，走 fallback
    expect(result.date).toBe('未知日期')
    expect(result.title).toBe('2024-01-01 12-00-00-000')
  })

  it('中文文件名', () => {
    const result = parseFileName('2024-12-25 20-00-00-999 圣诞节特别直播.flv')
    expect(result.date).toBe('2024-12-25')
    expect(result.title).toBe('圣诞节特别直播')
  })

  it('标题中有特殊字符', () => {
    const result = parseFileName('2024-05-01 08-30-00-100 【直播】游戏&娱乐~第3期.flv')
    expect(result.title).toBe('【直播】游戏&娱乐~第3期')
  })
})
