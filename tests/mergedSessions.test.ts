import { describe, it, expect } from 'vitest'
import {
  parseSessionFromFilePaths,
  upsertMergedSessions,
  removeMergedSessionsByGroup,
  removeMergedSessionsByDateTitle,
  removeMergedSessionsForDeletedMp4,
  hasMergedSessionForGroup,
  isSessionMerged,
  hasLegacyMergedVideo,
  parseMergedFileName,
  type MergedSession
} from '../src/main/mergedFiles'

/** 构建一场记录的时间戳：本地时区的当天时间 */
function ts(date: string, hhmmss: string): number {
  const [h, m, s] = hhmmss.split(':').map(Number)
  return new Date(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`).getTime()
}

describe('parseSessionFromFilePaths', () => {
  it('从单文件路径解析出 date/title/时间区间', () => {
    const s = parseSessionFromFilePaths(['D:/rec/2026-07-12 08-30-00-000 95老阿姨.flv'])
    expect(s).not.toBeNull()
    expect(s!.date).toBe('2026-07-12')
    expect(s!.title).toBe('95老阿姨')
    expect(s!.startTs).toBe(ts('2026-07-12', '08:30:00'))
    expect(s!.endTs).toBe(ts('2026-07-12', '08:30:00'))
  })

  it('多文件取最早最晚时间作为区间（一场直播的多个分段）', () => {
    const s = parseSessionFromFilePaths([
      'D:/rec/2026-07-12 08-30-00-000 95老阿姨.flv',
      'D:/rec/2026-07-12 09-15-00-000 95老阿姨.flv'
    ])
    expect(s!.startTs).toBe(ts('2026-07-12', '08:30:00'))
    expect(s!.endTs).toBe(ts('2026-07-12', '09:15:00'))
  })

  it('兼容 _PART00X 后缀', () => {
    const s = parseSessionFromFilePaths(['D:/rec/2026-07-12 10-00-00-000 某主播_PART001.flv'])
    expect(s!.title).toBe('某主播')
    expect(s!.startTs).toBe(ts('2026-07-12', '10:00:00'))
  })

  it('无法解析的文件返回 null', () => {
    expect(parseSessionFromFilePaths(['D:/rec/random.mp4'])).toBeNull()
    expect(parseSessionFromFilePaths([])).toBeNull()
  })
})

describe('upsertMergedSessions / isSessionMerged', () => {
  const morning: MergedSession = { date: '2026-07-12', title: '95老阿姨', startTs: ts('2026-07-12', '08:00:00'), endTs: ts('2026-07-12', '10:00:00'), mergedAt: 1 }
  const noon: MergedSession = { date: '2026-07-12', title: '95老阿姨', startTs: ts('2026-07-12', '12:00:00'), endTs: ts('2026-07-12', '14:00:00'), mergedAt: 2 }

  it('同一天同一主播的多场直播各自独立记录，互不覆盖', () => {
    const list = upsertMergedSessions([], morning)
    const list2 = upsertMergedSessions(list, noon)
    expect(list2).toHaveLength(2)
  })

  it('同一场重复合并只保留一条记录（区间重叠判定）', () => {
    const list = upsertMergedSessions([], morning)
    const again = upsertMergedSessions(list, { ...morning, mergedAt: 99 })
    expect(again).toHaveLength(1)
  })

  it('已合并的场次命中，同一天的其他场次不命中（核心修复点）', () => {
    const list = upsertMergedSessions(upsertMergedSessions([], morning), noon)
    // 早上场次 → 命中
    expect(isSessionMerged(list, '2026-07-12', '95老阿姨', morning.startTs, morning.endTs)).toBe(true)
    // 中午场次 → 命中
    expect(isSessionMerged(list, '2026-07-12', '95老阿姨', noon.startTs, noon.endTs)).toBe(true)
    // 晚上新场次（区间不重叠）→ 不命中，应显示
    expect(isSessionMerged(list, '2026-07-12', '95老阿姨', ts('2026-07-12', '20:00:00'), ts('2026-07-12', '22:00:00'))).toBe(false)
  })

  it('标题或日期不同不命中', () => {
    const list = upsertMergedSessions([], morning)
    expect(isSessionMerged(list, '2026-07-13', '95老阿姨', morning.startTs, morning.endTs)).toBe(false)
    expect(isSessionMerged(list, '2026-07-12', '另一个人', morning.startTs, morning.endTs)).toBe(false)
  })

  it('时间区间恰好擦边（结束≈开始）在容差内视为同一场', () => {
    const list = upsertMergedSessions([], morning)
    // 与早上场结束时间相差 3 分钟（< 5 分钟容差）→ 命中
    expect(isSessionMerged(list, '2026-07-12', '95老阿姨', ts('2026-07-12', '10:03:00'), ts('2026-07-12', '10:10:00'))).toBe(true)
    // 相差 30 分钟（> 容差）→ 不命中，视为新场次
    expect(isSessionMerged(list, '2026-07-12', '95老阿姨', ts('2026-07-12', '10:30:00'), ts('2026-07-12', '11:00:00'))).toBe(false)
  })
})

describe('removeMergedSessionsByGroup / removeMergedSessionsByDateTitle', () => {
  const morning: MergedSession = { date: '2026-07-12', title: '95老阿姨', startTs: ts('2026-07-12', '08:00:00'), endTs: ts('2026-07-12', '10:00:00'), mergedAt: 1 }
  const noon: MergedSession = { date: '2026-07-12', title: '95老阿姨', startTs: ts('2026-07-12', '12:00:00'), endTs: ts('2026-07-12', '14:00:00'), mergedAt: 2 }

  it('按时间区间精确清理：删早上场次保留中午场次（删除投稿 MP4 场景）', () => {
    const list = upsertMergedSessions(upsertMergedSessions([], morning), noon)
    const next = removeMergedSessionsByGroup(list, morning.date, morning.title, morning.startTs, morning.endTs)
    expect(next).toHaveLength(1)
    expect(next[0].startTs).toBe(noon.startTs)
  })

  it('按日期+标题删除全部记录', () => {
    const list = upsertMergedSessions(upsertMergedSessions([], morning), noon)
    expect(removeMergedSessionsByDateTitle(list, '2026-07-12', '95老阿姨')).toHaveLength(0)
    expect(removeMergedSessionsByDateTitle(list, '2026-07-13', '95老阿姨')).toHaveLength(2)
    expect(removeMergedSessionsByDateTitle(list, '2026-07-12', '另一个人')).toHaveLength(2)
  })
})

describe('removeMergedSessionsForDeletedMp4', () => {
  const morning: MergedSession = { date: '2026-08-03', title: '欢迎大家走进直播间～', startTs: ts('2026-08-03', '10:40:16'), endTs: ts('2026-08-03', '13:40:18'), mergedAt: 1 }
  const evening: MergedSession = { date: '2026-08-03', title: '欢迎大家走进直播间～', startTs: ts('2026-08-03', '22:11:36'), endTs: ts('2026-08-03', '23:41:39'), mergedAt: 2 }

  it('新格式文件名（带场次时间）精确清理该场，保留同一天其他场次', () => {
    const list = upsertMergedSessions(upsertMergedSessions([], morning), evening)
    const next = removeMergedSessionsForDeletedMp4(list, '欢迎大家走进直播间～_2026-08-03_221136.mp4')
    expect(next).toHaveLength(1)
    expect(next[0].startTs).toBe(morning.startTs)
  })

  it('旧格式文件名无法精确到时次 → 回退按日期+标题全清', () => {
    const list = upsertMergedSessions(upsertMergedSessions([], morning), evening)
    expect(removeMergedSessionsForDeletedMp4(list, '2026-08-03_欢迎大家走进直播间～_2026-08-03_151857_合并版.mp4')).toHaveLength(0)
  })

  it('无法解析的文件名不清理', () => {
    const list = upsertMergedSessions([], morning)
    expect(removeMergedSessionsForDeletedMp4(list, 'random.mp4')).toHaveLength(1)
  })
})

describe('parseMergedFileName', () => {
  it('新格式：标题_日期.mp4', () => {
    expect(parseMergedFileName('95老阿姨_2026-07-12.mp4')).toEqual({ date: '2026-07-12', title: '95老阿姨' })
  })

  it('新格式：标题含下划线也能完整解析', () => {
    expect(parseMergedFileName('主播_名字_2026-07-12.mp4')).toEqual({ date: '2026-07-12', title: '主播_名字' })
  })

  it('新格式带场次开始时间也能解析', () => {
    expect(parseMergedFileName('欢迎大家走进直播间～_2026-08-03_104016.mp4')).toEqual({ date: '2026-08-03', title: '欢迎大家走进直播间～' })
    expect(parseMergedFileName('主播_名字_2026-07-12_221136.mp4')).toEqual({ date: '2026-07-12', title: '主播_名字' })
  })

  it('旧格式：日期_标题_合并日期_时间_合并版.mp4', () => {
    expect(parseMergedFileName('2026-07-12_95老阿姨_2026-07-12_083000_合并版.mp4')).toEqual({ date: '2026-07-12', title: '95老阿姨' })
  })

  it('旧格式：标题含下划线也能完整解析（不截断）', () => {
    expect(parseMergedFileName('2026-07-12_主播_名字_2026-07-12_083000_合并版.mp4')).toEqual({ date: '2026-07-12', title: '主播_名字' })
  })

  it('无法识别返回空值', () => {
    expect(parseMergedFileName('random.mp4')).toEqual({ date: '', title: '' })
  })
})

describe('hasMergedSessionForGroup', () => {
  it('存在该 (日期,标题) 的记录则返回 true', () => {
    const s: MergedSession = { date: '2026-07-12', title: '95老阿姨', startTs: 1, endTs: 2, mergedAt: 1 }
    expect(hasMergedSessionForGroup([s], '2026-07-12', '95老阿姨')).toBe(true)
    expect(hasMergedSessionForGroup([s], '2026-07-12', '别人')).toBe(false)
  })
})

describe('hasLegacyMergedVideo（升级前旧数据兜底）', () => {
  const set = new Set(['2026-07-12_95老阿姨_2026-07-12_083000_合并版.mp4'])

  it('旧格式：日期开头 + 包含标题 → 命中', () => {
    expect(hasLegacyMergedVideo('2026-07-12', '95老阿姨', set)).toBe(true)
  })

  it('新格式（标题_日期.mp4）不走 legacy 粗匹配 → 不命中（合并时已写入场次记录）', () => {
    const s = new Set(['95老阿姨_2026-07-12.mp4'])
    expect(hasLegacyMergedVideo('2026-07-12', '95老阿姨', s)).toBe(false)
  })

  it('同一天其他主播 / 其他日期不命中', () => {
    expect(hasLegacyMergedVideo('2026-07-12', '另一个人', set)).toBe(false)
    expect(hasLegacyMergedVideo('2026-07-13', '95老阿姨', set)).toBe(false)
  })
})
