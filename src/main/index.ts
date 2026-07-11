import { app, shell, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, NativeImage } from 'electron'
import { join, relative, dirname, extname, basename } from 'path'
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
  applyExcludeFilter
} from './controlServer'
import * as mergedFiles from './mergedFiles'

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

/** 创建系统托盘图标 */
function createTray(): void {
  if (appTray) return
  // 用代码生成一个简单的 16x16 托盘图标（蓝色圆形 + V 字母）
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAhElEQVQ4T2NkoBAwUqifYdAY8B8E/v9nYPz/H8wAM4BxMBjwn+E/AwMDIyMDYzADshDFDIb/DAz/GRn+M/zHxQOm/wwM/8EMFkYYA1AM+M/AwMjIwMjIAMwwDLIA2YB/DAwM/0EMFkYYA1AM+M/AwMjIwMjIAMwwDLIAxYB/DAwM/0EMAAHEf5ZB7P+0AAAAAElFTkSuQmCC'
  )
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

// 支持的视频格式
const VIDEO_EXTENSIONS = ['.flv', '.m4s', '.ts', '.blv']

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
    } | null = null

    const MAX_INTERVAL_MS = maxIntervalHours * 60 * 60 * 1000

    for (const file of files) {
      if (!currentGroup) {
        currentGroup = {
          key: `${file.date}_${file.title}`,
          folderName: `${file.date} ${file.title}`,
          folderPath: dirname(file.path),
          fileCount: 1,
          totalSize: file.size,
          files: [file],
          date: file.date,
          title: file.title,
          lastTimestamp: file.timestamp
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
            if (group.title === file.title && group.date === file.date) {
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
              key: `${file.date}_${file.title}`,
              folderName: `${file.date} ${file.title}`,
              folderPath: dirname(file.path),
              fileCount: 1,
              totalSize: file.size,
              files: [file],
              date: file.date,
              title: file.title,
              lastTimestamp: file.timestamp
            }
          }
        }
      }
    }

    if (currentGroup) {
      groups.push(currentGroup)
    }
  }

  groups.sort((a, b) => b.fileCount - a.fileCount || b.date.localeCompare(a.date))

  console.log(`[performScan] 共找到 ${files.length} 个文件，分成 ${groups.length} 组`)
  groups.forEach((g, i) => {
    console.log(`[performScan] 组${i}: key=${g.key}, fileCount=${g.fileCount}, files=${g.files.map(f => f.name).join(', ')}`)
  })

  // 过滤掉正在录制中的直播：整场直播只要有任何 PART 文件，整组都不显示
  const isRecording = (group: { files: FlvFile[] }): boolean =>
    group.files.some((f) => /_PART\d+/i.test(f.name))
  const nonRecordingGroups = groups.filter((g) => !isRecording(g))

  // 过滤掉已经合并过的分组（输出文件夹中已有对应 MP4）
  // 优化：一次性扫描输出文件夹，构建已合并文件的 Set，避免每个分组都递归扫描
  const hasMergedVideo = (dir: string, date: string, title: string, mergedSet: Set<string>): boolean => {
    const dateLower = date.toLowerCase()
    const titleLower = title.toLowerCase()
    // 检查 Set 中是否有匹配的已合并文件
    for (const entry of mergedSet) {
      const entryLower = entry.toLowerCase()
      if (entryLower.startsWith(dateLower) && entryLower.includes(titleLower)) {
        return true
      }
    }
    return false
  }

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
  
  const filteredGroups = nonRecordingGroups.filter((group) => {
    return !hasMergedVideo(searchDir, group.date, group.title, mergedFilesSet)
  })

  // 写入扫描缓存
  const result = { rootPath: folderPath, folders: filteredGroups }
  scanCache.set(`${folderPath}|${maxIntervalHours}|${outputFolder}`, { data: result, timestamp: Date.now() })

  console.log(`[performScan] 过滤后剩余 ${filteredGroups.length} 组`)
  return result
}

// IPC 处理器：渲染进程调用扫描
ipcMain.handle('scan:flvFiles', async (_event, folderPath: string, maxIntervalHours: number = 2.5, outputFolder: string = '') => {
  try {
    const result = await performScan(folderPath, maxIntervalHours, outputFolder, true)
    // 同步扫描结果到控制服务器（手机列表与 App 一致，包含排除列表过滤）
    const latestConfig = loadConfig()
    const hiddenKeys = new Set(latestConfig.hiddenFolderKeys || [])
    const filteredForControl = result.folders.filter((f) => !hiddenKeys.has(f.key))
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

// 22. 获取已合并文件列表（投稿页使用，扫描输出文件夹）
ipcMain.handle('mergedFiles:get', () => {
  const config = loadConfig()
  const outputFolder = config.outputFolder || ''
  console.log('[mergedFiles:get] outputFolder:', outputFolder)
  const files = mergedFiles.scanFolder(outputFolder)
  console.log('[mergedFiles:get] 找到文件数:', files.length, files.map(f => f.name))
  return { success: true, data: files }
})

// 23. 已移除：投稿列表现在是输出文件夹的实时扫描，不支持从列表移除
// 24. 已移除：同上

// 25. 获取网络信息（已由 18b 注册，不再重复）

// 26. 投稿已合并的文件（注册文件 + 打开B站投稿页）
ipcMain.handle('mergedFiles:upload', async (_event, filePaths: string[]) => {
  if (!filePaths || filePaths.length === 0) {
    return { success: false, message: '未指定文件' }
  }
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
  setConfigCallbacks(loadConfig, saveConfig)
  setFileServerCallback(registerFileForServe)
  setOpenExternalCallback((url: string) => { shell.openExternal(url) })
  // 设置扫描回调：手机控制面板调用扫描时，使用与主 App 完全相同的扫描逻辑
  setScanCallback(async (folderPath: string, maxIntervalHours: number) => {
    const latestCfg = loadConfig()
    const result = await performScan(folderPath, maxIntervalHours, latestCfg.outputFolder || '')
    // 应用排除列表（hiddenFolderKeys），保持与 App 列表一致
    const latestConfig = loadConfig()
    const hiddenKeys = new Set(latestConfig.hiddenFolderKeys || [])
    const filtered = result.folders.filter((f) => !hiddenKeys.has(f.key))
    updateScanResults(filtered)
    return filtered
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
