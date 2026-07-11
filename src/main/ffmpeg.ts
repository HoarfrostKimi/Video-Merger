import ffmpeg from 'fluent-ffmpeg'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { join, dirname } from 'path'
import { writeFileSync, unlinkSync, existsSync, renameSync, mkdirSync, openSync, closeSync, statSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { spawn, type ChildProcess } from 'child_process'

// 打包后路径在 app.asar 内，spawn 无法从 asar 虚拟文件系统启动 exe，需重定向到 unpacked 目录
const FFMPEG_PATH = ffmpegInstaller.path.replace('app.asar', 'app.asar.unpacked')
ffmpeg.setFfmpegPath(FFMPEG_PATH)

// 活跃的合并任务映射
const activeMerges = new Map<string, ChildProcess>()

/**
 * 格式化 FFmpeg 错误信息为友好的中文提示
 */
export function formatFfmpegError(stderr: string, exitCode: number): string {
  const last3Lines = stderr.split('\n').slice(-3).join('\n')

  if (/Permission denied|EACCES/i.test(stderr)) {
    return '没有权限写入输出目录，请检查输出路径设置'
  }
  if (/No such file or directory|ENOENT/i.test(stderr)) {
    return '源文件未找到，请检查文件是否存在'
  }
  if (/Invalid argument|Invalid data found/i.test(stderr)) {
    return '视频文件格式不兼容或文件损坏'
  }
  if (/Cannot allocate memory/i.test(stderr)) {
    return '系统内存不足，请关闭一些程序后重试'
  }
  if (exitCode === 137 || /SIGKILL/i.test(stderr)) {
    return '合并被系统终止（可能内存不足）'
  }
  return `合并失败，源文件可能存在问题。详情：${last3Lines}`
}

/**
 * 取消正在进行的合并任务
 */
export function cancelMerge(taskId: string): boolean {
  const child = activeMerges.get(taskId)
  if (!child) return false
  try {
    child.kill('SIGTERM')
    setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
    }, 5000)
  } catch { /* ignore */ }
  activeMerges.delete(taskId)
  return true
}

/**
 * 获取当前活跃的合并任务 ID
 */
export function getActiveMergeTaskId(): string | null {
  const keys = Array.from(activeMerges.keys())
  return keys.length > 0 ? keys[0] : null
}

// 快速探测：只读取文件头信息，不处理整个文件（毫秒级完成）
function ffmpegProbe(filePath: string): Promise<{
  duration: number
  hasAudio: boolean
  hasVideo: boolean
  width: number
  height: number
  codec: string
}> {
  return new Promise((resolve) => {
    const defaultResult = { duration: 0, hasAudio: false, hasVideo: false, width: 0, height: 0, codec: '' }
    // 用 spawn 启动 ffmpeg -i，只读取文件头后立即 kill
    const child = spawn(FFMPEG_PATH, ['-i', filePath])
    let stderr = ''
    let settled = false

    // 10 秒超时兜底，防止损坏文件导致 spawn 进程永不退出
    const probeTimeout = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve(defaultResult)
    }, 10000)

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      // 一旦获取到 Duration 信息就立即终止，不需要读整个文件
      if (stderr.includes('Duration:')) {
        child.kill()
      }
    })

    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(probeTimeout)

      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/)
      let duration = 0
      if (durationMatch) {
        duration = parseFloat(durationMatch[1]) * 3600 +
                   parseFloat(durationMatch[2]) * 60 +
                   parseFloat(durationMatch[3])
      }

      const videoMatch = stderr.match(/Stream\s+#\d+:\d+.*?:\s*Video:\s*(\w+).*?(\d{2,5})x(\d{2,5})/)
      const hasVideo = !!videoMatch
      const codec = videoMatch ? videoMatch[1] : '未知'
      const width = videoMatch ? parseInt(videoMatch[2]) : 0
      const height = videoMatch ? parseInt(videoMatch[3]) : 0

      const hasAudio = /Stream\s+#\d+:\d+.*?:\s*Audio:/.test(stderr)

      resolve({ duration, hasAudio, hasVideo, width, height, codec })
    })

    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(probeTimeout)
      resolve({ duration: 0, hasAudio: false, hasVideo: false, width: 0, height: 0, codec: '' })
    })
  })
}

/**
 * 获取视频文件的基本信息（时长、编码、分辨率等）
 * @param filePath - 视频文件路径
 * @returns 视频信息对象，包含 duration、codec、width、height
 */
export function getVideoInfo(filePath: string): Promise<{
  duration: number
  codec: string
  width: number
  height: number
}> {
  return ffmpegProbe(filePath).then((info) => ({
    duration: info.duration,
    codec: info.codec,
    width: info.width,
    height: info.height
  }))
}

/**
 * 安全移动文件：优先 renameSync（同盘原子操作），失败时 fallback 到 copy+unlink（跨盘）
 */
function safeMoveFile(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch {
    // renameSync 不支持跨盘，fallback 到 copy + unlink
    copyFileSync(src, dest)
    unlinkSync(src)
  }
}

/**
 * 合并多个 FLV 视频文件为一个 MP4 文件
 * 使用 stream copy 模式（不重新编码），速度极快
 * @param filePaths - 要合并的视频文件路径数组
 * @param outputPath - 输出文件路径
 * @param onProgress - 进度回调函数，参数为 0-100 的百分比
 * @param taskId - 可选的任务 ID，用于取消操作
 * @param estimatedDuration - 可选的外部预探测时长（秒），为 0 或不传时内部自动探测
 * @returns 如果有文件被跳过，返回警告信息；否则返回 undefined
 */
export function mergeVideos(
  filePaths: string[],
  outputPath: string,
  onProgress?: (percent: number) => void,
  taskId?: string,
  estimatedDuration?: number
): Promise<string | undefined> {
  return new Promise(async (resolve, reject) => {
    if (filePaths.length === 0) {
      reject(new Error('没有选择任何文件'))
      return
    }

    const accessibleFiles: string[] = []
    const lockedFiles: string[] = []
    for (const p of filePaths) {
      try {
        const fd = openSync(p, 'r')
        closeSync(fd)
        accessibleFiles.push(p)
      } catch {
        lockedFiles.push(p)
      }
    }

    if (accessibleFiles.length === 0) {
      reject(new Error(`所有源文件都被占用：${lockedFiles.length}个文件正在录制中，无法读取`))
      return
    }

    if (lockedFiles.length > 0) {
      console.log(`警告：${lockedFiles.length}个文件正在录制中，已自动跳过`)
    }

    const outDir = dirname(outputPath)
    try {
      mkdirSync(outDir, { recursive: true })
    } catch (err: any) {
      reject(new Error(`无法创建输出目录: ${err.message}`))
      return
    }

    let totalDuration = estimatedDuration && estimatedDuration > 0 ? estimatedDuration : 0
    let totalSourceSize = 0
    // 只有未提供预探测时长时才内部探测（批量合并时已在外部并行探测）
    if (!estimatedDuration || estimatedDuration <= 0) {
      try {
        const firstInfo = await ffmpegProbe(accessibleFiles[0])
        const firstSize = statSync(accessibleFiles[0]).size
        let totalSize = 0
        for (const f of accessibleFiles) {
          try {
            totalSize += statSync(f).size
          } catch { /* ignore */ }
        }
        totalSourceSize = totalSize
        if (firstInfo.duration > 0 && firstSize > 0) {
          const bitrate = firstSize / firstInfo.duration
          totalDuration = totalSize / bitrate
        }
        console.log(`估算总时长: ${totalDuration.toFixed(1)}秒 (基于第一个文件推算)`)
      } catch {
        totalDuration = 0
      }
    } else {
      // 使用预探测时长，仅需计算总文件大小用于磁盘空间检查
      console.log(`使用预探测时长: ${estimatedDuration.toFixed(1)}秒`)
      try {
        for (const f of accessibleFiles) {
          try {
            totalSourceSize += statSync(f).size
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }

    // 磁盘空间预检
    try {
      const statfs = require('fs').statfsSync
      if (typeof statfs === 'function') {
        const stats = statfs(outDir)
        const availableSpace = stats.bavail * stats.bsize
        const requiredSpace = totalSourceSize * 1.1
        if (availableSpace < requiredSpace) {
          const requiredMB = Math.ceil(requiredSpace / (1024 * 1024))
          const availableMB = Math.ceil(availableSpace / (1024 * 1024))
          reject(new Error(`磁盘空间不足，需要 ${requiredMB} MB，剩余 ${availableMB} MB`))
          return
        }
      }
    } catch {
      console.warn('警告：无法检查磁盘空间（statfsSync 不可用），跳过空间预检')
    }

    const listFile = join(tmpdir(), `merge-list-${Date.now()}.txt`)
    const listContent = accessibleFiles
      .map((f) => `file '${f.replace(/'/g, "'\\''" )}'`)
      .join('\n')
    writeFileSync(listFile, listContent, 'utf-8')

    const tempOutput = join(tmpdir(), `merge-temp-${Date.now()}.mp4`)

    // 一步到位：concat demuxer 直接拼接 FLV 并输出为 MP4（stream copy，不重新编码）
    // 添加 -progress pipe:2 让 FFmpeg 以行缓冲模式输出进度到 stderr
    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-progress', 'pipe:2',
      '-y',
      tempOutput
    ]

    console.log('FFmpeg 合并命令: ffmpeg', args.join(' '))

    const child = spawn(FFMPEG_PATH, args)

    // 注册到活跃合并映射
    if (taskId) {
      activeMerges.set(taskId, child)
    }

    // 超时设置（放在 child 声明之后，以便回调中引用 child）
    let timedOut = false
    const timeoutHandle = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
      }, 5000)
      try { if (existsSync(tempOutput)) unlinkSync(tempOutput) } catch { /* ignore */ }
      try { if (existsSync(listFile)) unlinkSync(listFile) } catch { /* ignore */ }
      if (taskId) activeMerges.delete(taskId)
      reject(new Error('合并超时（30分钟），部分源文件可能正在录制中'))
    }, 30 * 60 * 1000)

    let stderrBuf = ''

    // 实时解析 stderr 中的进度信息（保留原有 time= 解析作为 fallback）
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderrBuf += text

      // 优先解析 -progress 格式的 out_time_ms（微秒）
      const progressMatch = text.match(/out_time_ms=(\d+)/)
      if (progressMatch && onProgress && totalDuration > 0) {
        const currentSeconds = parseInt(progressMatch[1]) / 1_000_000
        const percent = Math.min((currentSeconds / totalDuration) * 100, 99.9)
        console.log(`[进度] ${currentSeconds.toFixed(1)}s/${totalDuration.toFixed(1)}s = ${percent.toFixed(1)}%`)
        onProgress(percent)
        return
      }

      // fallback: 解析传统 time= 格式
      const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/)
      if (timeMatch && onProgress && totalDuration > 0) {
        const currentSeconds =
          parseFloat(timeMatch[1]) * 3600 +
          parseFloat(timeMatch[2]) * 60 +
          parseFloat(timeMatch[3])
        const percent = Math.min((currentSeconds / totalDuration) * 100, 99.9)
        console.log(`[进度] ${currentSeconds.toFixed(1)}s/${totalDuration.toFixed(1)}s = ${percent.toFixed(1)}%`)
        onProgress(percent)
      }
    })

    child.on('close', (code) => {
      if (timedOut) return
      clearTimeout(timeoutHandle)
      if (taskId) activeMerges.delete(taskId)

      // 清理列表文件
      try { if (existsSync(listFile)) unlinkSync(listFile) } catch { /* ignore */ }

      if (code !== 0) {
        const friendlyMsg = formatFfmpegError(stderrBuf, code ?? -1)
        console.error('FFmpeg 合并失败, exit code:', code, '\n', stderrBuf.split('\n').slice(-20).join('\n'))
        try { if (existsSync(tempOutput)) unlinkSync(tempOutput) } catch { /* ignore */ }
        reject(new Error(friendlyMsg))
        return
      }

      // 合并成功，安全移动输出文件
      try {
        // 确认 tempOutput 存在且有效
        const tempStat = statSync(tempOutput)
        if (!existsSync(tempOutput) || tempStat.size === 0) {
          reject(new Error('合并产出的文件无效（大小为 0 或不存在）'))
          return
        }

        if (existsSync(outputPath)) {
          try {
            unlinkSync(outputPath)
          } catch {
            const backupPath = outputPath.replace(/\.mp4$/i, '_backup.mp4')
            try {
              if (existsSync(backupPath)) unlinkSync(backupPath)
              renameSync(outputPath, backupPath)
            } catch (e: any) {
              try { if (existsSync(tempOutput)) unlinkSync(tempOutput) } catch { /* ignore */ }
              reject(new Error(`无法覆盖已有文件: ${outputPath}, ${e.message}`))
              return
            }
          }
        }

        safeMoveFile(tempOutput, outputPath)

        // 验证目标文件存在且大小 > 0
        if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
          reject(new Error('输出文件验证失败：文件不存在或大小为 0'))
          return
        }

        const msg = lockedFiles.length > 0
          ? `合并完成！但跳过了${lockedFiles.length}个正在录制中的片段`
          : undefined
        resolve(msg)
      } catch (err: any) {
        try { if (existsSync(tempOutput)) unlinkSync(tempOutput) } catch { /* ignore */ }
        reject(new Error(`移动输出文件失败: ${err.message}`))
      }
    })

    child.on('error', (err) => {
      if (timedOut) return
      clearTimeout(timeoutHandle)
      if (taskId) activeMerges.delete(taskId)
      try { if (existsSync(tempOutput)) unlinkSync(tempOutput) } catch { /* ignore */ }
      try { if (existsSync(listFile)) unlinkSync(listFile) } catch { /* ignore */ }
      reject(new Error(`启动 FFmpeg 失败: ${err.message}`))
    })
  })
}

/**
 * 将视频文件转换为 MP4 格式（重新编码）
 * 使用 H.264 视频编码 + AAC 音频编码
 * @param filePath - 输入视频文件路径
 * @param outputPath - 输出 MP4 文件路径
 * @param onProgress - 进度回调函数，参数为 0-100 的百分比
 */
export function convertToMp4(
  filePath: string,
  outputPath: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const outDir = dirname(outputPath)
    try {
      mkdirSync(outDir, { recursive: true })
    } catch (err: any) {
      reject(new Error(`无法创建输出目录: ${err.message}`))
      return
    }

    const tempOutput = join(tmpdir(), `convert-temp-${Date.now()}.mp4`)
    let timedOut = false

    const command = ffmpeg(filePath)
      .output(tempOutput)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-movflags', '+faststart'])
      .on('start', (cmd) => {
        console.log('FFmpeg 转换命令:', cmd)
      })
      .on('progress', (info) => {
        if (onProgress && info.percent) {
          onProgress(Math.min(info.percent, 100))
        }
      })
      .on('end', () => {
        if (timedOut) return
        clearTimeout(timeoutHandle)
        try {
          if (existsSync(outputPath)) {
            try { unlinkSync(outputPath) } catch {
              try { renameSync(outputPath, outputPath.replace(/\.mp4$/i, '_backup.mp4')) } catch { /* ignore */ }
            }
          }
          safeMoveFile(tempOutput, outputPath)
          resolve()
        } catch (err: any) {
          try { if (existsSync(tempOutput)) unlinkSync(tempOutput) } catch { /* ignore */ }
          reject(new Error(`移动输出文件失败: ${err.message}`))
        }
      })
      .on('error', (err) => {
        if (timedOut) return
        clearTimeout(timeoutHandle)
        try { if (existsSync(tempOutput)) unlinkSync(tempOutput) } catch { /* ignore */ }
        reject(new Error(`转换失败: ${err.message}`))
      })

    // 30 分钟超时机制
    const timeoutHandle = setTimeout(() => {
      timedOut = true
      try { command.kill('SIGTERM') } catch { /* ignore */ }
      setTimeout(() => {
        try { command.kill('SIGKILL') } catch { /* already exited */ }
      }, 5000)
      try { if (existsSync(tempOutput)) unlinkSync(tempOutput) } catch { /* ignore */ }
      reject(new Error('转换超时（30分钟）'))
    }, 30 * 60 * 1000)

    command.run()
  })
}
