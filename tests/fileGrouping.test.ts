import { describe, it, expect } from 'vitest'

/**
 * 测试文件分组逻辑
 * 对应 src/main/index.ts 中 scan:flvFiles 的分组算法
 * 按标题和时间间隔将 FLV 文件归为同一组（同一场直播）
 */

interface FileInfo {
  name: string
  path: string
  size: number
  date: string
  time: string
  title: string
  timestamp: number
}

interface Group {
  key: string
  folderName: string
  fileCount: number
  totalSize: number
  date: string
  title: string
}

function groupFiles(files: FileInfo[], maxIntervalHours: number = 2.5): Group[] {
  const groups: Group[] = []
  if (files.length === 0) return groups

  let currentGroup: Group & { lastTimestamp: number } | null = null
  const MAX_INTERVAL_MS = maxIntervalHours * 60 * 60 * 1000

  for (const file of files) {
    if (!currentGroup) {
      currentGroup = {
        key: `${file.date}_${file.title}`,
        folderName: `${file.date} ${file.title}`,
        fileCount: 1,
        totalSize: file.size,
        date: file.date,
        title: file.title,
        lastTimestamp: file.timestamp
      }
    } else {
      const interval = file.timestamp - currentGroup.lastTimestamp
      if (file.title === currentGroup.title && interval <= MAX_INTERVAL_MS) {
        currentGroup.fileCount++
        currentGroup.totalSize += file.size
        currentGroup.lastTimestamp = file.timestamp
      } else {
        groups.push(currentGroup)
        currentGroup = {
          key: `${file.date}_${file.title}`,
          folderName: `${file.date} ${file.title}`,
          fileCount: 1,
          totalSize: file.size,
          date: file.date,
          title: file.title,
          lastTimestamp: file.timestamp
        }
      }
    }
  }
  if (currentGroup) groups.push(currentGroup)
  return groups
}

function makeFile(overrides: Partial<FileInfo>): FileInfo {
  return {
    name: 'test.flv',
    path: '/test/test.flv',
    size: 1000,
    date: '2024-01-01',
    time: '12-00-00-000',
    title: '直播',
    timestamp: new Date('2024-01-01T12:00:00').getTime(),
    ...overrides
  }
}

describe('文件分组逻辑', () => {
  it('空文件列表 - 应返回空分组', () => {
    expect(groupFiles([])).toEqual([])
  })

  it('单个文件 - 应创建一个分组', () => {
    const files = [makeFile({ title: '英雄联盟直播', date: '2024-06-15' })]
    const groups = groupFiles(files)
    expect(groups).toHaveLength(1)
    expect(groups[0].title).toBe('英雄联盟直播')
    expect(groups[0].fileCount).toBe(1)
  })

  it('相同标题、时间间隔在阈值内 - 应合并为一组', () => {
    const baseTime = new Date('2024-01-01T12:00:00').getTime()
    const files = [
      makeFile({ title: '直播', timestamp: baseTime }),
      makeFile({ title: '直播', timestamp: baseTime + 60 * 60 * 1000 }), // 1小时后
      makeFile({ title: '直播', timestamp: baseTime + 2 * 60 * 60 * 1000 }) // 2小时后
    ]
    const groups = groupFiles(files)
    expect(groups).toHaveLength(1)
    expect(groups[0].fileCount).toBe(3)
  })

  it('相同标题、时间间隔超过阈值 - 应分为两组', () => {
    const baseTime = new Date('2024-01-01T12:00:00').getTime()
    const files = [
      makeFile({ title: '直播', timestamp: baseTime }),
      makeFile({ title: '直播', timestamp: baseTime + 3 * 60 * 60 * 1000 }) // 3小时后，超过2.5小时
    ]
    const groups = groupFiles(files)
    expect(groups).toHaveLength(2)
    expect(groups[0].fileCount).toBe(1)
    expect(groups[1].fileCount).toBe(1)
  })

  it('不同标题 - 即使时间相近也应分为不同组', () => {
    const baseTime = new Date('2024-01-01T12:00:00').getTime()
    const files = [
      makeFile({ title: '英雄联盟', timestamp: baseTime }),
      makeFile({ title: '绝地求生', timestamp: baseTime + 1000 }) // 几乎同时
    ]
    const groups = groupFiles(files)
    expect(groups).toHaveLength(2)
  })

  it('自定义时间间隔阈值', () => {
    const baseTime = new Date('2024-01-01T12:00:00').getTime()
    const files = [
      makeFile({ title: '直播', timestamp: baseTime }),
      makeFile({ title: '直播', timestamp: baseTime + 30 * 60 * 1000 }) // 30分钟后
    ]
    // 阈值设为 0.25 小时（15分钟），30分钟应分为两组
    const groups = groupFiles(files, 0.25)
    expect(groups).toHaveLength(2)
  })

  it('分组总大小应正确累加', () => {
    const baseTime = new Date('2024-01-01T12:00:00').getTime()
    const files = [
      makeFile({ title: '直播', timestamp: baseTime, size: 1000 }),
      makeFile({ title: '直播', timestamp: baseTime + 60 * 60 * 1000, size: 2000 }),
      makeFile({ title: '直播', timestamp: baseTime + 2 * 60 * 60 * 1000, size: 3000 })
    ]
    const groups = groupFiles(files)
    expect(groups[0].totalSize).toBe(6000)
  })

  it('混合场景 - 多场直播交错', () => {
    const t1 = new Date('2024-01-01T10:00:00').getTime()
    const t2 = new Date('2024-01-01T14:00:00').getTime()
    const files = [
      makeFile({ title: '早间直播', timestamp: t1 }),
      makeFile({ title: '早间直播', timestamp: t1 + 30 * 60 * 1000 }),
      makeFile({ title: '晚间直播', timestamp: t2 }),
      makeFile({ title: '晚间直播', timestamp: t2 + 45 * 60 * 1000 }),
      makeFile({ title: '晚间直播', timestamp: t2 + 90 * 60 * 1000 })
    ]
    const groups = groupFiles(files)
    expect(groups).toHaveLength(2)
    expect(groups[0].title).toBe('早间直播')
    expect(groups[0].fileCount).toBe(2)
    expect(groups[1].title).toBe('晚间直播')
    expect(groups[1].fileCount).toBe(3)
  })
})
