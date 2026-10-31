// mergedFiles.ts - 扫描输出文件夹中的 MP4 文件
// 供 controlServer.ts（手机端）和 index.ts（桌面端 IPC）共同使用

import { basename, join } from 'path'
import { readdirSync, statSync, existsSync } from 'fs'

export interface MergedFile {
  index: number
  name: string
  path: string
  mtime: number
}

/**
 * 已合并的直播场次记录（方案 A：精确到「某一天某主播的某一场」）。
 * 解决同一主播同一天多场直播时，旧逻辑仅按「日期+标题」粗匹配导致
 * 后续场次被误判为已合并而隐藏的问题。
 */
export interface MergedSession {
  /** 直播日期（如 2026-07-12） */
  date: string
  /** 主播标题（从分段文件名解析） */
  title: string
  /** 该场直播开始时间戳（组内最早分段文件时间） */
  startTs: number
  /** 该场直播结束时间戳（组内最晚分段文件时间） */
  endTs: number
  /** 合并操作时间戳 */
  mergedAt: number
}

/** 场次区间判重/容差：5 分钟（防御同名文件时间戳微小差异） */
const SESSION_TOLERANCE_MS = 5 * 60 * 1000

const VIDEO_EXT_RE = /\.(flv|m4s|blv)$/i

/**
 * 从分段文件路径列表解析出一场直播的 date/title/时间区间。
 * 与 performScan 的文件名解析规则一致（兼容 _PART00X 后缀）。
 */
export function parseSessionFromFilePaths(filePaths: string[]): MergedSession | null {
  let date = ''
  let title = ''
  const timestamps: number[] = []
  for (const p of filePaths) {
    const base = basename(p).replace(VIDEO_EXT_RE, '').replace(/_PART\d+$/i, '')
    const match = base.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}-\d{2}-\d{2}-\d{3})\s*(.+)$/)
    if (!match) continue
    const d = match[1]
    const t = match[2]
    const ti = match[3].trim() || '未命名'
    const parts = t.split('-')
    const ts = new Date(`${d}T${parts[0]}:${parts[1]}:${parts[2]}`).getTime()
    if (Number.isNaN(ts)) continue
    if (!date) {
      date = d
      title = ti
    }
    timestamps.push(ts)
  }
  if (!date || timestamps.length === 0) return null
  return {
    date,
    title,
    startTs: Math.min(...timestamps),
    endTs: Math.max(...timestamps),
    mergedAt: Date.now()
  }
}

/** 追加/更新一条已合并场次记录：先移除同 (date,title) 且时间区间重叠的旧记录，再追加 */
export function upsertMergedSessions(list: MergedSession[], session: MergedSession): MergedSession[] {
  const next = list.filter(
    (s) =>
      !(
        s.date === session.date &&
        s.title === session.title &&
        s.startTs <= session.endTs + SESSION_TOLERANCE_MS &&
        session.startTs <= s.endTs + SESSION_TOLERANCE_MS
      )
  )
  next.push(session)
  return next
}

/** 删除 (date,title) 相同且时间区间重叠的记录（删除某一场时精确清理，保留同一天其他场次） */
export function removeMergedSessionsByGroup(
  list: MergedSession[],
  date: string,
  title: string,
  startTs: number,
  endTs: number
): MergedSession[] {
  return list.filter(
    (s) =>
      !(
        s.date === date &&
        s.title === title &&
        s.startTs <= endTs + SESSION_TOLERANCE_MS &&
        startTs <= s.endTs + SESSION_TOLERANCE_MS
      )
  )
}

/** 删除 (date,title) 完全相同的所有记录（删除已合并 MP4 / 删除分组时清理） */
export function removeMergedSessionsByDateTitle(list: MergedSession[], date: string, title: string): MergedSession[] {
  return list.filter((s) => !(s.date === date && s.title === title))
}

/**
 * 删除合并 MP4 后清理对应场次的已合并记录。
 * 新格式文件名（标题_日期_HHMMSS.mp4）带场次开始时间，可精确清理该场，保留同一天其他场次；
 * 精确清理未命中（如文件名被手动修改）时回退按 (日期,标题) 清理（剩余场次由 legacy 兜底继续隐藏）。
 */
export function removeMergedSessionsForDeletedMp4(list: MergedSession[], fileName: string): MergedSession[] {
  const { date, title } = parseMergedFileName(fileName)
  if (!date || !title) return list
  const m = fileName.match(/^.+?_(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})\.mp4$/i)
  let next = list
  if (m) {
    const startTs = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`).getTime()
    if (!Number.isNaN(startTs)) {
      next = removeMergedSessionsByGroup(list, date, title, startTs, startTs + 60_000)
    }
  }
  if (next.length === list.length) {
    next = removeMergedSessionsByDateTitle(list, date, title)
  }
  return next
}

/** 该 (date,title) 是否已有任何场次记录（用于判断是否启用精确匹配） */
export function hasMergedSessionForGroup(sessions: MergedSession[], date: string, title: string): boolean {
  return sessions.some((s) => s.date === date && s.title === title)
}

/** 精确匹配：该场次（时间区间）是否已被合并过 */
export function isSessionMerged(
  sessions: MergedSession[],
  date: string,
  title: string,
  startTs: number,
  endTs: number,
  toleranceMs: number = SESSION_TOLERANCE_MS
): boolean {
  return sessions.some(
    (s) =>
      s.date === date &&
      s.title === title &&
      s.startTs <= endTs + toleranceMs &&
      startTs <= s.endTs + toleranceMs
  )
}

/** 从合并 MP4 文件名解析直播日期和标题（兼容新旧两种命名格式） */
export function parseMergedFileName(fileName: string): { date: string; title: string } {
  // 新格式：95老阿姨_2026-07-12.mp4 或 95老阿姨_2026-07-12_104016.mp4（带场次开始时间）
  const m1 = fileName.match(/^(.+?)_(\d{4}-\d{2}-\d{2})(?:_\d{6})?\.mp4$/i)
  if (m1) return { date: m1[2], title: m1[1] }
  // 旧格式：2026-07-12_95老阿姨_2026-07-12_083000_合并版.mp4 → 日期_标题
  // 标题贪婪匹配（可含下划线），用合并日期+时间+后缀做尾部锚定
  const m2 = fileName.match(/^(\d{4}-\d{2}-\d{2})_(.+)_(\d{4}-\d{2}-\d{2})_\d{6}_合并版\.mp4$/)
  if (m2) return { date: m2[1], title: m2[2] }
  return { date: '', title: '' }
}

/**
 * 旧逻辑兜底：仅按「日期开头 + 包含标题」粗匹配已合并 MP4 文件名。
 * 仅用于 mergedSessions 中完全没有该 (date,title) 记录的情况（升级前合并的旧数据），
 * 避免升级后旧场次突然全部重新出现。
 *
 * 注意：只匹配旧格式（…_合并版.mp4）。新格式（标题_日期[_HHMMSS].mp4）合并时
 * 必定写入 mergedSessions，不该走粗匹配——否则删除某场分段后，同一天其他未合并
 * 场次会被残留的新格式 MP4 误隐藏。
 */
export function hasLegacyMergedVideo(date: string, title: string, mergedFileNames: Set<string>): boolean {
  const dateLower = date.toLowerCase()
  const titleLower = title.toLowerCase()
  for (const entry of mergedFileNames) {
    const entryLower = entry.toLowerCase()
    // 旧格式：2026-07-12_95老阿姨_..._合并版.mp4 → 日期开头 + 包含标题，且以 _合并版.mp4 结尾
    if (
      entryLower.endsWith('_合并版.mp4') &&
      entryLower.startsWith(dateLower) &&
      entryLower.includes(titleLower)
    ) {
      return true
    }
  }
  return false
}

/** 缓存 TTL：12 秒（状态轮询精度无需很高） */
const MERGED_FILES_CACHE_TTL = 12_000

interface CacheEntry {
  data: MergedFile[]
  timestamp: number
}

/** scanFolder 结果缓存，按 folderPath 索引 */
const scanCache = new Map<string, CacheEntry>()

/** 标记缓存是否需要强制刷新 */
let cacheInvalidated = false

/** 主动使缓存失效，下次 scanFolder 调用将强制重新扫描 */
export function invalidateCache(): void {
  cacheInvalidated = true
}

/** 从合并文件名提取直播日期和时间（兼容新旧格式） */
function extractLiveTimestamp(fileName: string): number {
  // 新格式：95老阿姨_2026-07-12_104016.mp4 → 标题_日期_场次开始时间
  const m1 = fileName.match(/^.+?_(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})\.mp4$/i)
  if (m1) {
    const ts = new Date(`${m1[1]}T${m1[2]}:${m1[3]}:${m1[4]}`).getTime()
    if (!Number.isNaN(ts)) return ts
  }
  // 旧格式：2026-07-09_标题_2026-07-10_135840_合并版.mp4
  // 第一个日期时间是直播日期，时间取合并时刻（无直播时间信息，仅用于排序）
  const match = fileName.match(/^(\d{4}-\d{2}-\d{2})_(.+?)_(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})_/)
  if (match) {
    const date = match[1]
    const hour = parseInt(match[4])
    const minute = parseInt(match[5])
    const second = parseInt(match[6])
    return new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`).getTime()
  }
  // 如果无法解析，返回 0（排到最后）
  return 0
}

/** 扫描文件夹中所有 MP4 文件，按直播时间倒序（最新在前） */
export function scanFolder(folderPath: string): MergedFile[] {
  console.log('[scanFolder] 输入路径:', folderPath)

  // 检查缓存：未失效且在 TTL 内则直接返回
  if (!cacheInvalidated) {
    const cached = scanCache.get(folderPath)
    if (cached && Date.now() - cached.timestamp < MERGED_FILES_CACHE_TTL) {
      console.log('[scanFolder] 命中缓存，跳过扫描')
      return cached.data
    }
  }
  cacheInvalidated = false

  if (!folderPath || !existsSync(folderPath)) {
    console.log('[scanFolder] 路径不存在或为空，返回空数组')
    return []
  }
  try {
    const allFiles = readdirSync(folderPath)
    console.log('[scanFolder] 目录下所有文件:', allFiles)
    const mp4Files = allFiles.filter((f) => f.toLowerCase().endsWith('.mp4'))
    console.log('[scanFolder] MP4 文件:', mp4Files)
    const entries = mp4Files
      .map((f) => {
        const full = join(folderPath, f)
        const stat = statSync(full)
        // 使用直播时间戳（从文件名解析）而非文件修改时间
        const liveTime = extractLiveTimestamp(f)
        return { name: f, path: full, mtime: liveTime || stat.mtimeMs }
      })
      .sort((a, b) => {
        // 按直播时间戳倒序（最近的直播在前）
        return b.mtime - a.mtime
      })
    const result = entries.map((e, i) => ({ index: i, ...e }))
    console.log('[scanFolder] 最终返回:', result.length, '个文件')

    // 写入缓存
    scanCache.set(folderPath, { data: result, timestamp: Date.now() })

    return result
  } catch (err) {
    console.error('[scanFolder] 异常:', err)
    return []
  }
}

/** 根据文件名查找完整路径 */
export function findByNames(folderPath: string, names: string[]): string[] {
  const nameSet = new Set(names)
  return scanFolder(folderPath)
    .filter((f) => nameSet.has(f.name))
    .map((f) => f.path)
}
