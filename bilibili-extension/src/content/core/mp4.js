// core/mp4.js - 极简 MP4 解封装：只服务封面截帧场景
// 目标：定位 ~N 秒处的一个关键帧样本（文件偏移 + 大小 + 解码配置），不做完整 demux。
// 纯字节解析、无 DOM 依赖，可在 Node（vitest）下单测。
// 依据 ISO/IEC 14496-12（容器结构）与 14496-15（AVC 编码配置）。
// 为什么需要它：截帧不再走 <video> 元素（页面黑屏时浏览器会挂起其解码），
// 改用 WebCodecs VideoDecoder 直接解一个关键帧，而喂给它样本前必须自己解出样本位置。

/** 读大端 u16 */
function u16At(u8, off) {
  return (u8[off] << 8) | u8[off + 1]
}

/** 读大端 u32（无符号） */
function u32At(u8, off) {
  return ((u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3]) >>> 0
}

/** 读大端 u64（Number，精确到 2^53，足够文件偏移用） */
function u64At(u8, off) {
  return u32At(u8, off) * 4294967296 + u32At(u8, off + 4)
}

/** 读 4 字符 box 类型（如 'moov'、'mdat'） */
function typeAt(u8, off) {
  return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3])
}

/**
 * 迭代 [start, end) 内的完整 box。
 * @yields {{type:string, start:number, size:number, headerSize:number, contentStart:number, contentEnd:number}}
 */
export function* iterateBoxes(u8, start, end) {
  let off = start
  while (off + 8 <= end) {
    let size = u32At(u8, off)
    let headerSize = 8
    if (size === 1) {
      if (off + 16 > end) return
      size = u64At(u8, off + 8)
      headerSize = 16
    } else if (size === 0) {
      size = end - off // size=0 表示 box 延伸到结尾
    }
    if (size < headerSize || off + size > end) return // 截断或非法，停止迭代
    yield { type: typeAt(u8, off + 4), start: off, size, headerSize, contentStart: off + headerSize, contentEnd: off + size }
    off += size
  }
}

/** 只读顶层 box 头（内容允许截断），用于判断 moov 在文件头还是文件尾 */
function* scanTopBoxHeaders(u8, start, end) {
  let off = start
  while (off + 8 <= end) {
    let size = u32At(u8, off)
    let headerSize = 8
    if (size === 1) {
      if (off + 16 > end) return
      size = u64At(u8, off + 8)
      headerSize = 16
    }
    if (size < headerSize) return
    yield { type: typeAt(u8, off + 4), start: off, size, headerSize }
    if (size === 0) return
    off += size
  }
}

const hex2 = (n) => n.toString(16).padStart(2, '0')

/**
 * 解析 stsd 里的视频编码信息（当前支持 AVC：avc1/avc3）。
 * @returns {{codec:string, description:Uint8Array, width:number, height:number}|{unsupported:string}|null}
 */
function parseStsd(buf, stsd) {
  // stsd: version/flags(4) + entry_count(4) + sample entries
  for (const entry of iterateBoxes(buf, stsd.contentStart + 8, stsd.contentEnd)) {
    if (entry.type === 'avc1' || entry.type === 'avc3') {
      // VisualSampleEntry 固定字段 78 字节（紧跟 8 字节 box 头），width/height 位于第 24/26 字节
      const width = u16At(buf, entry.contentStart + 24)
      const height = u16At(buf, entry.contentStart + 26)
      let avcC = null
      for (const child of iterateBoxes(buf, entry.contentStart + 78, entry.contentEnd)) {
        if (child.type === 'avcC') { avcC = child; break }
      }
      if (!avcC) continue
      // avcC 载荷即 AVCDecoderConfigurationRecord：[version][profile][compat][level]...
      const p = avcC.contentStart
      const codec = 'avc1.' + hex2(buf[p + 1]) + hex2(buf[p + 2]) + hex2(buf[p + 3])
      const description = buf.slice(avcC.contentStart, avcC.contentEnd)
      return { codec, description, width, height }
    }
    if (entry.type === 'hev1' || entry.type === 'hvc1') {
      return { unsupported: `HEVC(${entry.type}) 编码暂不支持 WebCodecs 截帧` }
    }
  }
  return null
}

/**
 * 解析 moov box（缓冲区应恰为一个 moov box）中的第一条视频轨。
 * @returns {object|null} 轨道信息（含样本表）；非视频轨或结构不完整返回 null
 */
export function parseMoovVideoTrack(moov) {
  let top = null
  for (const b of iterateBoxes(moov, 0, moov.length)) { top = b; break }
  if (!top || top.type !== 'moov') return null
  for (const trak of iterateBoxes(moov, top.contentStart, top.contentEnd)) {
    if (trak.type !== 'trak') continue
    const track = parseTrak(moov, trak)
    if (track) return track
  }
  return null
}

function parseTrak(buf, trak) {
  let mdia = null
  for (const b of iterateBoxes(buf, trak.contentStart, trak.contentEnd)) {
    if (b.type === 'mdia') { mdia = b; break }
  }
  if (!mdia) return null

  let hdlr = null, mdhd = null, minf = null
  for (const b of iterateBoxes(buf, mdia.contentStart, mdia.contentEnd)) {
    if (b.type === 'hdlr') hdlr = b
    else if (b.type === 'mdhd') mdhd = b
    else if (b.type === 'minf') minf = b
  }
  if (!hdlr || !mdhd || !minf) return null

  // hdlr: version/flags(4) + pre_defined(4) + handler_type(4)
  if (typeAt(buf, hdlr.contentStart + 8) !== 'vide') return null

  // mdhd timescale（v0 与 v1 版本的字段宽度不同）
  const mdhdVersion = buf[mdhd.contentStart]
  const timescale = u32At(buf, mdhd.contentStart + (mdhdVersion === 1 ? 20 : 12))
  if (!timescale) return null

  let stbl = null
  for (const b of iterateBoxes(buf, minf.contentStart, minf.contentEnd)) {
    if (b.type === 'stbl') { stbl = b; break }
  }
  if (!stbl) return null

  const t = {}
  for (const b of iterateBoxes(buf, stbl.contentStart, stbl.contentEnd)) {
    t[b.type] = b
  }
  if (!t.stsd || !t.stts || !t.stsc || !t.stsz || !(t.stco || t.co64)) return null

  const codecInfo = parseStsd(buf, t.stsd)
  if (!codecInfo) return null
  if (codecInfo.unsupported) return { unsupported: codecInfo.unsupported }

  // ---- 样本表 ----
  // stts: (sample_count, sample_delta) 对
  const sttsPairs = []
  const sttsCount = u32At(buf, t.stts.contentStart + 4)
  for (let i = 0; i < sttsCount; i++) {
    const off = t.stts.contentStart + 8 + i * 8
    sttsPairs.push({ count: u32At(buf, off), delta: u32At(buf, off + 4) })
  }
  // stss: 关键帧样本号（1 基）；缺省表示全部样本均为关键帧
  let keyframes = null
  if (t.stss) {
    const n = u32At(buf, t.stss.contentStart + 4)
    keyframes = []
    for (let i = 0; i < n; i++) keyframes.push(u32At(buf, t.stss.contentStart + 8 + i * 4) - 1)
  }
  // stsc: (first_chunk, samples_per_chunk) 条目（sample_description_index 不用）
  const stscEntries = []
  const stscCount = u32At(buf, t.stsc.contentStart + 4)
  for (let i = 0; i < stscCount; i++) {
    const off = t.stsc.contentStart + 8 + i * 12
    stscEntries.push({ firstChunk: u32At(buf, off), samplesPerChunk: u32At(buf, off + 4) })
  }
  // stsz: 统一样本大小，或逐样本大小表
  const uniformSize = u32At(buf, t.stsz.contentStart + 4)
  const sampleCount = u32At(buf, t.stsz.contentStart + 8)
  if (!sampleCount) return null
  let sampleSizes = null
  if (uniformSize === 0) {
    sampleSizes = new Uint32Array(sampleCount)
    for (let i = 0; i < sampleCount; i++) sampleSizes[i] = u32At(buf, t.stsz.contentStart + 12 + i * 4)
  }
  // stco / co64: 各 chunk 起始的文件绝对偏移
  const chunkBox = t.co64 || t.stco
  const chunkCount = u32At(buf, chunkBox.contentStart + 4)
  const chunkOffsets = new Float64Array(chunkCount)
  for (let i = 0; i < chunkCount; i++) {
    const off = chunkBox.contentStart + 8 + i * (t.co64 ? 8 : 4)
    chunkOffsets[i] = t.co64 ? u64At(buf, off) : u32At(buf, off)
  }

  // 各样本起始 pts（timescale 单位）
  const pts = new Float64Array(sampleCount)
  let acc = 0, idx = 0
  for (const { count, delta } of sttsPairs) {
    for (let k = 0; k < count && idx < sampleCount; k++, idx++) { pts[idx] = acc; acc += delta }
  }

  return {
    timescale,
    codec: codecInfo.codec,
    description: codecInfo.description,
    width: codecInfo.width,
    height: codecInfo.height,
    sampleCount, pts, keyframes,
    sampleSizes, uniformSize,
    stscEntries, chunkCount, chunkOffsets,
  }
}

function sampleSize(track, i) {
  return track.sampleSizes ? track.sampleSizes[i] : track.uniformSize
}

/** 计算第 i 个样本（0 基）的文件绝对偏移（stsc + stco + stsz 组合推导） */
function sampleFileOffset(track, i) {
  if (i < 0 || i >= track.sampleCount) return -1
  const { stscEntries, chunkOffsets, chunkCount } = track
  let covered = 0
  for (let e = 0; e < stscEntries.length; e++) {
    const { firstChunk, samplesPerChunk } = stscEntries[e]
    if (samplesPerChunk <= 0) return -1
    const nextFirst = e + 1 < stscEntries.length ? stscEntries[e + 1].firstChunk : chunkCount + 1
    const chunkSpan = nextFirst - firstChunk
    if (chunkSpan <= 0) return -1
    const samplesInEntry = chunkSpan * samplesPerChunk
    if (i < covered + samplesInEntry) {
      const local = i - covered
      const chunkIdx = firstChunk - 1 + Math.floor(local / samplesPerChunk)
      if (chunkIdx < 0 || chunkIdx >= chunkCount) return -1
      const idxInChunk = local % samplesPerChunk
      let off = chunkOffsets[chunkIdx]
      for (let k = i - idxInChunk; k < i; k++) off += sampleSize(track, k)
      return off
    }
    covered += samplesInEntry
  }
  return -1
}

/** 选择 ~atSeconds 处的关键帧样本（0 基索引）：取 pts 不超过目标时间的最后一个关键帧 */
function pickKeyframeIndex(track, atSeconds) {
  const limit = atSeconds * track.timescale
  if (track.keyframes && track.keyframes.length) {
    let target = track.keyframes[0]
    for (const k of track.keyframes) {
      if (track.pts[k] <= limit) target = k
      else break
    }
    return target
  }
  // 无 stss：所有样本均为关键帧
  let target = 0
  for (let i = 0; i < track.sampleCount && track.pts[i] <= limit; i++) target = i
  return target
}

/**
 * 在 MP4（Blob/File）中定位 ~atSeconds 处的关键帧样本。
 * 兼容 faststart（moov 在头）与 moov 在尾两种布局，只按需读取文件片段，不整读大文件。
 * @param {Blob} file 支持 slice()/arrayBuffer() 的对象（File/Blob 均可）
 * @param {number} [atSeconds=2] 目标时间（秒）
 * @returns {Promise<{codec:string, description:Uint8Array, width:number, height:number,
 *                    timestampUs:number, keyframeIndex:number, keyframeSec:number, sampleBuffer:ArrayBuffer}>}
 */
export async function locateKeyframeInMp4(file, atSeconds = 2) {
  if (!file || typeof file.slice !== 'function' || !file.size) throw new Error('无效的文件对象')
  if (file.size < 16) throw new Error('文件过小，不是有效 MP4')

  // ---- 1. 定位 moov：先扫文件头（faststart），遇到 mdat 仍未见 moov 则从文件尾回扫 ----
  const headLen = Math.min(file.size, 256 * 1024)
  const head = new Uint8Array(await file.slice(0, headLen).arrayBuffer())
  let moov = null
  for (const b of scanTopBoxHeaders(head, 0, head.length)) {
    if (b.type === 'moov') {
      moov = new Uint8Array(await file.slice(b.start, b.start + b.size).arrayBuffer())
      break
    }
    if (b.type === 'mdat') break // mdat 在 moov 前 → moov 在文件尾
  }
  if (!moov) moov = await readMoovFromTail(file)

  // ---- 2. 解析视频轨 ----
  const track = parseMoovVideoTrack(moov)
  if (!track) throw new Error('未找到视频轨（可能不是标准 MP4）')
  if (track.unsupported) throw new Error(track.unsupported)

  // ---- 3. 选关键帧样本并按需读出 ----
  const keyframeIndex = pickKeyframeIndex(track, atSeconds)
  const offset = sampleFileOffset(track, keyframeIndex)
  const size = sampleSize(track, keyframeIndex)
  if (offset < 0 || size <= 0 || offset + size > file.size) throw new Error('关键帧样本定位失败（样本表异常）')
  const sampleBuffer = await file.slice(offset, offset + size).arrayBuffer()

  return {
    codec: track.codec,
    description: track.description,
    width: track.width,
    height: track.height,
    timestampUs: Math.round((track.pts[keyframeIndex] / track.timescale) * 1e6),
    keyframeIndex,
    keyframeSec: track.pts[keyframeIndex] / track.timescale,
    sampleBuffer,
  }
}

/** moov 在文件尾（非 faststart，ffmpeg 默认输出即如此）：从尾部往回找 'moov' 特征并解析校验 */
async function readMoovFromTail(file) {
  const tailLen = Math.min(file.size, 16 * 1024 * 1024)
  const tailStart = file.size - tailLen
  const tail = new Uint8Array(await file.slice(tailStart, file.size).arrayBuffer())
  const isMoov = (i) => tail[i] === 0x6d && tail[i + 1] === 0x6f && tail[i + 2] === 0x6f && tail[i + 3] === 0x76

  // 第一遍（严格）：moov 恰好顶到文件末尾——ffmpeg「ftyp+mdat+moov」布局的标准形态；
  // 第二遍（宽松）：只要尺寸合理就试读解析（防 moov 后还垫了 free 等 box），限制尝试次数防误匹配开销
  let looseTries = 0
  for (const strict of [true, false]) {
    for (let i = tail.length - 4; i >= 4; i--) {
      if (!isMoov(i)) continue
      const boxStart = tailStart + i - 4
      const moovSize = u32At(tail, i - 4)
      if (moovSize < 16 || moovSize > 64 * 1024 * 1024) continue
      if (boxStart < 0 || boxStart + moovSize > file.size) continue
      if (strict && boxStart + moovSize !== file.size) continue
      if (!strict) {
        if (moovSize > 16 * 1024 * 1024 || looseTries >= 5) continue
        looseTries++
      }
      const cand = new Uint8Array(await file.slice(boxStart, boxStart + moovSize).arrayBuffer())
      if (parseMoovVideoTrack(cand)) return cand
    }
  }
  return null
}
