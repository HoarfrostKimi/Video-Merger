/// <reference types="vite/client" />

interface Window {
  electron: {
    openExternal: (url: string) => void
  }
  api: {
    // 配置
    loadConfig: () => Promise<AppConfig>
    saveConfig: (config: Record<string, unknown>) => Promise<void>
    // 文件夹
    selectFolder: () => Promise<string>
    selectOutputFolder: () => Promise<string>
    openDirectory: (path: string) => Promise<void>
    openExternal: (url: string) => Promise<void>
    // 扫描
    scanFlvFiles: (folderPath: string, maxIntervalHours?: number) => Promise<ScanResult>
    // 视频
    getVideoInfo: (filePath: string) => Promise<VideoInfo>
    mergeVideos: (filePaths: string[], outputPath: string) => Promise<string | undefined>
    convertVideo: (filePath: string, outputPath: string) => Promise<void>
    // 批量并行合并
    batchMergeVideos: (tasks: Array<{ taskId: string; filePaths: string[]; outputPath: string; folderName: string }>, concurrency?: number) => Promise<Array<{ taskId: string; folderName: string; success: boolean; warning?: string; error?: string }>>
    // 进度（轮询获取）
    getProgress: () => Promise<{ mergeProgress: number; convertProgress: number }>
    getBatchProgress: () => Promise<Record<string, number>>
  }
}

interface AppConfig {
  inputFolder?: string
  outputFolder?: string
  outputFileName?: string
  darkMode?: boolean
  concurrency?: number
  maxIntervalHours?: number
  autoOpenWebsite?: boolean
  autoOpenFolder?: boolean
  hiddenFolderKeys?: string[]
}

interface FlvFile {
  name: string
  path: string
  size: number
  modifiedAt: string
}

/** 一个直播分组（按日期+标题分组） */
interface FolderGroup {
  key: string
  folderName: string
  folderPath: string
  fileCount: number
  totalSize: number
  files: FlvFile[]
  date: string
  title: string
}

/** 扫描返回结果 */
interface ScanResult {
  rootPath: string
  folders: FolderGroup[]
}

interface VideoInfo {
  duration: number
  codec: string
  width: number
  height: number
}
