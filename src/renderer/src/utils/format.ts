// 格式化百分比：小于 1% 时显示一位小数，否则显示整数
export const formatPercent = (p: number) => {
  if (p <= 0) return '0'
  if (p < 1) return p.toFixed(1)
  return p.toFixed(0)
}

// 格式化秒数为 mm:ss 或 hh:mm:ss
export const formatTime = (s: number) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

export const formatSize = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// 从合并文件名提取简洁显示名：2026-07-09_95老阿姨_2026-07-10_135840_合并版.mp4 → 2026-07-09 95老阿姨
export const formatUploadName = (fileName: string) => {
  const match = fileName.match(/^(\d{4}-\d{2}-\d{2})_(.+?)_/)
  return match ? `${match[1]} ${match[2]}` : fileName.replace(/\.mp4$/i, '')
}
