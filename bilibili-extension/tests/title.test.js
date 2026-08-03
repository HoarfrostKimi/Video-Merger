// tests/title.test.js - 标题解析纯函数单测
import { describe, it, expect } from 'vitest'
import { parseTitle, cleanTitle } from '../src/content/core/title.js'

describe('parseTitle - 投稿标题解析', () => {
  it('前置日期保留并前置，去合并版后缀', () => {
    expect(parseTitle('2026-07-17_我的视频_合并版.mp4')).toBe('2026-07-17 我的视频')
  })
  it('后置日期统一为前置格式', () => {
    expect(parseTitle('我的视频_2026-07-17.mp4')).toBe('2026-07-17 我的视频')
  })
  it('日期分隔符为下划线/空格也能识别', () => {
    expect(parseTitle('2026_07_17 我的视频.mp4')).toBe('2026-07-17 我的视频')
  })
  it('日期后无分隔符也能识别', () => {
    expect(parseTitle('2026-07-17我的视频.mp4')).toBe('2026-07-17 我的视频')
  })
  it('无日期文件名不补日期', () => {
    expect(parseTitle('我的视频.mp4')).toBe('我的视频')
  })
  it('前后都有日期只保留一个', () => {
    expect(parseTitle('2026-07-17_我的视频_2026-07-17.mp4')).toBe('2026-07-17 我的视频')
  })
  it('日期+合并版组合不残留日期', () => {
    expect(parseTitle('我的视频_2026-07-17_合并版.mp4')).toBe('2026-07-17 我的视频')
  })
  it('纯日期_合并版不拼重复日期', () => {
    expect(parseTitle('2026-07-17_合并版.mp4')).toBe('2026-07-17_合并版')
  })
})

describe('cleanTitle - 内部定位关键词', () => {
  it('去日期与合并版后缀', () => {
    expect(cleanTitle('2026-07-17_我的视频_合并版.mp4')).toBe('我的视频')
  })
  it('高清版等普通后缀不误删', () => {
    expect(cleanTitle('我的视频高清版.mp4')).toBe('我的视频高清版')
  })
  it('无日期文件名原样返回', () => {
    expect(cleanTitle('我的视频.mp4')).toBe('我的视频')
  })
})
