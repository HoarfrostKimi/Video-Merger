import { describe, it, expect } from 'vitest'

/**
 * 测试合并互斥锁
 * 对应 src/main/index.ts 中的 isMerging / getIsMerging / setIsMerging
 * 防止桌面端和手机端同时触发合并操作
 */

describe('合并互斥锁', () => {
  /**
   * 模拟 index.ts 中的合并锁逻辑
   */
  function createMergeLock() {
    let isMerging = false
    return {
      getIsMerging: () => isMerging,
      setIsMerging: (value: boolean) => { isMerging = value }
    }
  }

  it('初始状态应为 false（未在合并中）', () => {
    const lock = createMergeLock()
    expect(lock.getIsMerging()).toBe(false)
  })

  it('setIsMerging(true) 后应返回 true', () => {
    const lock = createMergeLock()
    lock.setIsMerging(true)
    expect(lock.getIsMerging()).toBe(true)
  })

  it('setIsMerging(false) 后应返回 false', () => {
    const lock = createMergeLock()
    lock.setIsMerging(true)
    lock.setIsMerging(false)
    expect(lock.getIsMerging()).toBe(false)
  })

  it('合并锁应支持多次切换', () => {
    const lock = createMergeLock()
    lock.setIsMerging(true)
    expect(lock.getIsMerging()).toBe(true)
    lock.setIsMerging(false)
    expect(lock.getIsMerging()).toBe(false)
    lock.setIsMerging(true)
    expect(lock.getIsMerging()).toBe(true)
  })

  it('不同锁实例应相互独立', () => {
    const lock1 = createMergeLock()
    const lock2 = createMergeLock()
    lock1.setIsMerging(true)
    expect(lock1.getIsMerging()).toBe(true)
    expect(lock2.getIsMerging()).toBe(false)
  })

  it('合并前检查锁可防止重复合并', () => {
    const lock = createMergeLock()

    function tryMerge(): boolean {
      if (lock.getIsMerging()) return false
      lock.setIsMerging(true)
      return true
    }

    // 第一次合并应成功
    expect(tryMerge()).toBe(true)
    // 第二次合并应被拒绝
    expect(tryMerge()).toBe(false)
    // 释放锁后再次合并应成功
    lock.setIsMerging(false)
    expect(tryMerge()).toBe(true)
  })
})
