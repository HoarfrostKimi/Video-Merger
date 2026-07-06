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
