import { describe, it, expect } from 'vitest'

/**
 * 测试 FFmpeg 输出解析逻辑
 * 对应 src/main/ffmpeg.ts 中从 ffmpeg 输出解析时长和进度信息的正则表达式
 */

describe('FFmpeg 时长解析', () => {
  function parseDuration(stderr: string): number {
    const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/)
    if (durationMatch) {
      return parseFloat(durationMatch[1]) * 3600 +
             parseFloat(durationMatch[2]) * 60 +
             parseFloat(durationMatch[3])
    }
    return 0
  }

  it('标准时长格式 - 应正确解析为秒数', () => {
    const stderr = '  Duration: 01:23:45.67, start: 0.000000, bitrate: 1234 kb/s'
    const duration = parseDuration(stderr)
    // 1*3600 + 23*60 + 45.67 = 3600 + 1380 + 45.67 = 5025.67
    expect(duration).toBeCloseTo(5025.67, 2)
  })

  it('零时长 - 应返回 0', () => {
    const stderr = '  Duration: 00:00:00.00, start: 0.000000'
    expect(parseDuration(stderr)).toBe(0)
  })

  it('只有秒数不为零', () => {
    const stderr = '  Duration: 00:00:30.50'
    expect(parseDuration(stderr)).toBeCloseTo(30.5, 2)
  })

  it('没有 Duration 信息 - 应返回 0', () => {
    const stderr = 'Some random output without duration info'
    expect(parseDuration(stderr)).toBe(0)
  })

  it('空字符串 - 应返回 0', () => {
    expect(parseDuration('')).toBe(0)
  })

  it('多行输出中应能提取 Duration', () => {
    const stderr = [
      'Input #0, flv, from \'test.flv\':',
      '  Metadata:',
      '    encoder         : Lavf58.76.100',
      '  Duration: 00:15:30.00, start: 0.000000, bitrate: 2500 kb/s',
      '    Stream #0:0: Video: h264, yuv420p, 1920x1080'
    ].join('\n')
    expect(parseDuration(stderr)).toBeCloseTo(930, 2)
  })
})

describe('FFmpeg 进度解析', () => {
  function parseProgress(stderr: string, totalDuration: number): number | null {
    const timeMatch = stderr.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/)
    if (timeMatch && totalDuration > 0) {
      const currentSeconds =
        parseFloat(timeMatch[1]) * 3600 +
        parseFloat(timeMatch[2]) * 60 +
        parseFloat(timeMatch[3])
      return Math.min((currentSeconds / totalDuration) * 100, 99.9)
    }
    return null
  }

  it('正常进度 - 应返回正确百分比', () => {
    const stderr = 'frame=  120 fps=30.0 q=-1.0 size=    1024kB time=00:05:00.00 bitrate= 500kbits/s'
    const percent = parseProgress(stderr, 600) // 总时长 600 秒
    expect(percent).toBeCloseTo(50, 1)
  })

  it('进度超过总时长 - 应限制在 99.9%', () => {
    const stderr = 'time=00:11:00.00'
    const percent = parseProgress(stderr, 600) // 当前 660 秒 > 总 600 秒
    expect(percent).toBe(99.9)
  })

  it('没有 time 信息 - 应返回 null', () => {
    const stderr = 'frame=  120 fps=30.0'
    expect(parseProgress(stderr, 600)).toBeNull()
  })

  it('总时长为 0 - 应返回 null（避免除零）', () => {
    const stderr = 'time=00:05:00.00'
    expect(parseProgress(stderr, 0)).toBeNull()
  })

  it('刚开始处理 - 进度应接近 0', () => {
    const stderr = 'time=00:00:01.00'
    const percent = parseProgress(stderr, 3600) // 1 秒 / 1 小时
    expect(percent!).toBeLessThan(1)
  })
})

describe('FFmpeg 视频流信息解析', () => {
  function parseVideoInfo(stderr: string) {
    const videoMatch = stderr.match(/Stream\s+#\d+:\d+.*?:\s*Video:\s*(\w+).*?(\d{2,5})x(\d{2,5})/)
    const hasVideo = !!videoMatch
    const codec = videoMatch ? videoMatch[1] : '未知'
    const width = videoMatch ? parseInt(videoMatch[2]) : 0
    const height = videoMatch ? parseInt(videoMatch[3]) : 0
    const hasAudio = /Stream\s+#\d+:\d+.*?:\s*Audio:/.test(stderr)
    return { hasVideo, codec, width, height, hasAudio }
  }

  it('标准 FLV 文件输出 - 应识别视频和音频流', () => {
    const stderr = [
      'Input #0, flv:',
      '  Duration: 00:10:00.00',
      '    Stream #0:0: Video: h264, yuv420p, 1920x1080',
      '    Stream #0:1: Audio: aac, 44100 Hz, stereo'
    ].join('\n')
    const info = parseVideoInfo(stderr)
    expect(info.hasVideo).toBe(true)
    expect(info.codec).toBe('h264')
    expect(info.width).toBe(1920)
    expect(info.height).toBe(1080)
    expect(info.hasAudio).toBe(true)
  })

  it('只有视频没有音频', () => {
    const stderr = 'Stream #0:0: Video: h264, 1280x720'
    const info = parseVideoInfo(stderr)
    expect(info.hasVideo).toBe(true)
    expect(info.hasAudio).toBe(false)
  })

  it('没有视频信息 - 应返回默认值', () => {
    const stderr = 'Some random text'
    const info = parseVideoInfo(stderr)
    expect(info.hasVideo).toBe(false)
    expect(info.codec).toBe('未知')
    expect(info.width).toBe(0)
    expect(info.height).toBe(0)
  })

  it('不同分辨率', () => {
    const stderr = 'Stream #0:0: Video: flv1, 640x480'
    const info = parseVideoInfo(stderr)
    expect(info.width).toBe(640)
    expect(info.height).toBe(480)
  })
})

describe('FFmpeg 错误消息友好化', () => {
  /**
   * 对应 src/main/ffmpeg.ts 中的 formatFfmpegError 函数
   * 将 FFmpeg 原始错误信息映射为用户友好的中文提示
   */
  function formatFfmpegError(stderr: string, exitCode: number): string {
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

  it('Permission denied - 应返回包含"权限"的提示', () => {
    const msg = formatFfmpegError('Output file: Permission denied', 1)
    expect(msg).toContain('权限')
  })

  it('EACCES - 应返回包含"权限"的提示', () => {
    const msg = formatFfmpegError('EACCES: permission denied', 1)
    expect(msg).toContain('权限')
  })

  it('No such file or directory - 应返回包含"未找到"的提示', () => {
    const msg = formatFfmpegError('No such file or directory', 1)
    expect(msg).toContain('未找到')
  })

  it('ENOENT - 应返回包含"未找到"的提示', () => {
    const msg = formatFfmpegError('ENOENT: no such file', 1)
    expect(msg).toContain('未找到')
  })

  it('Invalid data found - 应返回包含"格式不兼容"的提示', () => {
    const msg = formatFfmpegError('Invalid data found when processing input', 1)
    expect(msg).toContain('格式不兼容')
  })

  it('Invalid argument - 应返回包含"格式不兼容"的提示', () => {
    const msg = formatFfmpegError('Invalid argument in stream spec', 1)
    expect(msg).toContain('格式不兼容')
  })

  it('Cannot allocate memory - 应返回包含"内存不足"的提示', () => {
    const msg = formatFfmpegError('Cannot allocate memory for buffer', 1)
    expect(msg).toContain('内存不足')
  })

  it('exitCode 137 (SIGKILL) - 应返回系统终止提示', () => {
    const msg = formatFfmpegError('Some output', 137)
    expect(msg).toContain('系统终止')
  })

  it('SIGKILL 关键字 - 应返回系统终止提示', () => {
    const msg = formatFfmpegError('Process received SIGKILL', 1)
    expect(msg).toContain('系统终止')
  })

  it('未知错误 - 应包含 stderr 最后几行', () => {
    const stderr = 'line1\nline2\nline3\nline4\nline5'
    const msg = formatFfmpegError(stderr, 1)
    expect(msg).toContain('line3')
    expect(msg).toContain('line4')
    expect(msg).toContain('line5')
    expect(msg).not.toContain('line1')
    expect(msg).not.toContain('line2')
  })

  it('未知错误 - 短 stderr 应全部包含', () => {
    const stderr = 'only error line'
    const msg = formatFfmpegError(stderr, 1)
    expect(msg).toContain('only error line')
    expect(msg).toContain('详情')
  })
})
