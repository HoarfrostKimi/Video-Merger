// core/webcodecsFrame.js - WebCodecs 截帧：mp4 解封装 + VideoDecoder 解码单帧 + OffscreenCanvas 出图
// 核心价值：VideoDecoder 是纯解码 API，不进入渲染/合成管线，
// 页面不可见（电脑黑屏、锁屏、窗口最小化）时照常解码——这是 <video> 元素方案做不到的。
import { locateKeyframeInMp4 } from './mp4.js'

/**
 * 用 WebCodecs 从视频文件截取一帧（默认 ~2s 处的关键帧）。
 * @param {File|Blob} file 视频文件（MP4/H.264）
 * @param {number} [atSeconds=2] 目标时间（秒）
 * @param {number} [timeoutMs=15000] 解码超时
 * @returns {Promise<Blob>} JPEG Blob（4:3 居中裁剪，与 video 元素方案保持一致）
 */
export async function captureFrameWithWebCodecs(file, atSeconds = 2, timeoutMs = 15000) {
  if (typeof window === 'undefined' || !('VideoDecoder' in window) || !('EncodedVideoChunk' in window)) {
    throw new Error('浏览器不支持 WebCodecs')
  }
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('浏览器不支持 OffscreenCanvas')
  }

  // 1. 解封装：找到目标关键帧的样本字节与解码配置
  const info = await locateKeyframeInMp4(file, atSeconds)

  // 2. 解码配置校验
  const config = { codec: info.codec, description: info.description, optimizeForLatency: true }
  if (info.width) config.codedWidth = info.width
  if (info.height) config.codedHeight = info.height
  let support
  try {
    support = await VideoDecoder.isConfigSupported(config)
  } catch (e) {
    throw new Error(`解码配置无法识别(${info.codec}): ${e.message}`)
  }
  if (!support || !support.supported) {
    throw new Error(`浏览器不支持该视频编码(${info.codec})`)
  }

  // 3. 解码单个关键帧
  const frame = await decodeOneFrame(config, info.sampleBuffer, info.timestampUs, timeoutMs)

  // 4. 出图（4:3 居中裁剪 → JPEG）
  try {
    return await drawFrameToJpeg(frame)
  } finally {
    frame.close()
  }
}

/** 解码单个关键帧样本，输出第一个 VideoFrame */
function decodeOneFrame(config, data, timestampUs, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    let decoder = null
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { if (decoder && decoder.state !== 'closed') decoder.close() } catch (e) { /* 忽略 */ }
      reject(new Error('WebCodecs 解码超时'))
    }, timeoutMs)
    try {
      decoder = new VideoDecoder({
        output: (frame) => {
          if (settled) { frame.close(); return }
          settled = true
          clearTimeout(timer)
          resolve(frame)
          // 异步关闭，避免在 output 回调内同步 close 触发状态异常
          setTimeout(() => { try { decoder.close() } catch (e) { /* 忽略 */ } }, 0)
        },
        error: (e) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(new Error(`解码失败: ${(e && e.message) || e}`))
        },
      })
      decoder.configure(config)
      decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: timestampUs, data }))
      decoder.flush().catch(() => { /* 成功与否以上面 output/error 回调为准 */ })
    } catch (e) {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`解码启动失败: ${e.message}`))
      }
    }
  })
}

/** VideoFrame → 4:3 居中裁剪 → JPEG Blob */
async function drawFrameToJpeg(frame) {
  const vw = frame.displayWidth || frame.codedWidth
  const vh = frame.displayHeight || frame.codedHeight
  if (!vw || !vh) throw new Error('解码帧尺寸无效')

  // 计算 4:3 居中裁剪区域（与 captureFrameFromFile 的 video 元素方案保持一致）
  const targetRatio = 4 / 3
  const videoRatio = vw / vh
  let sx, sy, sw, sh
  if (videoRatio > targetRatio) {
    // 视频更宽，裁剪左右
    sh = vh
    sw = vh * targetRatio
    sx = (vw - sw) / 2
    sy = 0
  } else {
    // 视频更高，裁剪上下
    sw = vw
    sh = vw / targetRatio
    sx = 0
    sy = (vh - sh) / 2
  }

  const canvas = new OffscreenCanvas(Math.round(sw), Math.round(sh))
  const ctx = canvas.getContext('2d')
  ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
  if (!blob) throw new Error('JPEG 编码失败')
  return blob
}
