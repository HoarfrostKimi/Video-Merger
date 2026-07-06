import ffmpeg from 'fluent-ffmpeg'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { join, dirname } from 'path'
import { writeFileSync, unlinkSync, existsSync, renameSync, mkdirSync, openSync, closeSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { spawn } from 'child_process'

ffmpeg.setFfmpegPath(ffmpegInstaller.path)

const FFMPEG_PATH = ffmpegInstaller.path

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
    // 用 spawn 启动 ffmpeg -i，只读取文件头后立即 kill
    const child = spawn(FFMPEG_PATH, ['-i', filePath])
    let stderr = ''

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      // 一旦获取到 Duration 信息就立即终止，不需要读整个文件
      if (stderr.includes('Duration:')) {
        child.kill()
      }
    })

    child.on('close', () => {
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
      resolve({ duration: 0, hasAudio: false, hasVideo: false, width: 0, height: 0, codec: '未知' })
    })
  })
}

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

export function mergeVideos(
  filePaths: string[],
  outputPath: string,
  onProgress?: (percent: number) => void
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

    let totalDuration = 0
    try {
      const firstInfo = await ffmpegProbe(accessibleFiles[0])
      const firstSize = statSync(accessibleFiles[0]).size
      let totalSize = 0
      for (const f of accessibleFiles) {
        try {
          totalSize += statSync(f).size
        } catch { /* ignore */ }
      }
      if (firstInfo.duration > 0 && firstSize > 0) {
        const bitrate = firstSize / firstInfo.duration
        totalDuration = totalSize / bitrate
      }
      console.log(`估算总时长: ${totalDuration.toFixed(1)}秒 (基于第一个文件推算)`)
    } catch {
      totalDuration = 0
    }

    const listFile = join(tmpdir(), `merge-list-${Date.now()}.txt`)
    const listContent = accessibleFiles
      .map((f) => `file '${f.replace(/'/g, "'\\''" )}'`)
      .join('\n')
    writeFileSync(listFile, listContent, 'utf-8')

    const tempOutput = join(tmpdir(), `merge-temp-${Date.now()}.mp4`)

    let timedOut = false
    const timeoutHandle = setTimeout(() => {
      timedOut = true
      try { if (existsSync(tempOutput)) unlinkSync(tempOutput) } catch { /* ignore */ }
      try { if (existsSync(listFile)) unlinkSync(listFile) } catch { /* ignore */ }
      reject(new Error('合并超时（30分钟），部分源文件可能正在录制中'))
    }, 30 * 60 * 1000)

    // 一步到位：concat demuxer 直接拼接 FLV 并输出为 MP4（stream copy，不重新编码）
    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-y',
      tempOutput
    ]

    console.log('FFmpeg 合并命令: ffmpeg', args.join(' '))

    const child = spawn(FFMPEG_PATH, args)
    let stderrBuf = ''

    // 实时解析 stderr 中的进度信息
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderrBuf += text
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

      // 清理列表文件
      try { if (existsSync(listFile)) unlinkSync(listFile) } catch { /* ignore */ }

      if (code !== 0) {
        const lastLines = stderrBuf.split('\n').slice(-10).join('\n')
        console.error('FFmpeg 合并失败, exit code:', code, '\n', lastLines)
        try { if (existsSync(tempOutput)) unlinkSync(tempOutput) } catch { /* ignore */ }
        reject(new Error(`合并失败 (exit code ${code})`))
        return
      }

      // 合并成功，移动输出文件
      try {
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
        renameSync(tempOutput, outputPath)
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
      try { if (existsSync(tempOutput)) unlinkSync(tempOutput) } catch { /* ignore */ }
      try { if (existsSync(listFile)) unlinkSync(listFile) } catch { /* ignore */ }
      reject(new Error(`启动 FFmpeg 失败: ${err.message}`))
    })
  })
}

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

    ffmpeg(filePath)
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
        try {
          if (existsSync(outputPath)) {
            try { unlinkSync(outputPath) } catch {
              renameSync(outputPath, outputPath.replace(/\.mp4$/i, '_backup.mp4'))
            }
          }
          renameSync(tempOutput, outputPath)
          resolve()
        } catch (err: any) {
          try { if (existsSync(tempOutput)) unlinkSync(tempOutput) } catch { /* ignore */ }
          reject(new Error(`移动输出文件失败: ${err.message}`))
        }
      })
      .on('error', (err) => {
        try { if (existsSync(tempOutput)) unlinkSync(tempOutput) } catch { /* ignore */ }
        reject(new Error(`转换失败: ${err.message}`))
      })
      .run()
  })
}
