// tests/find.test.js - 文本归一化纯函数单测（find.js 其余函数依赖 DOM，不在 node 环境测）
import { describe, it, expect } from 'vitest'
import { normalizeText } from '../src/content/core/find.js'

describe('normalizeText - 按钮文案归一化', () => {
  it('去掉文案中的空格（「确 定」→「确定」）', () => {
    expect(normalizeText('确 定')).toBe('确定')
  })
  it('去掉换行、制表符与首尾空白', () => {
    expect(normalizeText('  完成\n\t ')).toBe('完成')
  })
  it('空字符串与空值安全', () => {
    expect(normalizeText('')).toBe('')
    expect(normalizeText(undefined)).toBe('')
    expect(normalizeText(null)).toBe('')
  })
  it('无空白文本原样返回', () => {
    expect(normalizeText('立即投稿')).toBe('立即投稿')
  })
})
