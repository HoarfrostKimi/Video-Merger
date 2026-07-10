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
    scanFlvFiles: (folderPath: string, maxIntervalHours?: number, outputFolder?: string) => Promise<ScanResult>
    // 视频
    getVideoInfo: (filePath: string) => Promise<VideoInfo>
    mergeVideos: (filePaths: string[], outputPath: string) => Promise<string | undefined>
    convertVideo: (filePath: string, outputPath: string) => Promise<void>
    // 批量并行合并
    batchMergeVideos: (tasks: Array<{ taskId: string; filePaths: string[]; outputPath: string; folderName: string }>, concurrency?: number) => Promise<Array<{ taskId: string; folderName: string; success: boolean; warning?: string; error?: string }>>
    // 进度（轮询获取）
    getProgress: () => Promise<{ mergeProgress: number; convertProgress: number }>
    getBatchProgress: () => Promise<Record<string, number>>
    // 本地文件服务器（给 Chrome 插件提供视频文件）
    registerFileForServe: (filePath: string) => Promise<string>
    checkUploadDone: () => Promise<boolean>
    // 最小化外部浏览器窗口
    getForegroundWindow: () => Promise<number>
    minimizeBrowser: (prevHwnd: number) => Promise<void>
    // 手机控制面板
    getControlUrl: () => Promise<string>
    getLocalIP: () => Promise<string>
    toggleControlServer: (enabled: boolean, port?: number) => Promise<string>
    getNetworkInfo: () => Promise<{ ip: string; port: number }>
    // 已合并文件（投稿页）
    getMergedFiles: () => Promise<Array<{ index: number; name: string; path: string; mtime: number }>>
    uploadMergedFiles: (filePaths: string[]) => Promise<{ fileUrls: string[] }>
    // 后台运行
    minimizeToTray: () => Promise<void>
    restoreFromTray: () => Promise<void>
    forceQuit: () => Promise<void>
    // 配置变更监听
    onConfigUpdated: (callback: () => void) => () => void
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
  pluginLinkage?: boolean
  autoCloseBrowser?: boolean
  autoCloseApp?: boolean
  runInBackground?: boolean
  controlEnabled?: boolean
  controlPort?: number
  controlPassword?: string
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
