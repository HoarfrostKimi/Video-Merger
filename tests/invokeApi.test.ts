import { describe, it, expect } from 'vitest'

/**
 * 测试 preload 中的 invokeApi 逻辑
 * 该函数负责统一处理 IPC 返回结果：成功时返回 data，失败时抛出错误
 */

interface IpcResult {
  success: boolean
  data?: any
  message?: string
}

function invokeApi(result: IpcResult): any {
  if (result && typeof result === 'object' && 'success' in result) {
    if (!result.success) {
      throw new Error(result.message || '操作失败')
    }
    return result.data
  }
  return result
}

describe('IPC 结果解包逻辑', () => {
  it('成功结果 - 应返回 data 字段', () => {
    const result = { success: true, data: { folder: '/test/path' } }
    expect(invokeApi(result)).toEqual({ folder: '/test/path' })
  })

  it('成功但 data 为 undefined - 应返回 undefined', () => {
    const result = { success: true }
    expect(invokeApi(result)).toBeUndefined()
  })

  it('成功且 data 为 null - 应返回 null', () => {
    const result = { success: true, data: null }
    expect(invokeApi(result)).toBeNull()
  })

  it('失败结果 - 应抛出错误并包含错误信息', () => {
    const result = { success: false, message: '文件不存在' }
    expect(() => invokeApi(result)).toThrow('文件不存在')
  })

  it('失败但没有 message - 应抛出默认错误信息', () => {
    const result = { success: false }
    expect(() => invokeApi(result)).toThrow('操作失败')
  })

  it('成功且 data 为空字符串 - 应返回空字符串', () => {
    const result = { success: true, data: '' }
    expect(invokeApi(result)).toBe('')
  })

  it('成功且 data 为数字 0 - 应返回 0', () => {
    const result = { success: true, data: 0 }
    expect(invokeApi(result)).toBe(0)
  })

  it('非标准返回格式（无 success 字段）- 应原样返回', () => {
    const result = { someField: 'value' }
    expect(invokeApi(result as any)).toEqual({ someField: 'value' })
  })

  it('成功且 data 为数组 - 应正确返回数组', () => {
    const result = { success: true, data: [1, 2, 3] }
    expect(invokeApi(result)).toEqual([1, 2, 3])
  })
})
