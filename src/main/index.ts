import { app, shell, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import { join, relative, dirname } from 'path'
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { getVideoInfo, convertToMp4, mergeVideos } from './ffmpeg'

let mainWindow: BrowserWindow | null = null

// 进度存储（渲染进程通过轮询获取，不依赖 contextBridge 的监听器回调）
let mergeProgress = 0
let convertProgress = 0

// 批量合并进度存储：Map<taskId, progress>
const batchMergeProgress = new Map<string, number>()

// ============ 配置管理：记住用户设置 ============

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

function getConfigPath(): string {
  const dir = join(app.getPath('userData'))
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, 'config.json')
}

function loadConfig(): AppConfig {
  try {
    const path = getConfigPath()
    console.log('[loadConfig] 路径:', path)
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf-8'))
      console.log('[loadConfig] 读取到:', JSON.stringify(data))
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
    const current = loadConfig()
    const merged = { ...current, ...config }
    const path = getConfigPath()
    console.log('[saveConfig] 写入:', JSON.stringify(merged))
    writeFileSync(path, JSON.stringify(merged, null, 2), 'utf-8')
    console.log('[saveConfig] 写入成功')
  } catch (e) {
    console.error('[saveConfig] 写入失败:', e)
  }
}

// ============ 窗口创建 ============

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
ipcMain.handle('scan:flvFiles', async (_event, folderPath: string, maxIntervalHours: number = 2.5) => {
  try {
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
      const nameWithoutExt = stripVideoExtension(fileName)
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

    const scanDir = (dir: string): void => {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (entry.startsWith('.')) continue
        const fullPath = join(dir, entry)
        try {
          const s = statSync(fullPath)
          if (s.isDirectory()) {
            scanDir(fullPath)
          } else if (isVideoFile(entry)) {
            const { date, time, title } = parseFileName(entry)
            const timeParts = time.split('-')
            const timestamp = timeParts.length >= 4
              ? new Date(`${date}T${timeParts[0]}:${timeParts[1]}:${timeParts[2]}`).getTime()
              : s.mtime.getTime()

            files.push({
              name: entry,
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

    scanDir(folderPath)

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

    const hasMergedVideo = (dir: string, date: string, title: string): boolean => {
      try {
        const entries = readdirSync(dir)
        for (const entry of entries) {
          if (!entry.toLowerCase().endsWith('.mp4')) continue
          const entryLower = entry.toLowerCase()
          const dateLower = date.toLowerCase()
          const titleLower = title.toLowerCase()
          if (entryLower.includes(dateLower) && entryLower.includes(titleLower)) {
            return true
          }
        }
        for (const entry of entries) {
          const fullPath = join(dir, entry)
          try {
            if (statSync(fullPath).isDirectory() && entry !== '.') {
              if (hasMergedVideo(fullPath, date, title)) return true
            }
          } catch {
            // 跳过无法访问的目录
          }
        }
      } catch {
        // 目录不存在
      }
      return false
    }

    const filteredGroups = groups.filter((group) => {
      return !hasMergedVideo(folderPath, group.date, group.title)
    })

    return { success: true, data: { rootPath: folderPath, folders: filteredGroups } }
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
  // 初始化所有任务的进度为0
  for (const task of tasks) {
    batchMergeProgress.set(task.taskId, 0)
  }

  const results: BatchMergeResult[] = []
  let currentIndex = 0

  // 工作函数：从任务队列中取出任务执行
  const worker = async (): Promise<void> => {
    while (currentIndex < tasks.length) {
      const taskIndex = currentIndex++
      const task = tasks[taskIndex]

      try {
        const warning = await mergeVideos(task.filePaths, task.outputPath, (percent) => {
          batchMergeProgress.set(task.taskId, percent)
        })
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
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
  await Promise.all(workers)

  // 清理进度记录
  for (const task of tasks) {
    batchMergeProgress.delete(task.taskId)
  }

  return { success: true, data: results }
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

// 设置用户数据目录（开发模式用项目内目录，打包后用系统默认目录）
if (is.dev) {
  app.setPath('userData', join(__dirname, '../../user-data'))
}

// 应用启动
app.whenReady().then(() => {
  // 去掉默认菜单栏
  Menu.setApplicationMenu(null)

  electronApp.setAppUserModelId('com.videomerger.app')
  
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
