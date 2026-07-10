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

/** 从合并文件名提取直播日期和时间（格式：YYYY-MM-DD_HH-mm-ss） */
function extractLiveTimestamp(fileName: string): number {
  // 文件名格式：2026-07-09_标题_2026-07-10_135840_合并版.mp4
  // 第一个日期时间是直播时间
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
