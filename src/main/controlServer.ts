// controlServer.ts - 局域网手机控制面板服务器
// 提供 REST API + 移动端网页，手机在同一 WiFi 下通过浏览器控制 App

import { createServer, Server, IncomingMessage, ServerResponse } from 'http'
import { networkInterfaces } from 'os'
import { join, basename } from 'path'
import { writeFileSync } from 'fs'
import { mergeVideos } from './ffmpeg'
import * as mergedFiles from './mergedFiles'
import { invalidateCache } from './mergedFiles'

// ============ 类型定义 ============

interface VideoGroup {
  key: string
  folderName: string
  folderPath: string
  fileCount: number
  totalSize: number
  files: Array<{ name: string; path: string; size: number; modifiedAt: string }>
  date: string
  title: string
  lastTimestamp: number
}

interface AppConfig {
  inputFolder?: string
  outputFolder?: string
  maxIntervalHours?: number
  concurrency?: number
  pluginLinkage?: boolean
  autoCloseBrowser?: boolean
  autoCloseApp?: boolean
  controlPassword?: string
  hiddenFolderKeys?: string[]
}

// ============ 状态管理 ============

let controlServer: Server | null = null
let controlPort = 9820
let appStatus: 'idle' | 'scanning' | 'merging' | 'uploading' = 'idle'
let appStatusSince = Date.now() // 记录状态开始时间，用于超时判断
let mergePercent = 0
let currentMergeTask = ''
let mergeTotalTasks = 0
let mergeCurrentIndex = 0
let lastGroups: VideoGroup[] = []
let configRef: AppConfig = {}
let saveConfigFn: ((config: AppConfig) => void) | null = null
let loadConfigFn: (() => AppConfig) | null = null
let registerFileForServeFn: ((filePath: string) => Promise<string>) | null = null
let openExternalFn: ((url: string) => void) | null = null
// 主 App 的扫描函数回调（保证手机列表与 App 一致）
let scanFromMainApp: ((folderPath: string, maxIntervalHours: number) => Promise<VideoGroup[]>) | null = null
// 更新排除列表的回调（通知主 App 同步排除状态）
let updateHiddenKeysFn: ((keys: string[]) => void) | null = null
// 获取投稿完成状态的回调（由主 App 设置，插件投稿完成后返回 true）
let getUploadDoneFn: (() => boolean) | null = null
// 重置投稿完成状态的回调（新一轮投稿开始时调用）
let resetUploadDoneFn: (() => void) | null = null
// 检查主 App 是否正在合并（防止手机端与桌面端同时合并）
let isMainAppMergingFn: (() => boolean) | null = null
// 合并互斥锁回调（由主 App 设置，统一控制合并状态）
let getIsMergingFn: (() => boolean) | null = null
let setIsMergingFn: ((value: boolean) => void) | null = null
// 登录限频：记录每个 IP 的失败次数和时间
const loginAttempts = new Map<string, { count: number; lastTime: number }>()
// 扫描互斥标志
let isScanning = false

// 投稿中的文件名列表（展示用手机端）
let uploadFileNames: string[] = []

// 合并文件列表缓存（避免每秒轮询都扫描目录）
let cachedMergedFiles: mergedFiles.MergedFile[] = []
let cachedMergedFilesTime = 0
const MERGED_FILES_CACHE_TTL = 5000 // 5秒缓存

// ============ 工具函数 ============

/** 获取本机局域网 IPv4 地址 */
export function getLocalIP(): string {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address
      }
    }
  }
  return '127.0.0.1'
}

/** 设置配置回调 */
export function setConfigCallbacks(
  loadConfig: () => AppConfig,
  saveConfig: (config: AppConfig) => void
): void {
  loadConfigFn = loadConfig
  saveConfigFn = saveConfig
  configRef = loadConfig()
}

/** 刷新配置缓存（配置文件变更时调用） */
export function refreshConfig(): void {
  if (loadConfigFn) {
    configRef = loadConfigFn()
  }
}

/** 设置文件服务器回调 */
export function setFileServerCallback(register: (filePath: string) => Promise<string>): void {
  registerFileForServeFn = register
}

/** 设置打开外部链接回调 */
export function setOpenExternalCallback(fn: (url: string) => void): void {
  openExternalFn = fn
}

/** 设置主 App 扫描回调（保证手机列表与 App 完全一致） */
export function setScanCallback(
  fn: (folderPath: string, maxIntervalHours: number) => Promise<VideoGroup[]>
): void {
  scanFromMainApp = fn
}

/** 设置排除列表更新回调 */
export function setUpdateHiddenKeysCallback(fn: (keys: string[]) => void): void {
  updateHiddenKeysFn = fn
}

/** 设置投稿完成状态查询回调 */
export function setUploadDoneCallback(fn: () => boolean): void {
  getUploadDoneFn = fn
}

/** 设置投稿完成状态重置回调 */
export function setResetUploadDoneCallback(fn: () => void): void {
  resetUploadDoneFn = fn
}

/** 设置主 App 合并状态检查回调 */
export function setIsMainAppMergingCallback(fn: () => boolean): void {
  isMainAppMergingFn = fn
}

/** 设置合并互斥锁回调 */
export function setMergeLockCallbacks(
  get: () => boolean,
  set: (value: boolean) => void
): void {
  getIsMergingFn = get
  setIsMergingFn = set
}

/** 主 App 扫描完成后同步结果到控制面板 */
export function updateScanResults(groups: VideoGroup[]): void {
  lastGroups = groups
}

/** 根据当前排除列表过滤 lastGroups（桌面端排除分组后调用） */
export function applyExcludeFilter(): void {
  if (loadConfigFn) configRef = loadConfigFn()
  const hiddenKeys = new Set(configRef.hiddenFolderKeys || [])
  lastGroups = lastGroups.filter((g) => !hiddenKeys.has(g.key))
}

/** 获取过滤后的分组列表 */
function getFilteredGroups(): VideoGroup[] {
  const hiddenKeys = new Set(configRef.hiddenFolderKeys || [])
  return lastGroups.filter((g) => !hiddenKeys.has(g.key))
}

/** 获取控制服务器地址 */
export function getControlUrl(): string {
  if (!controlServer) return ''
  const ip = getLocalIP()
  return `http://${ip}:${controlPort}`
}

/** 获取控制服务器端口 */
export function getControlPort(): number {
  return controlPort
}

// ============ 扫描逻辑（共享主 App 的扫描结果） ============

// 扫描由主 App 执行（通过 setScanCallback 设置的回调），保证列表完全一致

/** 执行扫描：优先使用主 App 回调，否则返回缓存结果 */
async function doScan(folderPath: string, maxIntervalHours: number): Promise<VideoGroup[]> {
  if (scanFromMainApp) {
    return await scanFromMainApp(folderPath, maxIntervalHours)
  }
  // 如果主 App 未设置回调，返回上次缓存的结果
  return lastGroups
}

// ============ HTTP 请求处理 ============

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    const MAX_SIZE = 10 * 1024 * 1024 // 10MB 限制
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_SIZE) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', () => reject(new Error('读取请求体失败')))
  })
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost')
  const path = url.pathname
  const method = req.method || 'GET'

  // CORS 预检
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Token'
    })
    res.end()
    return
  }

  // 首页：登录页或控制面板（禁止缓存，确保每次加载最新内容）
  if (path === '/' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Access-Control-Allow-Origin': '*' })
    res.end(getMobileHtml())
    return
  }

  // 登录接口（不需要认证，带限频保护）
  if (path === '/api/login' && method === 'POST') {
    try {
      const clientIp = req.socket.remoteAddress || 'unknown'
      const now = Date.now()
      const attempt = loginAttempts.get(clientIp)
      // 检查是否被锁定（60秒内失败5次）
      if (attempt && now - attempt.lastTime < 60000 && attempt.count >= 5) {
        sendJson(res, 429, { error: '登录尝试过于频繁，请稍后再试' })
        return
      }
      // 超过60秒自动重置
      if (attempt && now - attempt.lastTime >= 60000) {
        loginAttempts.delete(clientIp)
      }
      const body = JSON.parse(await readBody(req))
      if (loadConfigFn) configRef = loadConfigFn()
      const password = configRef.controlPassword || ''
      if (!password || body.password === password) {
        loginAttempts.delete(clientIp) // 登录成功，清除记录
        sendJson(res, 200, { success: true, token: password || 'none' })
      } else {
        // 登录失败，增加计数
        const prev = loginAttempts.get(clientIp) || { count: 0, lastTime: now }
        loginAttempts.set(clientIp, { count: prev.count + 1, lastTime: now })
        sendJson(res, 401, { error: '密码错误' })
      }
    } catch {
      sendJson(res, 400, { error: '请求格式错误' })
    }
    return
  }

  // API 认证检查（登录接口除外，使用缓存的 configRef 避免每次请求都读文件）
  if (path.startsWith('/api/')) {
    const password = configRef.controlPassword || ''
    if (password) {
      const token = req.headers['x-token'] as string
      if (token !== password) {
        sendJson(res, 401, { error: '未授权，请先登录' })
        return
      }
    }
  }

  // GET /api/status - 增强版状态接口
  if (path === '/api/status' && method === 'GET') {
    const uploadDone = getUploadDoneFn ? getUploadDoneFn() : false
    // 如果投稿完成且当前状态是 uploading，自动切换到完成状态
    if (uploadDone && appStatus === 'uploading') {
      appStatus = 'idle'
    }
    // 上传状态超时保护：如果 10 分钟内未完成（浏览器关闭等），自动重置
    if (appStatus === 'uploading' && !uploadDone && Date.now() - appStatusSince > 10 * 60 * 1000) {
      console.log('[ControlServer] 上传状态超时，已自动重置')
      appStatus = 'idle'
    }
    // 使用缓存的合并文件数量（避免每秒扫描目录）
    const now = Date.now()
    if (now - cachedMergedFilesTime > MERGED_FILES_CACHE_TTL) {
      cachedMergedFiles = mergedFiles.scanFolder(configRef.outputFolder || '')
      cachedMergedFilesTime = now
    }
    sendJson(res, 200, {
      status: appStatus,
      mergePercent,
      currentMergeTask,
      mergeTotalTasks,
      mergeCurrentIndex,
      uploadDone,
      mergedFilesCount: cachedMergedFiles.length,
      uploadFileNames
    })
    return
  }

  // GET /api/merged-files - 获取待投稿文件列表（扫描输出文件夹）
  if (path === '/api/merged-files' && method === 'GET') {
    // 显式请求时刷新缓存
    cachedMergedFiles = mergedFiles.scanFolder(configRef.outputFolder || '')
    cachedMergedFilesTime = Date.now()
    sendJson(res, 200, {
      files: cachedMergedFiles
    })
    return
  }

  // POST /api/merged-files/remove 和 /api/merged-files/clear 已移除
  // 投稿列表现在是输出文件夹的实时扫描，不再维护内存列表

  // GET /api/groups
  if (path === '/api/groups' && method === 'GET') {
    // 应用排除列表过滤（确保手机端始终与桌面端同步）
    if (loadConfigFn) configRef = loadConfigFn()
    sendJson(res, 200, { groups: getFilteredGroups() })
    return
  }

  // POST /api/scan
  if (path === '/api/scan' && method === 'POST') {
    if (isScanning) {
      sendJson(res, 409, { error: '正在扫描中，请稍候' })
      return
    }
    if (appStatus !== 'idle') {
      sendJson(res, 400, { error: '当前忙碌，请等待完成' })
      return
    }
    try {
      isScanning = true
      appStatus = 'scanning'; appStatusSince = Date.now()
      if (loadConfigFn) configRef = loadConfigFn()
      const inputFolder = configRef.inputFolder
      const maxInterval = configRef.maxIntervalHours || 2.5
      if (!inputFolder) {
        appStatus = 'idle'
        sendJson(res, 400, { error: '未设置输入目录' })
        return
      }
      lastGroups = await doScan(inputFolder, maxInterval)
      // 应用排除列表
      if (loadConfigFn) configRef = loadConfigFn()
      const scanHiddenKeys = new Set(configRef.hiddenFolderKeys || [])
      lastGroups = lastGroups.filter((g) => !scanHiddenKeys.has(g.key))
      appStatus = 'idle'; appStatusSince = Date.now()
      isScanning = false
      sendJson(res, 200, { groups: lastGroups })
    } catch (e: unknown) {
      appStatus = 'idle'; appStatusSince = Date.now()
      isScanning = false
      sendJson(res, 500, { error: String(e) })
    }
    return
  }

  // POST /api/merge
  if (path === '/api/merge' && method === 'POST') {
    if (appStatus !== 'idle' || (isMainAppMergingFn && isMainAppMergingFn()) || (getIsMergingFn && getIsMergingFn())) {
      sendJson(res, 409, { error: '桌面端正在合并中' })
      return
    }
    try {
      const body = JSON.parse(await readBody(req))
      const groupKey: string = body.groupKey
      const group = lastGroups.find((g) => g.key === groupKey)
      if (!group) {
        sendJson(res, 404, { error: '未找到该分组' })
        return
      }
      if (loadConfigFn) configRef = loadConfigFn()
      const outputFolder = configRef.outputFolder
      if (!outputFolder) {
        sendJson(res, 400, { error: '未设置输出目录' })
        return
      }

      appStatus = 'merging'; appStatusSince = Date.now()
      if (setIsMergingFn) setIsMergingFn(true)
      mergePercent = 0
      mergeTotalTasks = 1
      mergeCurrentIndex = 0
      currentMergeTask = group.folderName
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
      const outputName = `${group.date}_${group.title}_${dateStr}_${timeStr}_合并版.mp4`
      const outputPath = join(outputFolder, outputName)

      const filePaths = group.files.map((f) => f.path)
      await mergeVideos(filePaths, outputPath, (percent) => {
        mergePercent = percent
      })
      mergePercent = 100

      appStatus = 'idle'; appStatusSince = Date.now()
      if (setIsMergingFn) setIsMergingFn(false)
      currentMergeTask = ''
      mergeTotalTasks = 0
      mergeCurrentIndex = 0

      // 合并完成，刷新缓存
      invalidateCache()

      // 重新扫描（使用主 App 的扫描逻辑，保证列表一致）
      const inputFolder = configRef.inputFolder
      const maxInterval = configRef.maxIntervalHours || 2.5
      if (inputFolder) {
        lastGroups = await doScan(inputFolder, maxInterval)
      }
      // 合并后重新应用排除列表
      if (loadConfigFn) configRef = loadConfigFn()
      const hiddenKeysAfterMerge = new Set(configRef.hiddenFolderKeys || [])
      lastGroups = lastGroups.filter((g) => !hiddenKeysAfterMerge.has(g.key))

      sendJson(res, 200, { success: true, outputPath, groups: lastGroups })
    } catch (e: unknown) {
      appStatus = 'idle'; appStatusSince = Date.now()
      if (setIsMergingFn) setIsMergingFn(false)
      currentMergeTask = ''
      mergePercent = 0
      mergeTotalTasks = 0
      mergeCurrentIndex = 0
      sendJson(res, 500, { error: String(e) })
    }
    return
  }

  // POST /api/upload
  if (path === '/api/upload' && method === 'POST') {
    if (appStatus !== 'idle') {
      sendJson(res, 400, { error: '当前忙碌，请等待完成' })
      return
    }
    try {
      const body = JSON.parse(await readBody(req))
      // 支持两种模式：filePaths（完整路径）或 fileNames（文件名，从共享模块映射）
      let filePaths: string[] = body.filePaths
      if ((!filePaths || filePaths.length === 0) && body.fileNames && body.fileNames.length > 0) {
        // 从共享模块映射文件名到完整路径
        filePaths = mergedFiles.findByNames(configRef.outputFolder || '', body.fileNames as string[])
      }
      if (!filePaths || filePaths.length === 0) {
        sendJson(res, 400, { error: '未指定文件' })
        return
      }

      // 重置投稿完成状态（新一轮投稿开始）
      if (resetUploadDoneFn) resetUploadDoneFn()

      appStatus = 'uploading'; appStatusSince = Date.now()
      // 记录投稿文件名（展示用手机端）
      uploadFileNames = filePaths.map((f) => basename(f))

      // 注册文件到本地服务器
      if (registerFileForServeFn) {
        const fileUrls: string[] = []
        for (const fp of filePaths) {
          const url = await registerFileForServeFn(fp)
          fileUrls.push(url)
        }

        // 打开B站投稿页
        let bilibiliUrl = 'https://member.bilibili.com/platform/upload/video/frame'
        bilibiliUrl += '?autoFiles=' + fileUrls.map((u) => encodeURIComponent(u)).join(',')
        if (openExternalFn) {
          openExternalFn(bilibiliUrl)
        }
      }

      // 投稿状态保持为 uploading，等插件完成后再重置
      // 不立即设回 idle，让手机端能看到投稿进行中
      sendJson(res, 200, { success: true })
    } catch (e: unknown) {
      appStatus = 'idle'; appStatusSince = Date.now()
      uploadFileNames = []
      sendJson(res, 500, { error: String(e) })
    }
    return
  }

  // POST /api/upload/reset - 手动重置投稿状态
  if (path === '/api/upload/reset' && method === 'POST') {
    if (resetUploadDoneFn) resetUploadDoneFn()
    appStatus = 'idle'; appStatusSince = Date.now()
    uploadFileNames = []
    sendJson(res, 200, { success: true })
    return
  }

  // GET /api/config
  if (path === '/api/config' && method === 'GET') {
    if (loadConfigFn) configRef = loadConfigFn()
    sendJson(res, 200, configRef)
    return
  }

  // POST /api/config
  if (path === '/api/config' && method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req))
      if (saveConfigFn) {
        if (loadConfigFn) configRef = loadConfigFn()
        const newConfig = { ...configRef, ...body }
        saveConfigFn(newConfig)
        configRef = newConfig
      }
      sendJson(res, 200, { success: true })
    } catch (e: unknown) {
      sendJson(res, 500, { error: String(e) })
    }
    return
  }

  // POST /api/groups/exclude - 排除指定分组
  if (path === '/api/groups/exclude' && method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req))
      const keys: string[] = body.keys || []
      if (keys.length === 0) {
        sendJson(res, 400, { error: '未指定排除分组' })
        return
      }
      if (loadConfigFn) configRef = loadConfigFn()
      const currentHidden = new Set(configRef.hiddenFolderKeys || [])
      keys.forEach((k) => currentHidden.add(k))
      const newHidden = Array.from(currentHidden)
      // 更新配置
      if (saveConfigFn) saveConfigFn({ ...configRef, hiddenFolderKeys: newHidden })
      // 从当前列表中移除
      lastGroups = lastGroups.filter((g) => !currentHidden.has(g.key))
      // 通知主 App 同步
      if (updateHiddenKeysFn) updateHiddenKeysFn(newHidden)
      sendJson(res, 200, { success: true, groups: lastGroups })
    } catch (e: unknown) {
      sendJson(res, 500, { error: String(e) })
    }
    return
  }

  // POST /api/groups/restore - 恢复指定分组
  if (path === '/api/groups/restore' && method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req))
      const keys: string[] = body.keys || []
      if (loadConfigFn) configRef = loadConfigFn()
      const currentHidden = new Set(configRef.hiddenFolderKeys || [])
      keys.forEach((k) => currentHidden.delete(k))
      const newHidden = Array.from(currentHidden)
      if (saveConfigFn) saveConfigFn({ ...configRef, hiddenFolderKeys: newHidden })
      // 通知主 App 同步
      if (updateHiddenKeysFn) updateHiddenKeysFn(newHidden)
      // 重新扫描以获取恢复的分组
      const inputFolder = configRef.inputFolder
      const maxInterval = configRef.maxIntervalHours || 2.5
      if (inputFolder && scanFromMainApp) {
        lastGroups = await scanFromMainApp(inputFolder, maxInterval)
        // 应用新的排除列表
        const hiddenSet = new Set(newHidden)
        lastGroups = lastGroups.filter((g) => !hiddenSet.has(g.key))
      }
      sendJson(res, 200, { success: true, groups: lastGroups })
    } catch (e: unknown) {
      sendJson(res, 500, { error: String(e) })
    }
    return
  }

  // GET /api/groups/excluded - 获取已排除的分组
  if (path === '/api/groups/excluded' && method === 'GET') {
    try {
      if (loadConfigFn) configRef = loadConfigFn()
      const hiddenKeys = configRef.hiddenFolderKeys || []
      // 需要全量扫描才能知道被排除的分组名称
      const inputFolder = configRef.inputFolder
      const maxInterval = configRef.maxIntervalHours || 2.5
      if (inputFolder && scanFromMainApp) {
        const allGroups = await scanFromMainApp(inputFolder, maxInterval)
        const excluded = allGroups.filter((g) => hiddenKeys.includes(g.key))
        sendJson(res, 200, { excluded })
      } else {
        sendJson(res, 200, { excluded: [] })
      }
    } catch (e: unknown) {
      sendJson(res, 500, { error: String(e) })
    }
    return
  }

  // POST /api/merge/batch - 批量合并
  if (path === '/api/merge/batch' && method === 'POST') {
    if (appStatus !== 'idle' || (isMainAppMergingFn && isMainAppMergingFn()) || (getIsMergingFn && getIsMergingFn())) {
      sendJson(res, 409, { error: '桌面端正在合并中' })
      return
    }
    try {
      const body = JSON.parse(await readBody(req))
      const groupKeys: string[] = body.groupKeys || []
      if (groupKeys.length === 0) {
        sendJson(res, 400, { error: '未指定合并分组' })
        return
      }
      if (loadConfigFn) configRef = loadConfigFn()
      const outputFolder = configRef.outputFolder
      if (!outputFolder) {
        sendJson(res, 400, { error: '未设置输出目录' })
        return
      }

      appStatus = 'merging'; appStatusSince = Date.now()
      if (setIsMergingFn) setIsMergingFn(true)
      const results: string[] = []
      const totalGroups = groupKeys.length
      mergeTotalTasks = totalGroups
      mergeCurrentIndex = 0

      for (let i = 0; i < groupKeys.length; i++) {
        const groupKey = groupKeys[i]
        const group = lastGroups.find((g) => g.key === groupKey)
        if (!group) continue

        mergeCurrentIndex = i
        mergePercent = Math.round((i / totalGroups) * 100)
        currentMergeTask = `(${i + 1}/${totalGroups}) ${group.folderName}`

        const now = new Date()
        const pad = (n: number) => String(n).padStart(2, '0')
        const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
        const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
        const outputName = `${group.date}_${group.title}_${dateStr}_${timeStr}_合并版.mp4`
        const outputPath = join(outputFolder, outputName)

        const filePaths = group.files.map((f) => f.path)
        await mergeVideos(filePaths, outputPath, (percent) => {
          mergePercent = Math.round(((i + percent / 100) / totalGroups) * 100)
        })
        results.push(outputPath)
      }

      mergePercent = 100
      mergeCurrentIndex = totalGroups

      appStatus = 'idle'; appStatusSince = Date.now()
      if (setIsMergingFn) setIsMergingFn(false)
      currentMergeTask = ''
      mergeTotalTasks = 0
      mergeCurrentIndex = 0

      // 合并完成，刷新缓存
      invalidateCache()

      // 重新扫描
      const inputFolder = configRef.inputFolder
      const maxInterval = configRef.maxIntervalHours || 2.5
      if (inputFolder) {
        lastGroups = await doScan(inputFolder, maxInterval)
      }

      sendJson(res, 200, { success: true, outputPaths: results, groups: lastGroups })
    } catch (e: unknown) {
      appStatus = 'idle'; appStatusSince = Date.now()
      if (setIsMergingFn) setIsMergingFn(false)
      currentMergeTask = ''
      mergePercent = 0
      mergeTotalTasks = 0
      mergeCurrentIndex = 0
      sendJson(res, 500, { error: String(e) })
    }
    return
  }

  // POST /api/upload/video - 手机端上传视频文件（raw body 方式）
  if (path === '/api/upload/video' && method === 'POST') {
    const fileName = url.searchParams.get('name')
    if (!fileName) {
      sendJson(res, 400, { error: '缺少文件名' })
      return
    }

    // 安全检查：只允许视频文件扩展名
    const ext = fileName.toLowerCase().split('.').pop() || ''
    const allowedExts = ['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'ts', 'm4v', 'blv', 'm4s']
    if (!allowedExts.includes(ext)) {
      sendJson(res, 400, { error: '不支持的文件格式: ' + ext })
      return
    }

    if (loadConfigFn) configRef = loadConfigFn()
    const outputDir = configRef.outputFolder
    if (!outputDir) {
      sendJson(res, 400, { error: '未设置输出目录' })
      return
    }

    const safeName = basename(fileName)
    const outputPath = join(outputDir, safeName)

    // 收集请求体并写入文件
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks)
        writeFileSync(outputPath, buffer)
        console.log('[ControlServer] 手机视频已上传:', outputPath, `(${(buffer.length / 1024 / 1024).toFixed(1)}MB)`)
        // 刷新缓存
        invalidateCache()
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        })
        res.end(JSON.stringify({ success: true, path: outputPath, size: buffer.length }))
      } catch (e) {
        console.error('[ControlServer] 写入上传文件失败:', e)
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: '写入文件失败' }))
      }
    })
    req.on('error', (e) => {
      console.error('[ControlServer] 上传接收错误:', e)
      sendJson(res, 500, { error: '接收文件失败' })
    })
    return
  }

  // 404
  sendJson(res, 404, { error: 'Not found' })
}

// ============ 移动端 HTML 页面（含登录、分组管理、批量操作、设置） ============

function getMobileHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>视频合并控制</title>
<style>
:root{--primary:#1677ff;--primary-light:#e6f4ff;--success:#52c41a;--success-light:#f6ffed;--warning:#faad14;--warning-light:#fffbe6;--danger:#ff4d4f;--danger-light:#fff1f0;--orange:#fa8c16;--text:#262626;--text-secondary:#8c8c8c;--bg:#f5f5f5;--bg-card:#fff;--border:#f0f0f0;--shadow:0 1px 4px rgba(0,0,0,.08);--shadow-lg:0 4px 16px rgba(0,0,0,.12);--radius:12px;--radius-sm:8px}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);padding:12px;padding-bottom:90px;-webkit-font-smoothing:antialiased}
/* 卡片 */
.card{background:var(--bg-card);border-radius:var(--radius);padding:16px;margin-bottom:12px;box-shadow:var(--shadow);transition:box-shadow .25s ease}
.card:active{box-shadow:var(--shadow-lg)}
.card h3{font-size:15px;font-weight:600;margin-bottom:12px;color:var(--primary)}
/* 状态栏 */
.status-bar{padding:20px 16px;text-align:center}
.status-text{font-size:20px;font-weight:700;margin-bottom:6px;letter-spacing:.3px}
.status-detail{font-size:13px;color:var(--text-secondary);margin-bottom:10px;word-break:break-all;line-height:1.5}
.progress-wrap{width:100%;height:14px;background:#e8e8e8;border-radius:7px;overflow:hidden;margin-top:10px}
.progress-fill{height:100%;background:linear-gradient(90deg,var(--primary),#69b1ff,#52c41a);border-radius:7px;background-size:200% 100%;animation:progressShine 2s ease infinite;transition:width .4s cubic-bezier(.4,0,.2,1)}
@keyframes progressShine{0%{background-position:200% 0}100%{background-position:-200% 0}}
.progress-text{font-size:22px;font-weight:700;color:var(--primary);margin-top:6px;letter-spacing:.5px}
/* 投稿状态 */
.upload-status{border-radius:var(--radius-sm);padding:14px;margin-top:10px}
.upload-status.uploading{background:var(--warning-light);border:1px solid #ffd591}
.upload-status.done{background:var(--success-light);border:1px solid #b7eb8f}
.upload-status .title{font-size:15px;font-weight:600;margin-bottom:6px}
.upload-status .files{font-size:12px;color:#666;margin-top:8px}
.upload-status .files div{padding:3px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 分组列表 */
.group-item{display:flex;align-items:center;padding:12px 0;border-bottom:1px solid var(--border);transition:background .15s ease;border-radius:4px;margin:0 -4px;padding:12px 4px}
.group-item:active{background:#f5f5f5}
.group-item:last-child{border-bottom:none}
.group-check{margin-right:12px;width:22px;height:22px;flex-shrink:0;accent-color:var(--primary);cursor:pointer}
.group-info{flex:1;min-width:0}
.group-name{font-size:15px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4}
.group-meta{font-size:12px;color:var(--text-secondary);margin-top:4px}
/* 按钮 */
.btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 18px;border-radius:var(--radius-sm);border:none;font-size:14px;font-weight:500;cursor:pointer;transition:all .2s ease;min-height:44px;-webkit-user-select:none;user-select:none}
.btn:active{transform:scale(.96);opacity:.85}
.btn-primary{background:var(--primary);color:#fff}
.btn-primary:active{background:#0958d9}
.btn-success{background:var(--success);color:#fff}
.btn-success:active{background:#389e0d}
.btn-warning{background:var(--warning);color:#fff}
.btn-warning:active{background:#d48806}
.btn-danger{background:var(--danger);color:#fff}
.btn-danger:active{background:#cf1322}
.btn-ghost{background:#f0f0f0;color:var(--text)}
.btn-ghost:active{background:#d9d9d9}
.btn-block{display:flex;width:100%;text-align:center;padding:14px;font-size:15px}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none!important}
/* 底部栏 */
.bottom-bar{position:fixed;bottom:0;left:0;right:0;background:var(--bg-card);padding:10px 12px;padding-bottom:calc(10px + env(safe-area-inset-bottom,0));display:flex;gap:8px;box-shadow:0 -2px 8px rgba(0,0,0,.08);z-index:10;flex-wrap:wrap;border-top:1px solid var(--border)}
.bottom-bar .btn{flex:1;min-width:0;font-size:13px;padding:10px 8px;min-height:44px}
/* 空状态 */
.empty{text-align:center;padding:48px 20px;color:var(--text-secondary);font-size:14px;line-height:1.6}
/* Toast */
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%) translateY(-20px);background:rgba(0,0,0,.8);color:#fff;padding:12px 24px;border-radius:var(--radius-sm);font-size:14px;z-index:100;opacity:0;transition:all .3s ease;pointer-events:none;white-space:nowrap;backdrop-filter:blur(8px)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
/* Tab栏 */
.tab-bar{display:flex;gap:0;margin-bottom:12px;background:var(--bg-card);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow);border:1px solid var(--border)}
.tab{flex:1;text-align:center;padding:12px 6px;font-size:13px;font-weight:500;cursor:pointer;color:var(--text-secondary);transition:all .25s ease;position:relative}
.tab:active{background:#f5f5f5}
.tab.active{color:var(--primary);background:var(--primary-light);font-weight:600}
/* 登录页 */
.login-box{max-width:340px;margin:80px auto;text-align:center}
.login-box .card{padding:32px 24px}
.login-box input{width:100%;padding:14px 16px;border:1.5px solid #d9d9d9;border-radius:var(--radius-sm);font-size:16px;margin:16px 0;transition:border-color .25s ease;outline:none}
.login-box input:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(22,119,255,.15)}
.login-box .btn{width:100%;padding:14px;font-size:16px;min-height:48px}
.hidden{display:none!important}
.section-title{font-size:13px;color:var(--text-secondary);margin:16px 0 10px;padding-left:4px;font-weight:500}
.setting-row{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #f5f5f5;min-height:48px}
.setting-row label{font-size:14px;flex:1;margin-right:12px;color:var(--text)}
.setting-row input,.setting-row select{padding:8px 12px;border:1.5px solid #d9d9d9;border-radius:6px;font-size:14px;width:120px;outline:none;transition:border-color .2s}
.setting-row input:focus,.setting-row select:focus{border-color:var(--primary)}
.excluded-item{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--border)}
.excluded-item:last-child{border-bottom:none}
/* 状态颜色 */
.status-idle .status-text{color:var(--success)}
.status-scanning .status-text{color:var(--primary)}
.status-merging .status-text{color:var(--orange)}
.status-uploading .status-text{color:var(--warning)}
.status-done .status-text{color:var(--success)}
/* 动画 */
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.pulse{animation:pulse 1.5s ease-in-out infinite}
/* 断线提示条 */
.disconnect-banner{background:var(--danger-light);border:1px solid #ffa39e;border-radius:var(--radius-sm);padding:12px 16px;margin-bottom:12px;text-align:center;color:#cf1322;font-size:14px;font-weight:600;display:none;line-height:1.5}
/* 排障提示 */
.net-tips{background:var(--warning-light);border:1px solid #ffe58f;border-radius:var(--radius-sm);padding:12px 16px;margin-bottom:12px;font-size:13px;color:#614700;line-height:1.6}
.net-tips summary{cursor:pointer;font-weight:600;outline:none;padding:2px 0}
.net-tips ul{margin:8px 0 0 18px;padding:0}
.net-tips li{margin:6px 0}
/* 手机视频上传区 */
.upload-zone{padding:24px 16px;text-align:center;border:2px dashed #d9d9d9;border-radius:var(--radius);margin:12px 0;transition:border-color .25s ease;background:#fafafa}
.upload-zone:active{border-color:var(--primary);background:var(--primary-light)}
.upload-zone p{color:var(--text-secondary);margin-bottom:16px;font-size:14px;line-height:1.5}
</style>
</head>
<body>
<div class="toast" id="toast"></div>
<div class="disconnect-banner" id="disconnectBanner">连接已断开，请检查网络</div>

<!-- 连接排障提示 -->
<details class="net-tips">
  <summary>💡 无法连接？请确保手机和电脑在同一网络</summary>
  <ul>
    <li>电脑需连接有线局域网</li>
    <li>手机需连接同一 WiFi（不能用移动数据）</li>
    <li>如仍无法访问，请检查路由器是否开启了 AP 隔离</li>
  </ul>
</details>

<!-- 登录页 -->
<div id="loginPage" class="login-box">
  <div class="card">
    <h3 style="text-align:center;font-size:18px;margin-bottom:16px">视频合并控制</h3>
    <input type="password" id="passwordInput" placeholder="请输入控制密码" onkeypress="if(event.key==='Enter')doLogin()">
    <button class="btn btn-primary btn-block" onclick="doLogin()">登录</button>
  </div>
</div>

<!-- 主页面 -->
<div id="mainPage" class="hidden">
  <div class="tab-bar">
    <div class="tab active" onclick="switchTab('groups')">分组</div>
    <div class="tab" onclick="switchTab('excluded')">已排除</div>
    <div class="tab" onclick="switchTab('upload')">投稿</div>
    <div class="tab" onclick="switchTab('settings')">设置</div>
    <div class="tab" onclick="switchTab('phone')">📱 手机视频</div>
  </div>

  <!-- 状态卡片 -->
  <div class="card status-bar" id="statusCard">
    <div class="status-text" id="statusText">空闲</div>
    <div class="status-detail" id="statusDetail">就绪</div>
    <div class="progress-wrap" id="progressBar" style="display:none">
      <div class="progress-fill" id="progressFill" style="width:0%"></div>
    </div>
    <div class="progress-text" id="progressText" style="display:none">0%</div>
    <!-- 投稿状态区域 -->
    <div id="uploadStatusArea"></div>
  </div>

  <!-- 已合并文件提示（已移除） -->

  <!-- 分组列表 -->
  <div id="tabGroups">
    <div class="card">
      <h3>视频分组 <span id="selectAllWrap" style="float:right;font-size:12px;color:#1890ff;cursor:pointer" onclick="toggleSelectAll()">全选</span></h3>
      <div id="groupList"><div class="empty">点击下方「扫描」按钮加载</div></div>
    </div>
  </div>

  <!-- 已排除列表 -->
  <div id="tabExcluded" class="hidden">
    <div class="card">
      <h3>已排除分组</h3>
      <div id="excludedList"><div class="empty">暂无排除的分组</div></div>
    </div>
  </div>

  <!-- 投稿页 -->
  <div id="tabUpload" class="hidden">
    <div class="card">
      <h3>待投稿文件 <span id="uploadSelectAllWrap" style="float:right;font-size:12px;color:#1890ff;cursor:pointer" onclick="toggleUploadSelectAll()">全选</span></h3>
      <div id="uploadFileList"><div class="empty">暂无已合并文件，请先合并</div></div>
      <div style="margin-top:12px">
        <button class="btn btn-success btn-block" onclick="doUploadSelected()" id="uploadSelectedBtn" disabled>投稿选中文件</button>
      </div>
    </div>
  </div>

  <!-- 设置页 -->
  <div id="tabSettings" class="hidden">
    <div class="card">
      <h3>设置</h3>
      <div id="settingsContent"><div class="empty">加载中...</div></div>
    </div>
  </div>

  <!-- 手机视频 -->
  <div id="tabPhone" class="hidden">
    <div class="upload-zone">
      <p>选择手机上的视频文件，上传到电脑</p>
      <input type="file" id="videoFileInput" accept="video/*" multiple style="position:absolute;opacity:0;width:0;height:0;overflow:hidden;pointer-events:none" onchange="handleVideoSelect(this)">
      <label for="videoFileInput" style="background:var(--primary);color:white;border:none;padding:12px 28px;border-radius:8px;font-size:16px;cursor:pointer;font-weight:500;min-height:48px;display:inline-block;">📁 选择视频文件</label>
    </div>
    <div id="selectedVideoList" style="padding:0 12px;"></div>
    <div id="uploadAction" style="display:none; padding:12px; text-align:center;">
      <button onclick="uploadSelectedVideos()" style="background:#52c41a; color:white; border:none; padding:10px 24px; border-radius:6px; font-size:16px; cursor:pointer; width:100%;">📤 上传到电脑 (共<span id="uploadCount">0</span>个文件)</button>
      <div id="uploadProgress" style="display:none; margin-top:8px;">
        <div style="background:#f0f0f0; border-radius:4px; overflow:hidden;">
          <div id="uploadProgressBar" style="background:#52c41a; height:20px; width:0%; transition:width 0.3s;"></div>
        </div>
        <p id="uploadStatus" style="color:#666; font-size:12px; margin-top:4px;"></p>
      </div>
    </div>
  </div>
</div>

<div class="bottom-bar" id="bottomBar">
  <button class="btn btn-primary" id="scanBtn" onclick="doScan()">📡 扫描</button>
  <button class="btn btn-success" id="batchMergeBtn" onclick="doBatchMerge()" disabled>⚡ 批量合并</button>
  <button class="btn btn-warning" id="mergeUploadBtn" onclick="doMergeAndUpload()" disabled>📤 合并投稿</button>
</div>

<script>
let groups = [], excludedGroups = [], selectedKeys = new Set();
let serverMergedFiles = [], uploadFileNames = [];
let uploadSelectedKeys = new Set();
let pollTimer = null, authToken = '';
let prevStatus = '';
let pollFailCount = 0;

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2500);
}

// HTML 转义（防止 XSS 攻击）
function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json', 'X-Token': authToken } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(path, opts);
    const data = await res.json();
    if (res.status === 401 || data.error === '未授权，请先登录') {
      authToken = ''; saveToken(''); showLogin();
      return null;
    }
    return data;
  } catch (e) { return null; }
}

// token 持久化：URL hash + localStorage + cookie 三重保存
function saveToken(token) {
  if (token) {
    location.hash = 'token=' + encodeURIComponent(token);
    try { localStorage.setItem('vmToken', token); } catch(e) {}
    document.cookie = 'vmToken=' + encodeURIComponent(token) + ';max-age=2592000;path=/;SameSite=Strict';
  } else {
    history.replaceState(null, '', location.pathname);
    try { localStorage.removeItem('vmToken'); } catch(e) {}
    document.cookie = 'vmToken=;max-age=0;path=/';
  }
}
function loadToken() {
  const m = location.hash.match(/token=([^&]+)/);
  if (m) return decodeURIComponent(m[1]);
  try { const v = localStorage.getItem('vmToken'); if (v) return v; } catch(e) {}
  const cm = document.cookie.match(/vmToken=([^;]+)/);
  if (cm) return decodeURIComponent(cm[1]);
  return '';
}

// === 登录 ===
function showLogin() {
  document.getElementById('loginPage').classList.remove('hidden');
  document.getElementById('mainPage').classList.add('hidden');
  document.getElementById('bottomBar').classList.add('hidden');
}
function showMain() {
  document.getElementById('loginPage').classList.add('hidden');
  document.getElementById('mainPage').classList.remove('hidden');
  document.getElementById('bottomBar').classList.remove('hidden');
}
async function doLogin() {
  const pwd = document.getElementById('passwordInput').value;
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd }) });
    const data = await res.json();
    if (data.success) { authToken = data.token; saveToken(data.token); showMain(); updateStatus(); setTimeout(doScan, 300); }
    else { toast(data.error || '登录失败'); }
  } catch (e) { toast('连接失败'); }
}
// 自动登录
(function() {
  const saved = loadToken();
  if (saved) {
    authToken = saved;
    if (!location.hash.match(/token=/)) saveToken(saved);
    showMain();
    updateStatus();
    startPolling();
    setTimeout(doScan, 300);
  } else {
    showLogin();
  }
})();

// === Tab 切换 ===
function switchTab(tab) {
  var tabs = ['groups','excluded','upload','settings','phone'];
  document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', tabs[i] === tab));
  document.getElementById('tabGroups').classList.toggle('hidden', tab !== 'groups');
  document.getElementById('tabExcluded').classList.toggle('hidden', tab !== 'excluded');
  document.getElementById('tabUpload').classList.toggle('hidden', tab !== 'upload');
  document.getElementById('tabSettings').classList.toggle('hidden', tab !== 'settings');
  document.getElementById('tabPhone').classList.toggle('hidden', tab !== 'phone');
  document.getElementById('bottomBar').style.display = tab === 'groups' ? 'flex' : 'none';
  if (tab === 'excluded') loadExcluded();
  if (tab === 'upload') loadMergedFiles();
  if (tab === 'settings') loadSettings();
}

// === 状态更新（核心：增强版进度显示） ===
async function updateStatus() {
  try {
    const data = await api('GET', '/api/status');
    if (!data) return;
    const card = document.getElementById('statusCard');
    const el = document.getElementById('statusText');
    const detail = document.getElementById('statusDetail');
    const bar = document.getElementById('progressBar');
    const fill = document.getElementById('progressFill');
    const pctText = document.getElementById('progressText');
    const uploadArea = document.getElementById('uploadStatusArea');

    // 同步投稿文件名列表
    if (data.uploadFileNames) uploadFileNames = data.uploadFileNames;
    // 已移除 mergedBanner 更新

    // 状态显示
    card.className = 'card status-bar';
    if (data.status === 'idle') {
      if (prevStatus === 'merging' && data.mergedFilesCount > 0) {
        // 合并刚完成
        el.textContent = '合并完成！';
        detail.textContent = '已生成 ' + data.mergedFilesCount + ' 个文件，可以投稿';
        card.classList.add('status-done');
      } else if (prevStatus === 'uploading' && data.uploadDone) {
        el.textContent = '投稿完成！';
        detail.textContent = '视频已成功投稿到B站';
        card.classList.add('status-done');
        uploadArea.innerHTML = '<div class="upload-status done"><div class="title">投稿已完成</div><div class="files">' +
          uploadFileNames.map(f => '<div>' + escHtml(f) + '</div>').join('') + '</div></div>';
      } else {
        el.textContent = '空闲';
        detail.textContent = data.mergedFilesCount > 0 ? '已合并 ' + data.mergedFilesCount + ' 个文件待投稿' : '就绪';
        card.classList.add('status-idle');
      }
      bar.style.display = 'none';
      pctText.style.display = 'none';
      document.getElementById('scanBtn').disabled = false;
      if (data.status === 'idle' && prevStatus !== 'idle') {
        // 状态从忙碌变为空闲时给个提示
        if (prevStatus === 'merging') toast('合并完成！');
        if (prevStatus === 'uploading' && data.uploadDone) toast('投稿完成！');
      }
    }
    else if (data.status === 'scanning') {
      el.textContent = '扫描中...';
      detail.textContent = '正在扫描视频文件';
      card.classList.add('status-scanning');
      bar.style.display = 'block';
      fill.style.width = '50%';
      fill.classList.add('pulse');
      pctText.style.display = 'none';
    }
    else if (data.status === 'merging') {
      el.textContent = '合并中...';
      card.classList.add('status-merging');
      // 显示详细进度信息
      var taskInfo = data.currentMergeTask || '';
      if (data.mergeTotalTasks > 1) {
        detail.textContent = taskInfo;
      } else {
        detail.textContent = taskInfo;
      }
      bar.style.display = 'block';
      fill.style.width = data.mergePercent + '%';
      fill.classList.remove('pulse');
      pctText.style.display = 'block';
      pctText.textContent = data.mergePercent + '%';
      document.getElementById('scanBtn').disabled = true;
    }
    else if (data.status === 'uploading') {
      el.textContent = '投稿中...';
      card.classList.add('status-uploading');
      bar.style.display = 'none';
      pctText.style.display = 'none';
      if (data.uploadDone) {
        detail.textContent = '投稿已完成！';
        uploadArea.innerHTML = '<div class="upload-status done"><div class="title">投稿已完成</div><div class="files">' +
          uploadFileNames.map(f => '<div>' + escHtml(f) + '</div>').join('') + '</div></div>';
      } else {
        detail.textContent = '已打开B站投稿页面，等待插件处理...';
        uploadArea.innerHTML = '<div class="upload-status uploading"><div class="title pulse">等待投稿完成...</div><div class="files">' +
          uploadFileNames.map(f => '<div>' + escHtml(f) + '</div>').join('') + '</div></div>';
      }
      document.getElementById('scanBtn').disabled = true;
    }
    prevStatus = data.status;
    lastStatus = data.status; // 更新全局状态用于智能轮询

    // 底部按钮状态由 renderGroups 和 updateBatchBtn 管理
    pollFailCount = 0;
    var dbanner = document.getElementById('disconnectBanner');
    if (dbanner) dbanner.style.display = 'none';
  } catch (e) {
    pollFailCount++;
    var banner = document.getElementById('disconnectBanner');
    if (pollFailCount > 3 && banner) banner.style.display = 'block';
  }
}


// === 扫描 ===
async function doScan() {
  document.getElementById('scanBtn').disabled = true;
  toast('正在扫描...');
  try {
    const data = await api('POST', '/api/scan');
    if (data.error) { toast(data.error); return; }
    groups = data.groups || []; selectedKeys.clear(); renderGroups(); updateBatchBtn();
    toast('扫描完成，共 ' + groups.length + ' 个分组');
  } catch (e) { toast('扫描失败'); }
  document.getElementById('scanBtn').disabled = false;
}

// === 分组渲染 ===
function renderGroups() {
  const el = document.getElementById('groupList');
  if (groups.length === 0) { el.innerHTML = '<div class="empty">没有发现可合并的视频</div>'; return; }
  el.innerHTML = groups.map((g, i) => {
    const sizeMB = (g.totalSize / 1024 / 1024).toFixed(0);
    const checked = selectedKeys.has(g.key) ? 'checked' : '';
    return '<div class="group-item">' +
      '<input type="checkbox" class="group-check" ' + checked + ' onchange="toggleSelect(\\'' + g.key + '\\', this.checked)">' +
      '<div class="group-info" onclick="doMerge(' + i + ')" style="cursor:pointer">' +
        '<div class="group-name">' + escHtml(g.folderName) + '</div>' +
        '<div class="group-meta">' + g.fileCount + ' 个文件 | ' + sizeMB + ' MB</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function toggleSelect(key, checked) {
  if (checked) selectedKeys.add(key); else selectedKeys.delete(key);
  updateBatchBtn();
}
function toggleSelectAll() {
  if (selectedKeys.size === groups.length) { selectedKeys.clear(); }
  else { groups.forEach(g => selectedKeys.add(g.key)); }
  renderGroups(); updateBatchBtn();
}
function updateBatchBtn() {
  const hasSelection = selectedKeys.size > 0
  document.getElementById('batchMergeBtn').disabled = !hasSelection
  document.getElementById('mergeUploadBtn').disabled = !hasSelection
}

// === 合并 ===
async function doMerge(index) {
  const g = groups[index]; if (!g) return;
  toast('开始合并: ' + g.folderName);
  try {
    const data = await api('POST', '/api/merge', { groupKey: g.key });
    if (data.error) { toast(data.error); return; }
    groups = data.groups || []; selectedKeys.clear(); renderGroups(); updateBatchBtn();
    toast('合并完成！');
  } catch (e) { toast('合并失败'); }
}

async function doBatchMerge() {
  if (selectedKeys.size === 0) { toast('请先选择分组'); return; }
  if (!confirm('确定批量合并 ' + selectedKeys.size + ' 个分组？')) return;
  toast('开始批量合并...');
  try {
    const data = await api('POST', '/api/merge/batch', { groupKeys: Array.from(selectedKeys) });
    if (data.error) { toast(data.error); return; }
    groups = data.groups || []; selectedKeys.clear(); renderGroups(); updateBatchBtn();
    toast('批量合并完成！');
  } catch (e) { toast('批量合并失败'); }
}

// 合并并跳转到投稿页
async function doMergeAndUpload() {
  if (selectedKeys.size === 0) { toast('请先选择分组'); return; }
  if (!confirm('确定合并 ' + selectedKeys.size + ' 个分组并投稿？')) return;

  // 先加载已有文件，记录合并前的文件名
  await loadMergedFiles();
  var oldNames = new Set(serverMergedFiles.map(function(f) { return f.name; }));

  toast('正在合并...');
  try {
    const data = await api('POST', '/api/merge/batch', { groupKeys: Array.from(selectedKeys) });
    if (data.error) { toast(data.error); return; }
    groups = data.groups || []; selectedKeys.clear(); renderGroups(); updateBatchBtn();

    // 合并完成后，重新加载已合并文件
    await loadMergedFiles();

    // 只筛选本次合并新增的文件
    var newFiles = serverMergedFiles.filter(function(f) { return !oldNames.has(f.name); });
    if (newFiles.length === 0) { toast('没有新增文件可投稿'); return; }

    // 自动投稿新增文件
    toast('正在投稿 ' + newFiles.length + ' 个文件...');
    var uploadRes = await api('POST', '/api/upload', { fileNames: newFiles.map(function(f) { return f.name; }) });
    if (uploadRes && uploadRes.error) { toast(uploadRes.error); return; }
    toast('已打开B站投稿页面');
    switchTab('upload');
    await loadMergedFiles();
  } catch (e) { toast('操作失败'); }
}

// === 排除/恢复 ===
async function doExclude() {
  if (selectedKeys.size === 0) { toast('请先选择分组'); return; }
  if (!confirm('确定排除 ' + selectedKeys.size + ' 个分组？')) return;
  try {
    const data = await api('POST', '/api/groups/exclude', { keys: Array.from(selectedKeys) });
    if (data.error) { toast(data.error); return; }
    groups = data.groups || []; selectedKeys.clear(); renderGroups(); updateBatchBtn();
    toast('已排除');
  } catch (e) { toast('排除失败'); }
}

async function loadExcluded() {
  try {
    const data = await api('GET', '/api/groups/excluded');
    excludedGroups = data.excluded || [];
    const el = document.getElementById('excludedList');
    if (excludedGroups.length === 0) { el.innerHTML = '<div class="empty">暂无排除的分组</div>'; return; }
    el.innerHTML = excludedGroups.map(g => {
      return '<div class="excluded-item">' +
        '<div class="group-info"><div class="group-name">' + escHtml(g.folderName) + '</div><div class="group-meta">' + g.fileCount + ' 个文件</div></div>' +
        '<button class="btn btn-success" onclick="doRestore(\\'' + g.key + '\\')" style="flex-shrink:0;margin-left:8px">恢复</button>' +
      '</div>';
    }).join('');
  } catch (e) {}
}

async function doRestore(key) {
  try {
    const data = await api('POST', '/api/groups/restore', { keys: [key] });
    if (data.error) { toast(data.error); return; }
    groups = data.groups || []; selectedKeys.clear(); renderGroups(); updateBatchBtn();
    loadExcluded(); toast('已恢复');
  } catch (e) { toast('恢复失败'); }
}

// === 投稿（底部栏按钮：跳转到投稿Tab） ===
function doUpload() {
  switchTab('upload');
}

// === 投稿Tab：加载合并文件列表（扫描输出文件夹） ===
async function loadMergedFiles() {
  try {
    const data = await api('GET', '/api/merged-files');
    if (!data) return;
    serverMergedFiles = data.files || [];
    uploadSelectedKeys.clear();
    renderUploadList();
  } catch (e) {}
}

function formatMtime(ms) {
  if (!ms) return '';
  var d = new Date(ms);
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  return (d.getMonth()+1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 从合并文件名提取简洁显示名：2026-07-09_95老阿姨_2026-07-10_135840_合并版.mp4 → 2026-07-09 95老阿姨
function formatUploadName(fileName) {
  var match = fileName.match(/^(\\d{4}-\\d{2}-\\d{2})_(.+?)_/);
  if (match) return match[1] + ' ' + match[2];
  return fileName.replace(/\\.mp4$/i, '');
}

function renderUploadList() {
  var el = document.getElementById('uploadFileList');
  if (serverMergedFiles.length === 0) {
    el.innerHTML = '<div class="empty">暂无已合并文件，请先合并</div>';
    document.getElementById('uploadSelectedBtn').disabled = true;
    return;
  }
  el.innerHTML = serverMergedFiles.map(function(f, i) {
    var checked = uploadSelectedKeys.has(i) ? 'checked' : '';
    return '<div class="group-item">' +
      '<input type="checkbox" class="group-check" ' + checked + ' onchange="toggleUploadSelect(' + i + ', this.checked)">' +
      '<div class="group-info"><div class="group-name">' + escHtml(formatUploadName(f.name)) + '</div><div class="group-meta">' + formatMtime(f.mtime) + '</div></div>' +
    '</div>';
  }).join('');
  document.getElementById('uploadSelectedBtn').disabled = uploadSelectedKeys.size === 0;
}

function toggleUploadSelect(index, checked) {
  if (checked) uploadSelectedKeys.add(index); else uploadSelectedKeys.delete(index);
  document.getElementById('uploadSelectedBtn').disabled = uploadSelectedKeys.size === 0;
}

function toggleUploadSelectAll() {
  if (uploadSelectedKeys.size === serverMergedFiles.length) {
    uploadSelectedKeys.clear();
  } else {
    for (var i = 0; i < serverMergedFiles.length; i++) uploadSelectedKeys.add(i);
  }
  renderUploadList();
}

async function doUploadSelected() {
  if (uploadSelectedKeys.size === 0) { toast('请先选择文件'); return; }
  var names = [];
  uploadSelectedKeys.forEach(function(i) { names.push(serverMergedFiles[i].name); });
  if (!confirm('确定投稿 ' + names.length + ' 个文件？')) return;
  toast('正在投稿...');
  try {
    var data = await api('POST', '/api/upload', { fileNames: names });
    if (data && data.error) { toast(data.error); return; }
    toast('已打开B站投稿页面');
    uploadSelectedKeys.clear();
    await loadMergedFiles();
  } catch (e) { toast('投稿失败'); }
}

// === 设置 ===
async function loadSettings() {
  try {
    const data = await api('GET', '/api/config');
    const el = document.getElementById('settingsContent');
    el.innerHTML =
      '<div class="setting-row"><label>扫描间隔(小时)</label><input type="number" id="cfgInterval" value="' + (data.maxIntervalHours || 2.5) + '" step="0.5" min="0.5"></div>' +
      '<div class="setting-row"><label>并发数</label><input type="number" id="cfgConcurrency" value="' + (data.concurrency || 3) + '" min="1" max="8"></div>' +
      '<div class="setting-row"><label>插件联动</label><select id="cfgPlugin"><option value="true" ' + (data.pluginLinkage ? 'selected' : '') + '>开</option><option value="false" ' + (!data.pluginLinkage ? 'selected' : '') + '>关</option></select></div>' +
      '<div class="setting-row"><label>自动打开文件夹</label><select id="cfgOpenFolder"><option value="true" ' + (data.autoOpenFolder ? 'selected' : '') + '>开</option><option value="false" ' + (!data.autoOpenFolder ? 'selected' : '') + '>关</option></select></div>' +
      '<div class="setting-row"><label>自动打开网站</label><select id="cfgOpenWeb"><option value="true" ' + (data.autoOpenWebsite ? 'selected' : '') + '>开</option><option value="false" ' + (!data.autoOpenWebsite ? 'selected' : '') + '>关</option></select></div>' +
      '<div class="setting-row"><label>投稿后关闭App</label><select id="cfgCloseApp"><option value="true" ' + (data.autoCloseApp ? 'selected' : '') + '>开</option><option value="false" ' + (!data.autoCloseApp ? 'selected' : '') + '>关</option></select></div>' +
      '<div class="setting-row"><label>后台运行</label><select id="cfgBackground"><option value="true" ' + (data.runInBackground ? 'selected' : '') + '>开</option><option value="false" ' + (!data.runInBackground ? 'selected' : '') + '>关</option></select></div>' +
      '<div style="margin-top:16px"><button class="btn btn-primary btn-block" onclick="saveSettings()">保存设置</button></div>';
  } catch (e) {}
}

async function saveSettings() {
  try {
    const cfg = {
      maxIntervalHours: parseFloat(document.getElementById('cfgInterval').value) || 2.5,
      concurrency: parseInt(document.getElementById('cfgConcurrency').value) || 3,
      pluginLinkage: document.getElementById('cfgPlugin').value === 'true',
      autoOpenFolder: document.getElementById('cfgOpenFolder').value === 'true',
      autoOpenWebsite: document.getElementById('cfgOpenWeb').value === 'true',
      autoCloseApp: document.getElementById('cfgCloseApp').value === 'true',
      runInBackground: document.getElementById('cfgBackground').value === 'true'
    };
    const data = await api('POST', '/api/config', cfg);
    if (data.success) toast('设置已保存'); else toast('保存失败');
  } catch (e) { toast('保存失败'); }
}

// === 轮询（智能节流：空闲时降频，忙碌时保持1秒/次） ===
var lastStatus = '';
function startPolling() {
  if (pollTimer) return;
  function poll() {
    updateStatus().then(function() {
      // 根据状态决定下次轮询间隔
      var interval = 1000; // 默认1秒
      if (lastStatus === 'idle') interval = 3000; // 空闲时3秒
      else if (lastStatus === 'uploading') interval = 2000; // 投稿中2秒
      pollTimer = setTimeout(poll, interval);
    });
  }
  poll();
}
function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}
// 页面可见时恢复轮询（防止后台标签页被浏览器节流后彻底停止）
document.addEventListener('visibilitychange', function() {
  if (!document.hidden && !pollTimer) startPolling();
  else if (document.hidden && pollTimer) stopPolling();
});

// === 手机视频上传 ===
var selectedVideos = [];

function handleVideoSelect(input) {
  selectedVideos = Array.from(input.files);
  renderSelectedVideos();
  document.getElementById('uploadAction').style.display = selectedVideos.length > 0 ? 'block' : 'none';
  document.getElementById('uploadCount').textContent = selectedVideos.length;
}

function renderSelectedVideos() {
  var list = document.getElementById('selectedVideoList');
  if (selectedVideos.length === 0) { list.innerHTML = ''; return; }
  var html = '<h4 style="padding:0 4px;">已选择 ' + selectedVideos.length + ' 个视频：</h4>';
  selectedVideos.forEach(function(f, i) {
    var size = (f.size / 1024 / 1024).toFixed(1);
    html += '<div style="padding:8px 0; border-bottom:1px solid #f0f0f0; display:flex; justify-content:space-between;">' +
      '<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:70%;">' + escHtml(f.name) + '</span>' +
      '<span style="color:#999; font-size:12px;">' + size + ' MB</span></div>';
  });
  list.innerHTML = html;
}

function uploadSelectedVideos() {
  if (selectedVideos.length === 0) return;
  var progressBar = document.getElementById('uploadProgressBar');
  var statusEl = document.getElementById('uploadStatus');
  document.getElementById('uploadProgress').style.display = 'block';

  var total = selectedVideos.length;
  var uploaded = 0;

  function uploadNext(index) {
    if (index >= total) {
      statusEl.textContent = '全部上传完成！';
      selectedVideos = [];
      document.getElementById('videoFileInput').value = '';
      renderSelectedVideos();
      document.getElementById('uploadAction').style.display = 'none';
      return;
    }
    var file = selectedVideos[index];
    statusEl.textContent = '上传中 (' + (index+1) + '/' + total + '): ' + file.name;

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload/video?name=' + encodeURIComponent(file.name) + '&size=' + file.size);
    xhr.setRequestHeader('X-Token', authToken);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = function(e) {
      if (e.lengthComputable) {
        var filePercent = (e.loaded / e.total) * 100;
        var overallPercent = ((uploaded / total) + (filePercent / 100 / total)) * 100;
        progressBar.style.width = overallPercent.toFixed(1) + '%';
      }
    };
    xhr.onload = function() {
      uploaded++;
      progressBar.style.width = ((uploaded / total) * 100).toFixed(1) + '%';
      if (xhr.status === 200) {
        uploadNext(index + 1);
      } else {
        statusEl.textContent = '上传失败: ' + file.name + ' - ' + (xhr.responseText || '未知错误');
      }
    };
    xhr.onerror = function() {
      statusEl.textContent = '网络错误，上传中断';
    };
    xhr.send(file);
  }

  uploadNext(0);
}

updateStatus(); startPolling();
</script>
</body>
</html>`
}

// ============ 服务器启动/停止 ============

/** 启动控制服务器 */
export async function startControlServer(port: number = 9820): Promise<string> {
  if (controlServer) return getControlUrl()
  controlPort = port

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleRequest(req, res).catch((e) => {
        console.error('[ControlServer] 请求处理错误:', e)
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'Internal error' })
        }
      })
    })

    server.listen(controlPort, '0.0.0.0', () => {
      controlServer = server
      const url = getControlUrl()
      console.log('[ControlServer] 已启动:', url)
      resolve(url)
    })

    server.on('error', (e) => {
      console.error('[ControlServer] 启动失败:', e)
      reject(e)
    })
  })
}

/** 停止控制服务器 */
export function stopControlServer(): void {
  if (controlServer) {
    controlServer.close()
    controlServer = null
    console.log('[ControlServer] 已停止')
  }
}
