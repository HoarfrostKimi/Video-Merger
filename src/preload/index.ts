import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/**
 * 调用 IPC 接口并自动解包返回结果
 * 后端统一返回 { success, data?, message? } 格式
 * 成功时返回 data，失败时抛出错误
 */
async function invokeApi(channel: string, ...args: unknown[]): Promise<any> {
  const result = await ipcRenderer.invoke(channel, ...args)
  if (result && typeof result === 'object' && 'success' in result) {
    if (!result.success) {
      throw new Error(result.message || '操作失败')
    }
    return result.data
  }
  return result
}

// 暴露给渲染进程的 API
const api = {
  // 配置管理
  loadConfig: () => invokeApi('config:load'),
  saveConfig: (config: Record<string, unknown>) => invokeApi('config:save', config),

  // 文件夹操作
  selectFolder: () => invokeApi('dialog:selectFolder'),
  selectOutputFolder: () => invokeApi('dialog:selectOutputFolder'),
  openDirectory: (path: string) => invokeApi('dialog:openDirectory', path),
  openExternal: (url: string) => invokeApi('dialog:openExternal', url),

  // 文件扫描
scanFlvFiles: (folderPath: string, maxIntervalHours?: number) => invokeApi('scan:flvFiles', folderPath, maxIntervalHours),

  // 视频处理
  getVideoInfo: (filePath: string) => invokeApi('video:getInfo', filePath),
  mergeVideos: (filePaths: string[], outputPath: string) =>
    invokeApi('video:merge', filePaths, outputPath),
  convertVideo: (filePath: string, outputPath: string) =>
    invokeApi('video:convert', filePath, outputPath),

  // 批量并行合并
  batchMergeVideos: (tasks: Array<{ taskId: string; filePaths: string[]; outputPath: string; folderName: string }>, concurrency?: number) =>
    invokeApi('video:batchMerge', tasks, concurrency),

  // 获取当前进度（轮询方式，更可靠）
  getProgress: () => invokeApi('progress:get'),
  getBatchProgress: () => invokeApi('progress:getBatch'),
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
