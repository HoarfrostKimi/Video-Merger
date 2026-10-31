import { app, shell, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, NativeImage, nativeTheme } from 'electron'
import { join, relative, dirname, extname, basename, resolve, isAbsolute } from 'path'
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync, createReadStream, watch, renameSync, unlinkSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { createServer, Server } from 'http'
import { execFile } from 'child_process'
import { freemem } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createHash } from 'crypto'
import { getVideoInfo, convertToMp4, mergeVideos } from './ffmpeg'
import {
  startControlServer,
  stopControlServer,
  getControlUrl,
  getLocalIP,
  getControlPort,
  setConfigCallbacks,
  refreshConfig,
  setFileServerCallback,
  setOpenExternalCallback,
  setScanCallback,
  updateScanResults,
  setUpdateHiddenKeysCallback,
  setUploadDoneCallback,
  setResetUploadDoneCallback,
  setIsMainAppMergingCallback,
  setMergeLockCallbacks,
  setFilesChangedCallback,
  applyExcludeFilter
} from './controlServer'
import * as mergedFiles from './mergedFiles'
import {
  type MergedSession,
  parseSessionFromFilePaths,
  upsertMergedSessions,
  removeMergedSessionsByGroup,
  removeMergedSessionsForDeletedMp4,
  hasMergedSessionForGroup,
  isSessionMerged,
  hasLegacyMergedVideo,
  parseMergedFileName
} from './mergedFiles'

let mainWindow: BrowserWindow | null = null

// 进度存储（渲染进程通过轮询获取，不依赖 contextBridge 的监听器回调）
let mergeProgress = 0
let convertProgress = 0

// 合并互斥锁（防止桌面端和手机端同时合并）
let isMerging = false

export function getIsMerging(): boolean { return isMerging }
export function setIsMerging(value: boolean): void { isMerging = value }

// 批量合并进度存储：Map<taskId, progress>
const batchMergeProgress = new Map<string, number>()

// 扫描结果缓存（避免排除/恢复分组时重复遍历文件夹）
const scanCache = new Map<string, { data: { rootPath: string; folders: any[] }; timestamp: number }>()
const SCAN_CACHE_TTL = 10_000 // 10秒 TTL

// ============ 本地文件服务器（给 Chrome 插件提供合并后的视频文件） ============

let fileServer: Server | null = null
let fileServerPort = 0
const servedFiles = new Map<string, { filePath: string; lastAccess: number }>() // fileId -> { filePath, lastAccess }
let uploadDone = false // 插件投稿完成信号
let uploadDoneTimer: NodeJS.Timeout | null = null // 超时自动重置
const UPLOAD_DONE_TIMEOUT = 15 * 60 * 1000 // 15分钟超时

/** 启动本地文件服务器（如果还没启动） */
function ensureFileServer(): Promise<number> {
  if (fileServer) return Promise.resolve(fileServerPort)
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')

      // 处理插件完成信号
      if (url.searchParams.get('signal') === 'done') {
        uploadDone = true
        // 启动超时自动重置（防止插件异常未发送重置信号时状态卡死）
        if (uploadDoneTimer) clearTimeout(uploadDoneTimer)
        uploadDoneTimer = setTimeout(() => {
          uploadDone = false
          uploadDoneTimer = null
          console.log('[FileServer] 投稿完成状态超时，已自动重置')
        }, UPLOAD_DONE_TIMEOUT)
        console.log('[FileServer] 收到插件完成信号')
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'text/plain'
        })
        res.end('OK')
        return
      }

      const fileId = url.searchParams.get('fileId')
      if (!fileId || !servedFiles.has(fileId)) {
        res.writeHead(404)
        res.end('File not found')
        return
      }
      const fileInfo = servedFiles.get(fileId)!
      fileInfo.lastAccess = Date.now() // 更新访问时间
      const filePath = fileInfo.filePath
      try {
        const stat = statSync(filePath)
        const ext = extname(filePath).toLowerCase()
        const mime = ext === '.mp4' ? 'video/mp4' : 'application/octet-stream'
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': stat.size,
          'Access-Control-Allow-Origin': '*',
          'Accept-Ranges': 'bytes'
        })
        const stream = createReadStream(filePath)
        stream.on('error', (err) => {
          console.error('[FileServer] 读取文件失败:', err.message)
          if (!res.headersSent) res.writeHead(500)
          res.end('Internal error')
        })
        stream.pipe(res)
      } catch (err) {
        console.error('[FileServer] 文件访问异常:', (err as Error).message)
        if (!res.headersSent) res.writeHead(404)
        res.end('File not found')
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        fileServer = server
        fileServerPort = addr.port
        console.log('[FileServer] 已启动，端口:', fileServerPort)
        resolve(fileServerPort)
      } else {
        reject(new Error('无法获取服务器端口'))
      }
    })
    server.on('error', reject)
  })
}

/** 注册文件并返回访问 URL */
async function registerFileForServe(filePath: string): Promise<string> {
  const port = await ensureFileServer()
  const fileId = createHash('sha256').update(filePath).digest('hex').slice(0, 16)
  servedFiles.set(fileId, { filePath, lastAccess: Date.now() })
  const fileName = basename(filePath)
  return `http://127.0.0.1:${port}/?fileId=${fileId}&name=${encodeURIComponent(fileName)}`
}

/** 清理过期的文件注册（30分钟未访问） */
function cleanupServedFiles(): void {
  const now = Date.now()
  const MAX_AGE = 30 * 60 * 1000 // 30分钟
  for (const [fileId, info] of servedFiles.entries()) {
    if (now - info.lastAccess > MAX_AGE) {
      servedFiles.delete(fileId)
    }
  }
}
// 每小时清理一次过期文件注册
setInterval(cleanupServedFiles, 60 * 60 * 1000)

/** 获取当前前台窗口句柄（Windows） */
function getForegroundWindow(): Promise<number> {
  if (process.platform !== 'win32') return Promise.resolve(0)
  return new Promise((resolve) => {
    const ps = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
Write-Output ([Win32]::GetForegroundWindow().ToInt64())`
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(0)
      resolve(parseInt(stdout.trim(), 10) || 0)
    })
  })
}

/** 最小化外部浏览器窗口（仅当它抢了焦点时才最小化） */
function minimizeBrowser(prevHwnd: number): void {
  if (process.platform !== 'win32') return
  const ps = `
try {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
  Start-Sleep -Seconds 2
  $currentHwnd = [Win32]::GetForegroundWindow().ToInt64()
  if ($currentHwnd -ne ${prevHwnd} -and $currentHwnd -ne 0) {
    [Win32]::ShowWindow([IntPtr]$currentHwnd, 6) | Out-Null
  }
} catch {}
`
  execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, () => {})
}

// ============ 配置管理：记住用户设置 ============

let configCache: AppConfig | null = null

interface AppConfig {
  inputFolder?: string
  inputFolder2?: string
  outputFolder?: string
  outputFileName?: string
  darkMode?: boolean
  concurrency?: number
  maxIntervalHours?: number
  autoOpenWebsite?: boolean
  autoOpenFolder?: boolean
  autoCloseBrowser?: boolean
  autoCloseApp?: boolean
  runInBackground?: boolean
  controlEnabled?: boolean
  controlPort?: number
  hiddenFolderKeys?: string[]
  /** 已合并的直播场次清单（精确匹配用，方案 A） */
  mergedSessions?: MergedSession[]
  /** 自动清理：定时把 N 天前的录制片段与合并产物移至回收站（默认开启） */
  autoCleanEnabled?: boolean
  /** 自动清理保留天数（默认 7 天） */
  autoCleanDays?: number
  /** 定时自动合并：到点自动扫描并合并所有待合并分组（默认关闭） */
  autoMergeEnabled?: boolean
  /** 定时自动合并时间，格式 HH:mm（24 小时制） */
  autoMergeTime?: string
  /** 定时合并完成后自动打开 B站投稿页（配合插件自动上传） */
  autoMergeUpload?: boolean
}

function getConfigPath(): string {
  const dir = join(app.getPath('userData'))
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, 'config.json')
}

function loadConfig(): AppConfig {
  if (configCache) return configCache
  try {
    const path = getConfigPath()
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf-8'))
      // 只打印非敏感信息（不打印密码）
      const safeData = { ...data }
      if (safeData.controlPassword) safeData.controlPassword = '***'
      console.log('[loadConfig] 读取到:', JSON.stringify(safeData))
      configCache = data
      return data
    }
    console.log('[loadConfig] 文件不存在')
  } catch (e) {
    console.error('[loadConfig] 失败:', e)
  }
  return {}
}

function saveConfig(config: AppConfig): void {
  try {
    const current = configCache || loadConfig()
    const merged = { ...current, ...config }
    const path = getConfigPath()
    console.log('[saveConfig] 写入:', JSON.stringify(merged))
    // 原子写入：先写临时文件再重命名，防止写入中断导致配置损坏
    const tmpPath = path + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf-8')
    renameSync(tmpPath, path)
    configCache = merged
    console.log('[saveConfig] 写入成功')
  } catch (e) {
    console.error('[saveConfig] 写入失败:', e)
  }
}

function invalidateConfigCache(): void {
  configCache = null
}

/** 记录一次成功合并的直播场次（方案 A：精确到某一天某主播的某一场） */
function recordMergedSessionFromPaths(filePaths: string[]): void {
  const session = parseSessionFromFilePaths(filePaths)
  if (!session) return
  const config = loadConfig()
  const sessions = upsertMergedSessions(config.mergedSessions || [], session)
  saveConfig({ mergedSessions: sessions })
  // 合并成功会改变「已合并场次」判定，立即失效扫描缓存，避免旧列表残留
  scanCache.clear()
  console.log(
    `[recordMergedSession] 记录已合并场次: ${session.date} ${session.title} ` +
      `${new Date(session.startTs).toLocaleTimeString()} - ${new Date(session.endTs).toLocaleTimeString()}`
  )
}

// ============ 配置文件监听（手机端修改配置时同步到电脑端） ============

let configWatcher: ReturnType<typeof watch> | null = null
let lastConfigMtime = 0
let configDebounceTimer: NodeJS.Timeout | null = null // 防抖计时器

/** 启动配置文件监听 */
function startConfigWatcher(): void {
  if (configWatcher) return
  const configPath = getConfigPath()
  if (!existsSync(configPath)) return

  // 启动时清理可能残留的 .tmp 文件（上次原子写入中断导致）
  const tmpPath = configPath + '.tmp'
  if (existsSync(tmpPath)) {
    try {
      unlinkSync(tmpPath)
      console.log('[startConfigWatcher] 清理残留临时文件:', tmpPath)
    } catch (e) {
      console.warn('[startConfigWatcher] 清理临时文件失败:', e)
    }
  }

  try {
    const stat = statSync(configPath)
    lastConfigMtime = stat.mtimeMs

    configWatcher = watch(configPath, (eventType) => {
      if (eventType === 'change' && mainWindow) {
        // 防抖：500ms 内的多次变更只触发一次
        if (configDebounceTimer) clearTimeout(configDebounceTimer)
        configDebounceTimer = setTimeout(() => {
          configDebounceTimer = null
          try {
            const stat = statSync(configPath)
            if (stat.mtimeMs !== lastConfigMtime) {
              lastConfigMtime = stat.mtimeMs
              // 清除配置缓存，下次读取时重新加载
              invalidateConfigCache()
              // 刷新控制服务器的配置缓存
              refreshConfig()
              // 同步排除列表过滤（手机端排除后桌面端即时生效）
              applyExcludeFilter()
              // 通知渲染进程配置已变
              mainWindow.webContents.send('config-changed')
              console.log('[configWatcher] 配置文件变更，已通知渲染进程')
            }
          } catch (e) {
            // 文件可能正在写入，忽略错误
          }
        }, 500)
      }
    })
    console.log('[configWatcher] 已开始监听配置文件')
  } catch (e) {
    console.error('[configWatcher] 启动监听失败:', e)
  }
}

/** 停止配置文件监听 */
function stopConfigWatcher(): void {
  if (configWatcher) {
    configWatcher.close()
    configWatcher = null
    console.log('[configWatcher] 已停止监听')
  }
}

// ============ 窗口创建 ============

let appTray: Tray | null = null
let forceQuit = false // 为 true 时关闭窗口真正退出，否则隐藏到托盘

/** 生成系统托盘图标（32x32 蓝色圆形 + 白色播放三角符号） */
function createTrayIcon(): NativeImage {
  const size = 32
  const buf = Buffer.alloc(size * size * 4, 0)

  const cx = 15.5, cy = 15.5
  const bgR = 14, innerR = 12.5

  // 辅助函数：判断点是否在三角形内（重心坐标法）
  function inTriangle(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number,
    x3: number, y3: number
  ): boolean {
    const d1 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2)
    const d2 = (px - x3) * (y2 - y3) - (x2 - x3) * (py - y3)
    const d3 = (px - x1) * (y3 - y1) - (x3 - x1) * (py - y1)
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0
    return !(hasNeg && hasPos)
  }

  // 播放三角顶点：尖端(22,15.5)，左上(10,8.5)，左下(10,22.5)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      const idx = (y * size + x) * 4

      if (dist <= bgR) {
        // 蓝色圆形背景
        const alpha = Math.min(1, Math.max(0, (bgR - dist + 0.5))) // 边缘抗锯齿
        buf[idx] = Math.round(22 * alpha)     // R
        buf[idx + 1] = Math.round(119 * alpha) // G
        buf[idx + 2] = Math.round(255 * alpha) // B
        buf[idx + 3] = Math.round(255 * alpha) // A

        // 白色播放三角
        if (dist <= innerR && inTriangle(x + 0.5, y + 0.5, 22, 15.5, 10, 8.5, 10, 22.5)) {
          buf[idx] = 255
          buf[idx + 1] = 255
          buf[idx + 2] = 255
          buf[idx + 3] = 255
        }
      }
    }
  }

  // 创建 NativeImage（raw BGRA pixel data）
  return nativeImage.createFromBuffer(buf, { width: size, height: size })
}

/** 创建系统托盘图标 */
function createTray(): void {
  if (appTray) return
  const icon = createTrayIcon()
  appTray = new Tray(icon)
  appTray.setToolTip('视频合并工具')
  updateTrayMenu()
  // 双击托盘图标显示窗口
  appTray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

/** 更新托盘右键菜单 */
function updateTrayMenu(): void {
  if (!appTray) return
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        forceQuit = true
        app.quit()
      }
    }
  ])
  appTray.setContextMenu(contextMenu)
}

/** 销毁托盘图标 */
function destroyTray(): void {
  if (appTray) {
    appTray.destroy()
    appTray = null
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: '视频合并工具',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

  // 拦截关闭窗口：后台运行模式下隐藏到托盘而不是退出
  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      const config = loadConfig()
      if (config.runInBackground) {
        e.preventDefault()
        mainWindow!.hide()
        console.log('[App] 窗口已隐藏到托盘')
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ============ IPC 处理 ============

// 加载配置（应用启动时调用）
ipcMain.handle('config:load', async () => {
  return { success: true, data: loadConfig() }
})

// 保存配置
ipcMain.handle('config:save', async (_event, config: AppConfig) => {
  saveConfig(config)
  // 同步到控制服务器（排除列表变更时手机端即时生效）
  refreshConfig()
  applyExcludeFilter()
  return { success: true }
})

// 1. 选择文件夹
ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, message: '未选择文件夹' }
  }
  const folder = result.filePaths[0]
  // 自动保存
  saveConfig({ inputFolder: folder })
  return { success: true, data: folder }
})

// 支持的视频格式（不含 .ts：大航海直播会生成 TS 文件，合并会导致文件错误）
const VIDEO_EXTENSIONS = ['.flv', '.m4s', '.blv']

function isVideoFile(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function stripVideoExtension(fileName: string): string {
  let name = fileName
  for (const ext of VIDEO_EXTENSIONS) {
    if (name.toLowerCase().endsWith(ext)) {
      name = name.slice(0, -ext.length)
      break
    }
  }
  return name
}

// 2. 扫描文件夹中的视频文件（按日期+标题分组判断是否为同一场直播）
// 提取为独立函数，供 IPC 和控制服务器共享
async function performScan(
  folderPath: string,
  maxIntervalHours: number = 2.5,
  outputFolder: string = '',
  bypassCache: boolean = false
): Promise<{
  rootPath: string
  folders: Array<{
    key: string
    folderName: string
    folderPath: string
    fileCount: number
    totalSize: number
    files: Array<{ name: string; path: string; size: number; modifiedAt: string }>
    date: string
    title: string
    lastTimestamp: number
    startTimestamp: number
  }>
}> {
  // 检查扫描缓存
  if (!bypassCache) {
    const cacheKey = `${folderPath}|${maxIntervalHours}|${outputFolder}`
    const cached = scanCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < SCAN_CACHE_TTL) {
      console.log('[performScan] 命中扫描缓存')
      return cached.data
    }
  }

  interface FlvFile {
    name: string
    path: string
    size: number
    modifiedAt: string
  }

  interface FileInfo extends FlvFile {
    date: string
    time: string
    title: string
    timestamp: number
  }

  const files: FileInfo[] = []

  const parseFileName = (fileName: string): { date: string; time: string; title: string } => {
    // 去掉 _PART00X 后缀，让同一场直播的 PART 文件和非 PART 文件归到同一组
    const nameWithoutExt = stripVideoExtension(fileName).replace(/_PART\d+$/i, '')
    const match = nameWithoutExt.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}-\d{2}-\d{2}-\d{3})\s*(.+)$/)
    if (match) {
      return {
        date: match[1],
        time: match[2],
        title: match[3].trim() || '未命名'
      }
    }
    return {
      date: '未知日期',
      time: '未知时间',
      title: nameWithoutExt.trim() || '未命名'
    }
  }

  const scanDir = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = join(dir, entry.name)
      try {
        if (entry.isDirectory()) {
          await scanDir(fullPath)
        } else if (entry.isFile() && isVideoFile(entry.name)) {
          const s = await stat(fullPath)
          const { date, time, title } = parseFileName(entry.name)
          console.log(`[scanDir] 发现文件: ${entry.name} => date=${date}, time=${time}, title=${title}`)
          const timeParts = time.split('-')
          const timestamp = timeParts.length >= 4
            ? new Date(`${date}T${timeParts[0]}:${timeParts[1]}:${timeParts[2]}`).getTime()
            : s.mtime.getTime()

          files.push({
            name: entry.name,
            path: fullPath,
            size: s.size,
            modifiedAt: s.mtime.toISOString(),
            date,
            time,
            title,
            timestamp
          })
        }
      } catch {
        // 跳过无法访问的文件
      }
    }
  }

  await scanDir(folderPath)

  files.sort((a, b) => a.timestamp - b.timestamp)

  const groups: Array<{
    key: string
    folderName: string
    folderPath: string
    fileCount: number
    totalSize: number
    files: FlvFile[]
    date: string
    title: string
    lastTimestamp: number
    /** 该场直播开始时间戳（组内最早分段文件时间），用于时间排序 */
    startTimestamp: number
  }> = []

  if (files.length > 0) {
    let currentGroup: {
      key: string
      folderName: string
      folderPath: string
      fileCount: number
      totalSize: number
      files: FlvFile[]
      date: string
      title: string
      lastTimestamp: number
      startTimestamp: number
    } | null = null

    const MAX_INTERVAL_MS = maxIntervalHours * 60 * 60 * 1000

    // key/folderName 带上该场开始时间，保证同一天多场直播互不混淆（key 唯一）
    const pad2 = (n: number): string => String(n).padStart(2, '0')
    const makeKey = (date: string, title: string, ts: number): string => {
      const d = new Date(ts)
      return `${date}_${title}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
    }
    const makeFolderName = (date: string, title: string, ts: number): string => {
      const d = new Date(ts)
      return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())} ${title}`
    }

    for (const file of files) {
      if (!currentGroup) {
        currentGroup = {
          key: makeKey(file.date, file.title, file.timestamp),
          folderName: makeFolderName(file.date, file.title, file.timestamp),
          folderPath: dirname(file.path),
          fileCount: 1,
          totalSize: file.size,
          files: [file],
          date: file.date,
          title: file.title,
          lastTimestamp: file.timestamp,
          startTimestamp: file.timestamp
        }
      } else {
        const interval = file.timestamp - currentGroup.lastTimestamp

        if (file.title === currentGroup.title && interval <= MAX_INTERVAL_MS) {
          // 和当前分组标题相同且间隔在阈值内，直接加入
          currentGroup.fileCount++
          currentGroup.totalSize += file.size
          currentGroup.files.push(file)
          currentGroup.lastTimestamp = file.timestamp
        } else {
          // 标题不同或间隔太大，先搜索所有已有分组看能否合并
          let matched = false
          for (const group of groups) {
            if (group.title === file.title) {
              const gap = file.timestamp - group.lastTimestamp
              if (gap <= MAX_INTERVAL_MS) {
                group.fileCount++
                group.totalSize += file.size
                group.files.push(file)
                group.lastTimestamp = file.timestamp
                matched = true
                break
              }
            }
          }
          if (!matched) {
            // 没有匹配的已有分组，先保存当前分组，再创建新分组
            groups.push(currentGroup)
            currentGroup = {
              key: makeKey(file.date, file.title, file.timestamp),
              folderName: makeFolderName(file.date, file.title, file.timestamp),
              folderPath: dirname(file.path),
              fileCount: 1,
              totalSize: file.size,
              files: [file],
              date: file.date,
              title: file.title,
              lastTimestamp: file.timestamp,
              startTimestamp: file.timestamp
            }
          }
        }
      }
    }

    if (currentGroup) {
      groups.push(currentGroup)
    }
  }

  // 按直播开始时间倒序（最新直播在前），同一天多场按开始时间细分先后
  groups.sort((a, b) => b.startTimestamp - a.startTimestamp)

  console.log(`[performScan] 共找到 ${files.length} 个文件，分成 ${groups.length} 组`)
  groups.forEach((g, i) => {
    console.log(`[performScan] 组${i}: key=${g.key}, fileCount=${g.fileCount}, files=${g.files.map(f => f.name).join(', ')}`)
  })

  // 过滤掉正在录制中的直播：整场直播只要有任何 PART 文件，整组都不显示
  const isRecording = (group: { files: FlvFile[] }): boolean =>
    group.files.some((f) => /_PART\d+/i.test(f.name))
  const nonRecordingGroups = groups.filter((g) => !isRecording(g))

  // 过滤掉已经合并过的分组（输出文件夹中已有对应 MP4）
  // 方案 A：优先用「已合并场次清单」精确匹配（区分同一天的多场直播）；
  // 仅当该 (日期,标题) 从无记录时（升级前的旧数据），回退到旧的文件名粗匹配兜底。
  // 一次性扫描输出文件夹，收集所有 MP4 文件名
  const collectMergedFiles = (dir: string, result: Set<string>): void => {
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (entry.toLowerCase().endsWith('.mp4')) {
          result.add(entry)
        }
        const fullPath = join(dir, entry)
        try {
          if (statSync(fullPath).isDirectory() && entry !== '.' && !entry.startsWith('.')) {
            collectMergedFiles(fullPath, result)
          }
        } catch {
          // 跳过无法访问的目录
        }
      }
    } catch {
      // 目录不存在
    }
  }

  // 在输出文件夹中搜索已合并的 MP4（合并后的文件保存在输出文件夹，不是输入文件夹）
  const searchDir = outputFolder || folderPath
  const mergedFilesSet = new Set<string>()
  collectMergedFiles(searchDir, mergedFilesSet)

  // 读取已合并场次清单（合并成功时写入）
  const mergedSessions = loadConfig().mergedSessions || []

  const filteredGroups = nonRecordingGroups.filter((group) => {
    if (hasMergedSessionForGroup(mergedSessions, group.date, group.title)) {
      // 该主播当天已有精确场次记录 → 按时间区间精确匹配，同一主播当天其他场次不被误伤
      const startTs = Math.min(...group.files.map((f) => (f as FileInfo).timestamp))
      const endTs = group.lastTimestamp
      return !isSessionMerged(mergedSessions, group.date, group.title, startTs, endTs)
    }
    // 升级前合并的旧数据（无场次记录）→ 保持旧行为兜底
    return !hasLegacyMergedVideo(group.date, group.title, mergedFilesSet)
  })

  // 写入扫描缓存
  const result = { rootPath: folderPath, folders: filteredGroups }
  scanCache.set(`${folderPath}|${maxIntervalHours}|${outputFolder}`, { data: result, timestamp: Date.now() })

  console.log(`[performScan] 过滤后剩余 ${filteredGroups.length} 组`)
  return result
}

// IPC 处理器：渲染进程调用扫描
ipcMain.handle('scan:flvFiles', async (_event, folderPath: string, maxIntervalHours: number = 2.5, outputFolder: string = '', _unused?: string, folderPath2?: string) => {
  try {
    let result = await performScan(folderPath, maxIntervalHours, outputFolder, true)
    if (folderPath2 && folderPath2 !== folderPath) {
      const result2 = await performScan(folderPath2, maxIntervalHours, outputFolder, true)
      const allFolders = [...result.folders, ...result2.folders]
      const merged = new Map<string, typeof result.folders[0]>()
      for (const f of allFolders) {
        const existing = merged.get(f.key)
        if (existing) {
          existing.fileCount += f.fileCount; existing.totalSize += f.totalSize
          existing.files.push(...f.files)
          existing.startTimestamp = Math.min(existing.startTimestamp, f.startTimestamp)
        } else { merged.set(f.key, { ...f }) }
      }
      result = { rootPath: folderPath, folders: Array.from(merged.values()) }
    }
    // 同步扫描结果到控制服务器（手机列表与 App 一致，包含排除列表过滤）
    const latestConfig = loadConfig()
    const hiddenKeys = new Set(latestConfig.hiddenFolderKeys || [])
    // 兼容旧排除 key（日期_标题）：新 key 带场次时间，旧 key 仍按日期+标题排除（等于排除当天全部场次）
    const isHidden = (f: { key: string; date: string; title: string }): boolean =>
      hiddenKeys.has(f.key) || hiddenKeys.has(`${f.date}_${f.title}`)
    const filteredForControl = result.folders.filter((f) => !isHidden(f))
    updateScanResults(filteredForControl)
    return { success: true, data: result }
  } catch (error: any) {
    return { success: false, message: error.message || '扫描失败' }
  }
})

// 7. 打开目录
ipcMain.handle('dialog:openDirectory', async (_event, path: string) => {
  try {
    await shell.openPath(path)
    return { success: true }
  } catch (error: any) {
    return { success: false, message: error.message || '打开目录失败' }
  }
})

// 9. 打开外部链接
ipcMain.handle('dialog:openExternal', async (_event, url: string) => {
  try {
    shell.openExternal(url)
    return { success: true }
  } catch (error: any) {
    return { success: false, message: error.message || '打开链接失败' }
  }
})

// 3. 选择输出目录
ipcMain.handle('dialog:selectOutputFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, message: '未选择文件夹' }
  }
  const folder = result.filePaths[0]
  saveConfig({ outputFolder: folder })
  return { success: true, data: folder }
})

// 4. 获取视频信息
ipcMain.handle('video:getInfo', async (_event, filePath: string) => {
  try {
    const info = await getVideoInfo(filePath)
    return { success: true, data: info }
  } catch (error: any) {
    return { success: false, message: error.message }
  }
})

// 5. 合并视频
ipcMain.handle('video:merge', async (event, filePaths: string[], outputPath: string) => {
  // 检查是否正在合并（防止与手机端冲突）
  if (isMerging) {
    return { success: false, message: '当前忙碌，请等待合并完成' }
  }
  isMerging = true

  try {
    mergeProgress = 0
    const warning = await mergeVideos(filePaths, outputPath, (percent) => {
      mergeProgress = percent
    })
    mergeProgress = 100
    // 合并成功，记录该场次（方案 A：区分同一天多场直播）
    recordMergedSessionFromPaths(filePaths)
    return { success: true, data: warning }
  } catch (error: any) {
    mergeProgress = 0
    return { success: false, message: error.message }
  } finally {
    isMerging = false
  }
})

// 10. 批量并行合并视频
interface BatchMergeTask {
  taskId: string
  filePaths: string[]
  outputPath: string
  folderName: string
}

interface BatchMergeResult {
  taskId: string
  folderName: string
  success: boolean
  warning?: string
  error?: string
}

ipcMain.handle('video:batchMerge', async (_event, tasks: BatchMergeTask[], concurrency: number = 3) => {
  // 检查是否正在合并（防止与手机端冲突）
  if (isMerging) {
    return { success: false, message: '当前忙碌，请等待合并完成' }
  }
  isMerging = true

  try {
    // 并发上限限制为 4（即使设置中写了更大值）
    const MAX_CONCURRENCY = 4
    const effectiveConcurrency = Math.min(concurrency, MAX_CONCURRENCY, tasks.length)
    if (effectiveConcurrency < concurrency) {
      console.log(`[batchMerge] 并发数从 ${concurrency} 降低到 ${effectiveConcurrency}（上限 ${MAX_CONCURRENCY}）`)
    }

    // 初始化所有任务的进度为0
    for (const task of tasks) {
      batchMergeProgress.set(task.taskId, 0)
    }

    // 预探测所有任务的首个文件时长（并行加速，批量合并任务无需各自重复探测）
    const probeResults = await Promise.allSettled(
      tasks.map(t => getVideoInfo(t.filePaths[0]).catch(() => ({ duration: 0, codec: '', width: 0, height: 0 })))
    )
    const estimatedDurations: number[] = probeResults.map(r =>
      r.status === 'fulfilled' && r.value ? r.value.duration : 0
    )
    const totalProbeMs = estimatedDurations.reduce((s, d) => s + d, 0)
    console.log(`[batchMerge] 并行预探测完成，共 ${tasks.length} 个任务，预估总时长 ${(totalProbeMs / 60).toFixed(1)} 分钟`)

    const results: BatchMergeResult[] = []
    let currentIndex = 0

    const FREE_MEM_THRESHOLD = 500 * 1024 * 1024 // 500MB

    // 工作函数：从任务队列中取出任务执行
    const worker = async (): Promise<void> => {
      while (currentIndex < tasks.length) {
        const taskIndex = currentIndex++
        const task = tasks[taskIndex]

        // 内存检测：启动新任务前检查可用内存
        if (freemem() < FREE_MEM_THRESHOLD) {
          console.warn('[App] 内存不足，等待当前进行中的合并任务完成')
          // 等待 3 秒后重试检查
          await new Promise((r) => setTimeout(r, 3000))
          if (freemem() < FREE_MEM_THRESHOLD) {
            console.warn('[App] 内存仍然不足，跳过剩余任务')
            results.push({
              taskId: task.taskId,
              folderName: task.folderName,
              success: false,
              error: '内存不足，任务跳过'
            })
            batchMergeProgress.set(task.taskId, -1)
            continue
          }
        }

        try {
          const warning = await mergeVideos(task.filePaths, task.outputPath, (percent) => {
            batchMergeProgress.set(task.taskId, percent)
          }, undefined, estimatedDurations[taskIndex])
          batchMergeProgress.set(task.taskId, 100)
          results.push({
            taskId: task.taskId,
            folderName: task.folderName,
            success: true,
            warning
          })
        } catch (error: any) {
          batchMergeProgress.set(task.taskId, -1) // -1 表示失败
          results.push({
            taskId: task.taskId,
            folderName: task.folderName,
            success: false,
            error: error.message
          })
        }
      }
    }

    // 启动多个 worker 并行执行
    const workers = Array.from({ length: effectiveConcurrency }, () => worker())
    await Promise.all(workers)

    // 清理进度记录
    for (const task of tasks) {
      batchMergeProgress.delete(task.taskId)
    }

    // 合并成功，记录各场次（方案 A：精确匹配用，区分同一天多场直播）
    const taskByKey = new Map(tasks.map((t) => [t.taskId, t]))
    for (const r of results) {
      if (r.success) {
        const t = taskByKey.get(r.taskId)
        if (t) recordMergedSessionFromPaths(t.filePaths)
      }
    }

    return { success: true, data: results }
  } finally {
    isMerging = false
  }
})

// 11. 获取批量合并进度
ipcMain.handle('progress:getBatch', () => {
  const progress: Record<string, number> = {}
  batchMergeProgress.forEach((value, key) => {
    progress[key] = value
  })
  return { success: true, data: progress }
})

// 6. 转换视频
ipcMain.handle('video:convert', async (event, filePath: string, outputPath: string) => {
  try {
    convertProgress = 0
    await convertToMp4(filePath, outputPath, (percent) => {
      convertProgress = percent
    })
    convertProgress = 100
    return { success: true }
  } catch (error: any) {
    convertProgress = 0
    return { success: false, message: error.message }
  }
})

// 8. 获取当前进度（渲染进程轮询调用）
ipcMain.handle('progress:get', () => {
  return { mergeProgress, convertProgress }
})

// 12. 注册文件到本地服务器（给 Chrome 插件提供视频文件）
ipcMain.handle('fileServer:register', async (_event, filePath: string) => {
  try {
    const url = await registerFileForServe(filePath)
    return { success: true, data: url }
  } catch (error: any) {
    return { success: false, message: error.message || '文件服务启动失败' }
  }
})

// 13. 检查插件是否已完成投稿
ipcMain.handle('fileServer:checkDone', () => {
  return uploadDone
})

// 14. 获取当前前台窗口句柄（用于判断浏览器是否抢了焦点）
ipcMain.handle('browser:getForegroundWindow', async () => {
  return await getForegroundWindow()
})

// 15. 最小化外部浏览器窗口（仅当它抢了焦点时才最小化）
ipcMain.handle('browser:minimize', (_event, prevHwnd: number) => {
  minimizeBrowser(prevHwnd)
  return { success: true }
})

// 16. 获取手机控制地址
ipcMain.handle('control:getUrl', () => {
  const url = getControlUrl()
  return { success: true, data: url }
})

// 17. 获取本机局域网 IP
ipcMain.handle('control:getIP', () => {
  return { success: true, data: getLocalIP() }
})

// 18. 启动/停止控制服务器
ipcMain.handle('control:toggle', async (_event, enabled: boolean, port?: number) => {
  try {
    if (enabled) {
      const url = await startControlServer(port || 9820)
      return { success: true, data: url }
    } else {
      stopControlServer()
      return { success: true, data: '' }
    }
  } catch (e: unknown) {
    return { success: false, message: String(e) }
  }
})

// 18b. 获取局域网 IP 和端口（供桌面端显示）
ipcMain.handle('network:getInfo', () => {
  return { success: true, data: { ip: getLocalIP(), port: getControlPort() } }
})

// 19. 最小化到托盘（后台运行）
ipcMain.handle('window:minimizeToTray', () => {
  if (mainWindow) {
    mainWindow.hide()
    // 确保托盘图标存在
    createTray()
  }
  return { success: true }
})

// 20. 从托盘恢复窗口
ipcMain.handle('window:restoreFromTray', () => {
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
  }
  return { success: true }
})

// 21. 真正退出应用
ipcMain.handle('app:forceQuit', () => {
  forceQuit = true
  app.quit()
  return { success: true }
})

// 22. 设置原生主题（影响窗口标题栏颜色）
ipcMain.handle('theme:set', async (_event, darkMode: boolean) => {
  nativeTheme.themeSource = darkMode ? 'dark' : 'light'
  return { success: true }
})

// 22. 获取已合并文件列表（投稿页使用，扫描输出文件夹）
ipcMain.handle('mergedFiles:get', () => {
  const config = loadConfig()
  const outputFolder = config.outputFolder || ''
  console.log('[mergedFiles:get] outputFolder:', outputFolder)
  const files = mergedFiles.scanFolder(outputFolder)
  console.log('[mergedFiles:get] 找到文件数:', files.length, files.map(f => f.name))
  return { success: true, data: files }
})

// 22b. 删除分组：只删除该分组的分段源文件（移至回收站），不碰已合并的 MP4
//      投稿列表里的合并 MP4 由「删除投稿 MP4」入口单独管理（只删 MP4）
ipcMain.handle('segments:delete', async (_event, groups: Array<{ key: string; folderName: string; date: string; title: string; files: Array<{ path: string }> }>) => {
  try {
    if (!groups || groups.length === 0) {
      return { success: false, message: '未指定要删除的分组' }
    }

    let totalSegmentsDeleted = 0
    const deletedGroups: string[] = []

    for (const group of groups) {
      // 1. 删除该分组的分段源文件（按前端传入的精确路径逐个删，不按文件名猜）
      for (const file of group.files) {
        try {
          if (existsSync(file.path)) {
            await shell.trashItem(file.path)
            totalSegmentsDeleted++
          }
        } catch (e) {
          console.warn('[delete] 分段文件移至回收站失败:', file.path, e)
        }
      }

      deletedGroups.push(group.folderName)

      // 2. 清理该场次的已合并记录（按时间区间精确清理，保留同一天其他场次）
      const session = parseSessionFromFilePaths(group.files.map((f) => f.path))
      if (session) {
        const cfg = loadConfig()
        const sessions = removeMergedSessionsByGroup(
          cfg.mergedSessions || [],
          session.date,
          session.title,
          session.startTs,
          session.endTs
        )
        if (sessions.length !== (cfg.mergedSessions || []).length) {
          saveConfig({ mergedSessions: sessions })
          console.log(`[delete] 清理已合并场次记录: ${session.date} ${session.title}`)
        }
      }
    }

    // 使扫描缓存失效，让列表刷新
    scanCache.clear()
    mergedFiles.invalidateCache()

    console.log(`[delete] 已删除 ${deletedGroups.length} 个分组，分段源文件 ${totalSegmentsDeleted} 个`)
    return {
      success: true,
      data: { groupCount: deletedGroups.length, segmentCount: totalSegmentsDeleted, mp4Count: 0, deletedGroups }
    }
  } catch (error: any) {
    console.error('[delete] 删除分组失败:', error)
    return { success: false, message: error.message || '删除失败' }
  }
})

// 23. 删除已合并 MP4 及其对应的分段源文件（移至回收站）
ipcMain.handle('mergedFiles:delete', async (_event, fileName: string) => {
  try {
    const config = loadConfig()
    const outputFolder = config.outputFolder || ''

    // 安全校验：只允许删除输出目录内的文件（防止 fileName 含 .. 逃逸删除任意路径）
    const safeName = basename(fileName)
    const mp4Path = join(outputFolder, safeName)
    if (!existsSync(mp4Path)) {
      return { success: false, message: '文件不存在' }
    }

    // 删除投稿 MP4：只删 MP4 文件本身（移至回收站），不动分段源文件
    // 分段源文件由「删除分组」入口管理，两个入口职责分离，互不误删
    await shell.trashItem(mp4Path)

    mergedFiles.invalidateCache()
    scanCache.clear()
    // 清理对应的场次记录：分段源文件仍在，重新扫描后该场次会重新出现在分组里，可再次合并；
    // 同一天其他场次若还有合并 MP4，保留其记录（新格式按场次精确清理，旧格式由 legacy 兜底隐藏）
    {
      const cfg = loadConfig()
      const sessions = removeMergedSessionsForDeletedMp4(cfg.mergedSessions || [], safeName)
      if (sessions.length !== (cfg.mergedSessions || []).length) {
        saveConfig({ mergedSessions: sessions })
        console.log(`[delete] 清理已合并场次记录: ${safeName}`)
      }
    }
    console.log(`[delete] 已删除合并 MP4: ${fileName}`)
    return { success: true, data: { segmentCount: 0 } }
  } catch (error: any) {
    console.error('[delete] 删除失败:', error)
    return { success: false, message: error.message || '删除失败' }
  }
})

// 24. 已移除：投稿列表现在是输出文件夹的实时扫描，不支持从列表移除

// 27. 清理文件面板：列出所有分段源文件 + 所有已合并 MP4（供一键删除）
interface CleanupFileItem {
  path: string
  name: string
  size: number
  mtime: number
  date: string
  title: string
  /** 该场直播开始时间戳（从文件名解析） */
  timestamp?: number
  /** 场次标识：同一场直播（含跨天）的所有分段文件相同 */
  sessionKey?: string
}

ipcMain.handle('files:listAll', () => {
  const config = loadConfig()
  const inputFolders = [config.inputFolder, config.inputFolder2].filter(Boolean) as string[]
  const outputFolder = config.outputFolder || ''
  const segments: CleanupFileItem[] = []
  const merged: CleanupFileItem[] = []

  const parseSeg = (name: string): { date: string; title: string; timestamp: number } => {
    const noExt = stripVideoExtension(name).replace(/_PART\d+$/i, '')
    const match = noExt.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}-\d{2}-\d{2}-\d{3})\s*(.+)$/)
    if (match) {
      const t = match[2].split('-')
      const timestamp = new Date(`${match[1]}T${t[0]}:${t[1]}:${t[2]}`).getTime()
      return { date: match[1], title: match[3].trim() || '未命名', timestamp: Number.isNaN(timestamp) ? 0 : timestamp }
    }
    return { date: '未知日期', title: noExt.trim() || '未命名', timestamp: 0 }
  }

  const scanDirForSegments = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      try {
        if (entry.isDirectory()) {
          scanDirForSegments(full)
        } else if (entry.isFile() && isVideoFile(entry.name)) {
          const s = statSync(full)
          const { date, title, timestamp } = parseSeg(entry.name)
          segments.push({ path: full, name: entry.name, size: s.size, mtime: s.mtimeMs, date, title, timestamp })
        }
      } catch {
        // 跳过无法访问的条目
      }
    }
  }

  for (const dir of inputFolders) scanDirForSegments(dir)

  if (outputFolder && existsSync(outputFolder)) {
    try {
      const entries = readdirSync(outputFolder)
      for (const name of entries) {
        if (!name.toLowerCase().endsWith('.mp4')) continue
        const full = join(outputFolder, name)
        try {
          const s = statSync(full)
          const { date, title } = parseMergedFileName(name)
          merged.push({ path: full, name, size: s.size, mtime: s.mtimeMs, date, title })
        } catch {
          // 忽略单个文件读取失败
        }
      }
    } catch {
      // 输出目录不存在
    }
  }

  // 按场次分组：完整复用 performScan 的分组规则（同标题且间隔 ≤ maxIntervalHours 视为同一场，
  // 支持跨天；间隔过大时回查已有分组，标题回切也能归回同一场）
  {
    const MAX_GAP = (config.maxIntervalHours || 2.5) * 60 * 60 * 1000
    segments.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
    const pad2 = (n: number): string => String(n).padStart(2, '0')
    const makeKey = (seg: CleanupFileItem): string => {
      const d = new Date(seg.timestamp ?? 0)
      return `${seg.date}_${seg.title}_${Number.isNaN(d.getTime()) ? '000000' : pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())}`
    }
    interface SessionGroup {
      key: string
      title: string
      last: number
    }
    let cur: SessionGroup | null = null
    const groups: SessionGroup[] = []
    for (const seg of segments) {
      const ts = seg.timestamp ?? 0
      let owner: SessionGroup
      if (!cur) {
        cur = { key: makeKey(seg), title: seg.title, last: ts }
        owner = cur
      } else if (seg.title === cur.title && ts - cur.last <= MAX_GAP) {
        cur.last = ts
        owner = cur
      } else {
        const matched = groups.find((g) => g.title === seg.title && ts - g.last <= MAX_GAP)
        if (matched) {
          matched.last = ts
          owner = matched
        } else {
          groups.push(cur)
          cur = { key: makeKey(seg), title: seg.title, last: ts }
          owner = cur
        }
      }
      seg.sessionKey = owner.key
    }
  }

  // 分段按 日期倒序 + 标题 + 文件名；合并 MP4 按修改时间倒序
  segments.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title) || a.name.localeCompare(b.name))
  merged.sort((a, b) => b.mtime - a.mtime)

  console.log(`[files:listAll] 分段源文件 ${segments.length} 个，已合并 MP4 ${merged.length} 个`)
  return { success: true, data: { segments, merged } }
})

// 28. 清理文件：批量将指定文件移至回收站（分段源文件 / 已合并 MP4 均可）
ipcMain.handle('files:delete', async (_event, paths: string[]) => {
  try {
    if (!paths || paths.length === 0) {
      return { success: true, data: { deleted: 0, failed: [] } }
    }

    // 路径白名单：只允许删除输入目录或输出目录下的文件，防止越权删除任意路径
    const cfg0 = loadConfig()
    const allowedBases = [cfg0.inputFolder, cfg0.inputFolder2, cfg0.outputFolder].filter(Boolean) as string[]
    const isAllowed = (p: string): boolean => {
      if (!p) return false
      const abs = resolve(p)
      return allowedBases.some((base) => {
        if (!base) return false
        const rel = relative(resolve(base), abs)
        return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
      })
    }
    const validPaths = paths.filter(isAllowed)
    const failed: string[] = paths.filter((p) => !isAllowed(p)).concat(validPaths.filter((p) => !existsSync(p)))

    let deleted = 0
    const deletedPaths: string[] = []
    for (const p of validPaths) {
      try {
        if (existsSync(p)) {
          await shell.trashItem(p)
          deleted++
          deletedPaths.push(p)
        }
      } catch (e) {
        console.warn('[files:delete] 移至回收站失败:', p, e)
        failed.push(p)
      }
    }

    // 清理已合并场次记录：只对成功删除的文件清理（避免删除失败却清除记录）
    const cfg = loadConfig()
    let sessions = cfg.mergedSessions || []
    for (const p of deletedPaths) {
      const name = basename(p)
      if (name.toLowerCase().endsWith('.mp4')) {
        sessions = removeMergedSessionsForDeletedMp4(sessions, name)
      } else {
        const s = parseSessionFromFilePaths([p])
        if (s) sessions = removeMergedSessionsByGroup(sessions, s.date, s.title, s.startTs, s.endTs)
      }
    }
    if (sessions.length !== (cfg.mergedSessions || []).length) {
      saveConfig({ mergedSessions: sessions })
    }

    // 失效所有相关缓存
    scanCache.clear()
    mergedFiles.invalidateCache()

    console.log(`[files:delete] 删除 ${deleted} 个文件，失败 ${failed.length} 个`)
    return { success: true, data: { deleted, failed } }
  } catch (error: any) {
    console.error('[files:delete] 删除失败:', error)
    return { success: false, message: error.message || '删除失败' }
  }
})

// 28b. 自动清理：把超过保留天数的录制片段与合并产物移至回收站（默认开启，可在设置里关闭）
const AUTO_CLEAN_INTERVAL_MS = 24 * 60 * 60 * 1000 // 每 24 小时检查一次
const DAY_MS = 24 * 60 * 60 * 1000

/** 从分段文件名解析直播时间戳（与 parseSessionFromFilePaths 规则一致），解析不到返回 0 */
function parseSegmentTimestamp(fileName: string): number {
  const base = basename(fileName).replace(/\.(flv|m4s|blv)$/i, '').replace(/_PART\d+$/i, '')
  const m = base.match(/^(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})-(\d{2})-\d{3}/)
  if (!m) return 0
  const ts = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`).getTime()
  return Number.isNaN(ts) ? 0 : ts
}

/** 递归列出目录下指定扩展名的文件（含主播子目录），可排除某些目录（如输出目录） */
function listVideoFiles(
  folder: string | undefined,
  re: RegExp,
  opts: { depth?: number; exclude?: string[] } = {},
): Array<{ path: string; name: string; mtime: number }> {
  const depth = opts.depth ?? 0
  const exclude = opts.exclude ?? []
  const out: Array<{ path: string; name: string; mtime: number }> = []
  if (!folder || depth > 4 || !existsSync(folder)) return out
  try {
    for (const f of readdirSync(folder)) {
      const full = join(folder, f)
      // 跳过需要排除的目录（如 outputFolder 本身，避免把合并产物当分段处理）
      if (exclude.some((e) => e && resolve(e) === resolve(full))) continue
      try {
        const st = statSync(full)
        if (st.isFile()) {
          if (re.test(f)) out.push({ path: full, name: f, mtime: st.mtimeMs })
        } else if (st.isDirectory()) {
          // 分段文件在「主播名」子目录里，必须递归找
          out.push(...listVideoFiles(full, re, { depth: depth + 1, exclude }))
        }
      } catch { /* 跳过读不到的项 */ }
    }
  } catch { /* 目录不可读 */ }
  return out
}

/**
 * 自动清理：把超过保留天数的分段源文件与合并 MP4 移至回收站（可恢复）。
 * 判定时间优先用文件名里的直播时间，取不到时退回文件修改时间。
 * 开关关闭（autoCleanEnabled === false）时不执行。
 */
export async function autoCleanupOldFiles(reason = 'schedule'): Promise<{ segments: number; mp4: number }> {
  const cfg = loadConfig()
  if (cfg.autoCleanEnabled === false) return { segments: 0, mp4: 0 }
  const days = Math.max(1, cfg.autoCleanDays ?? 7)
  const cutoff = Date.now() - days * DAY_MS

  // 1) 分段源文件（inputFolder / inputFolder2，递归含主播子目录；排除输出目录）
  const segments: string[] = []
  for (const folder of [cfg.inputFolder, cfg.inputFolder2].filter(Boolean) as string[]) {
    for (const f of listVideoFiles(folder, /\.(flv|m4s|blv)$/i, { exclude: [cfg.outputFolder || ''] })) {
      const t = parseSegmentTimestamp(f.name) || f.mtime
      if (t < cutoff) segments.push(f.path)
    }
  }

  // 2) 合并产物（outputFolder）：scanFolder 返回的 mtime 即直播间时间戳（解析不到时退回文件时间）
  const mp4s: string[] = []
  for (const f of mergedFiles.scanFolder(cfg.outputFolder || '')) {
    if ((f.mtime || 0) < cutoff) mp4s.push(f.path)
  }

  if (segments.length === 0 && mp4s.length === 0) {
    console.log(`[autoCleanup] (${reason}) 无超过 ${days} 天的文件`)
    return { segments: 0, mp4: 0 }
  }

  let nSeg = 0
  let nMp4 = 0
  const deletedMp4Names: string[] = []
  for (const p of segments) {
    try {
      if (existsSync(p)) { await shell.trashItem(p); nSeg++ }
    } catch (e) {
      console.warn('[autoCleanup] 片段移至回收站失败:', p, e)
    }
  }
  for (const p of mp4s) {
    try {
      if (existsSync(p)) { await shell.trashItem(p); nMp4++; deletedMp4Names.push(basename(p)) }
    } catch (e) {
      console.warn('[autoCleanup] 合并视频移至回收站失败:', p, e)
    }
  }

  // 清理被删合并视频对应的场次记录（片段被删但 MP4 还在时保留记录）
  if (deletedMp4Names.length) {
    const cfg2 = loadConfig()
    let sessions = cfg2.mergedSessions || []
    for (const name of deletedMp4Names) sessions = removeMergedSessionsForDeletedMp4(sessions, name)
    if (sessions.length !== (cfg2.mergedSessions || []).length) saveConfig({ mergedSessions: sessions })
  }

  scanCache.clear()
  mergedFiles.invalidateCache()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('files:changed')
  }
  console.log(`[autoCleanup] (${reason}) 保留 ${days} 天：片段 ${nSeg} 个、合并视频 ${nMp4} 个 已移至回收站`)
  return { segments: nSeg, mp4: nMp4 }
}

/** 启动自动清理：应用启动后延迟跑一次 + 每 24 小时一次（开关关闭则不跑） */
function startAutoCleanup(): void {
  const cfg = loadConfig()
  if (cfg.autoCleanEnabled === false) {
    console.log('[autoCleanup] 已在设置中关闭，跳过')
    return
  }
  const days = cfg.autoCleanDays ?? 7
  // 启动后 30 秒跑一次（避开启动高峰）
  setTimeout(() => {
    autoCleanupOldFiles('startup').catch((e) => console.error('[autoCleanup] 启动清理异常:', e))
  }, 30 * 1000)
  // 之后每 24 小时一次
  setInterval(() => {
    autoCleanupOldFiles('schedule').catch((e) => console.error('[autoCleanup] 定时清理异常:', e))
  }, AUTO_CLEAN_INTERVAL_MS)
  console.log(`[autoCleanup] 已启用：每 24 小时清理超过 ${days} 天的片段与合并视频（移至回收站）`)
}

// ============ 定时自动合并 ============

/** 合并输出文件名（与渲染层 genMergeFileName 一致：标题_日期_时分秒） */
function genAutoMergeFileName(folder: { title: string; date: string; startTimestamp: number }): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = new Date(folder.startTimestamp || 0)
  const hhmmss = Number.isNaN(d.getTime())
    ? ''
    : `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${folder.title}_${folder.date}${hhmmss ? '_' + hhmmss : ''}`
}

/** 已执行过的定时槽位，防止同一时间点重复触发 */
let lastAutoMergeSlot = ''

/**
 * 执行一次「定时自动合并」：扫描 → 合并所有待合并场次 → 按开关决定是否投稿。
 * 串行合并：定时任务多在夜间无人值守时跑，稳定优先。
 * 已合并过的场次（精确到时间区间）和用户排除的分组都会自动跳过。
 */
async function runAutoMerge(): Promise<void> {
  const cfg = loadConfig()
  if (!cfg.autoMergeEnabled) return
  if (!cfg.inputFolder || !cfg.outputFolder) {
    console.log('[autoMerge] 未配置输入/输出文件夹，跳过')
    return
  }
  if (isMerging) {
    console.log('[autoMerge] 当前正在合并，跳过本次')
    return
  }

  console.log('[autoMerge] ===== 开始定时合并 =====')
  const scan = await performScan(cfg.inputFolder, cfg.maxIntervalHours || 2.5, cfg.outputFolder, true)
  const hidden = new Set(cfg.hiddenFolderKeys || [])
  const sessions = cfg.mergedSessions || []

  // 只合并「昨天」的场次：定时任务多在凌晨跑，今天还在录的分组不能动，
  // 更早的日期也不碰（可能是漏跑或用户特意保留的）
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const nowD = new Date()
  nowD.setDate(nowD.getDate() - 1)
  const yesterday = `${nowD.getFullYear()}-${pad2(nowD.getMonth() + 1)}-${pad2(nowD.getDate())}`

  const pending = scan.folders.filter((f) => {
    if (f.date !== yesterday) return false
    if (hidden.has(f.key) || hidden.has(`${f.date}_${f.title}`)) return false
    return !isSessionMerged(sessions, f.date, f.title, f.startTimestamp, f.lastTimestamp)
  })

  if (!pending.length) {
    console.log(`[autoMerge] 没有待合并的场次（仅处理昨天 ${yesterday}）`)
    return
  }
  console.log(`[autoMerge] 发现 ${pending.length} 个待合并场次（昨天 ${yesterday}）`)

  isMerging = true
  const mergedPaths: string[] = []
  try {
    for (const f of pending) {
      const name = genAutoMergeFileName(f)
      const outPath = join(cfg.outputFolder, name + '.mp4')
      if (existsSync(outPath)) {
        console.log(`[autoMerge] 输出已存在，跳过: ${name}.mp4`)
        continue
      }
      const filePaths = f.files.map((x) => x.path)
      try {
        console.log(`[autoMerge] 正在合并: ${name}`)
        await mergeVideos(filePaths, outPath, () => { /* 定时任务不对外上报进度 */ })
        recordMergedSessionFromPaths(filePaths)
        mergedPaths.push(outPath)
        console.log(`[autoMerge] 合并完成: ${name}`)
      } catch (e: any) {
        console.error(`[autoMerge] 合并失败: ${name} -`, e?.message || e)
      }
    }
  } finally {
    isMerging = false
  }

  if (!mergedPaths.length) {
    console.log('[autoMerge] 本次没有产出新文件')
    return
  }
  console.log(`[autoMerge] 本次合并完成 ${mergedPaths.length} 个文件`)

  if (cfg.autoMergeUpload) {
    try {
      await uploadMergedFiles(mergedPaths)
      console.log('[autoMerge] 已打开投稿页，等待插件自动上传')
    } catch (e: any) {
      console.error('[autoMerge] 打开投稿页失败:', e?.message || e)
    }
  } else {
    console.log('[autoMerge] 未开启自动投稿，仅完成合并')
  }
}

/**
 * 启动定时合并调度：每 30 秒检查一次是否到达设定时间。
 * 30 秒而非 60 秒，避免整分钟边界抖动导致错过；用槽位去重保证同一分钟只跑一次。
 */
function startAutoMergeTimer(): void {
  const tick = async (): Promise<void> => {
    try {
      const cfg = loadConfig()
      if (!cfg.autoMergeEnabled) return
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`
      if ((cfg.autoMergeTime || '03:00') !== hhmm) return
      const slot = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${hhmm}`
      if (lastAutoMergeSlot === slot) return
      lastAutoMergeSlot = slot
      await runAutoMerge()
    } catch (e: any) {
      console.error('[autoMerge] 调度异常:', e?.message || e)
    }
  }
  setInterval(() => { void tick() }, 30 * 1000)
  console.log('[autoMerge] 定时合并调度已启动（每 30 秒检查一次）')
}

// 25. 获取网络信息（已由 18b 注册，不再重复）

// 26. 投稿已合并的文件（注册文件 + 打开B站投稿页）
/**
 * 打开 B站投稿页并注册待上传文件（供 IPC 与定时任务共用）
 * @returns 注册后的本地文件 URL 列表
 */
async function uploadMergedFiles(filePaths: string[]): Promise<{ fileUrls: string[] }> {
  // 重置投稿完成状态
  uploadDone = false
  if (uploadDoneTimer) { clearTimeout(uploadDoneTimer); uploadDoneTimer = null }
  const fileUrls: string[] = []
  for (const fp of filePaths) {
    const url = await registerFileForServe(fp)
    fileUrls.push(url)
  }
  // 打开B站投稿页
  let bilibiliUrl = 'https://member.bilibili.com/platform/upload/video/frame'
  bilibiliUrl += '?autoFiles=' + fileUrls.map((u) => encodeURIComponent(u)).join(',')
  shell.openExternal(bilibiliUrl)
  return { fileUrls }
}

ipcMain.handle('mergedFiles:upload', async (_event, filePaths: string[]) => {
  if (!filePaths || filePaths.length === 0) {
    return { success: false, message: '未指定文件' }
  }
  const { fileUrls } = await uploadMergedFiles(filePaths)
  return { success: true, data: { fileUrls } }
})

// 设置用户数据目录（开发模式用项目内目录，打包后用系统默认目录）
if (is.dev) {
  app.setPath('userData', join(__dirname, '../../user-data'))
}

// 全局未捕获异常处理
process.on('uncaughtException', (error) => {
  console.error('[App] 未捕获的异常:', error)
})
process.on('unhandledRejection', (reason) => {
  console.error('[App] 未处理的 Promise 拒绝:', reason)
})

// 应用启动
app.whenReady().then(() => {
  // 去掉默认菜单栏
  Menu.setApplicationMenu(null)

  electronApp.setAppUserModelId('com.videomerger.app')
  
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // 启动手机控制服务器
  const config = loadConfig()
  // 根据配置设置原生主题（窗口标题栏颜色跟随深色模式）
  nativeTheme.themeSource = config.darkMode ? 'dark' : 'light'
  setConfigCallbacks(loadConfig, saveConfig, invalidateConfigCache)
  setFileServerCallback(registerFileForServe)
  setOpenExternalCallback((url: string) => { shell.openExternal(url) })
  // 设置扫描回调：手机控制面板调用扫描时，使用与主 App 完全相同的扫描逻辑
  setScanCallback(async (folderPath: string, maxIntervalHours: number) => {
    // 强制从磁盘读取最新配置（文件监听器可能漏掉外部编辑，确保手机端始终使用最新配置）
    invalidateConfigCache()
    const latestCfg = loadConfig()
    // 手机端扫描一律绕过缓存：合并/删除后「已合并场次」判定必须立即生效
    const result = await performScan(folderPath, maxIntervalHours, latestCfg.outputFolder || '', true)
    // 返回全量列表（由调用方自行过滤排除项，用于已排除列表查询）
    return result.folders
  })
  // 手机端删除文件后：清主 App 扫描缓存并通知渲染层刷新列表
  setFilesChangedCallback(() => {
    scanCache.clear()
    mergedFiles.invalidateCache()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('files:changed')
    }
  })
  // 设置排除列表更新回调（手机操作排除时同步到主 App）
  setUpdateHiddenKeysCallback((keys: string[]) => {
    saveConfig({ hiddenFolderKeys: keys })
    // 通知渲染进程刷新
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('config:updated')
    }
  })
  // 设置投稿完成状态查询回调（手机控制面板可获取投稿是否完成）
  setUploadDoneCallback(() => uploadDone)
  // 设置投稿完成状态重置回调（新一轮投稿开始时清除旧状态）
  setResetUploadDoneCallback(() => {
    uploadDone = false
    if (uploadDoneTimer) { clearTimeout(uploadDoneTimer); uploadDoneTimer = null }
  })
  // 设置主 App 合并状态检查回调（防止手机端与桌面端同时合并）
  setIsMainAppMergingCallback(() => isMerging)
  setMergeLockCallbacks(getIsMerging, setIsMerging)
  if (config.controlEnabled !== false) {
    startControlServer(config.controlPort || 9820).catch((e) => {
      console.error('[App] 控制服务器启动失败:', e)
    })
  }

  // 启动配置文件监听（手机端修改配置时同步到电脑端）
  startConfigWatcher()

  // 自动清理：删除 N 天前的录制片段与合并产物（移至回收站，默认开启）
  startAutoCleanup()

  // 定时自动合并：到点扫描并合并待处理场次（默认关闭）
  startAutoMergeTimer()

  // 后台运行模式：创建托盘图标
  if (config.runInBackground) {
    createTray()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else if (mainWindow) {
      // 从托盘恢复窗口
      mainWindow.show()
      mainWindow.focus()
    }
  })
})

app.on('window-all-closed', () => {
  // 后台运行模式下不退出
  const config = loadConfig()
  if (config.runInBackground && !forceQuit) {
    return
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  forceQuit = true
  stopControlServer()
  destroyTray()
})
