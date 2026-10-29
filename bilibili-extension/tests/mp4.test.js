// tests/mp4.test.js - MP4 关键帧定位纯函数单测（合成 MP4 字节流，无需真实视频文件）
// 样本表设计：
//   timescale=1000，4 个样本，pts=[0,500,1000,1500]ms，大小=[100,200,300,400]
//   关键帧（stss，1 基）：样本 1、3 → 0 基 0、2
//   chunk 布局：chunk1=样本0,1（起始于 mdat 数据区），chunk2=样本2,3（起始 +300）
import { describe, it, expect } from 'vitest'
import { locateKeyframeInMp4 } from '../src/content/core/mp4.js'

const u32b = (v) => Uint8Array.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff])
const u16b = (v) => Uint8Array.from([(v >> 8) & 0xff, v & 0xff])
const str4 = (s) => Uint8Array.from([0, 1, 2, 3].map((i) => s.charCodeAt(i)))

function makeBox(type, payload) {
  const out = new Uint8Array(8 + payload.length)
  out.set(u32b(out.length), 0)
  out.set(str4(type), 4)
  out.set(payload, 8)
  return out
}

function concat(...parts) {
  const len = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

function buildMp4({ moovAtEnd = false, noStss = false } = {}) {
  // mdat 数据区：四个样本各用固定字节模式填充
  const sampleData = new Uint8Array(1000)
  for (let i = 0; i < 100; i++) sampleData[i] = 0x11 // 样本0（关键帧，pts 0）
  for (let i = 100; i < 300; i++) sampleData[i] = 0x22 // 样本1
  for (let i = 300; i < 600; i++) sampleData[i] = 0x33 // 样本2（关键帧，pts 1s）
  for (let i = 600; i < 1000; i++) sampleData[i] = 0x44 // 样本3

  // avcC 载荷：profile=0x64 compat=0x00 level=0x28 → codec 'avc1.640028'
  const avcC = Uint8Array.from([
    1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x14, ...Array(20).fill(0xaa),
    0x01, 0x00, 0x08, ...Array(8).fill(0xbb),
  ])
  const visual = new Uint8Array(78) // VisualSampleEntry 固定字段，width/height 在第 24/26 字节
  visual.set(u16b(1920), 24)
  visual.set(u16b(1080), 26)

  const stsd = makeBox('stsd', concat(u32b(0), u32b(1), makeBox('avc1', concat(visual, makeBox('avcC', avcC)))))
  const stts = makeBox('stts', concat(u32b(0), u32b(2), u32b(3), u32b(500), u32b(1), u32b(1000)))
  const stss = makeBox('stss', concat(u32b(0), u32b(2), u32b(1), u32b(3)))
  const stsc = makeBox('stsc', concat(u32b(0), u32b(1), u32b(1), u32b(2), u32b(1)))
  const stsz = makeBox('stsz', concat(u32b(0), u32b(0), u32b(4), u32b(100), u32b(200), u32b(300), u32b(400)))
  const hdlr = makeBox('hdlr', concat(u32b(0), u32b(0), str4('vide'), new Uint8Array(12)))
  const mdhd = makeBox('mdhd', concat(u32b(0), u32b(0), u32b(0), u32b(1000), u32b(2000)))
  const ftyp = makeBox('ftyp', concat(str4('isom'), u32b(0x200), str4('isom')))

  // stco 的 chunk 偏移依赖 mdat 数据区的绝对位置：box 尺寸与字段值无关，两遍构建即可
  const buildMoov = (c0, c1) => {
    const stco = makeBox('stco', concat(u32b(0), u32b(2), u32b(c0), u32b(c1)))
    const stbl = makeBox('stbl', concat(stsd, stts, noStss ? new Uint8Array(0) : stss, stsc, stsz, stco))
    const minf = makeBox('minf', stbl)
    const mdia = makeBox('mdia', concat(hdlr, mdhd, minf))
    const trak = makeBox('trak', mdia)
    return makeBox('moov', trak)
  }

  let moov = buildMoov(0, 0)
  const mdat = makeBox('mdat', sampleData)
  const mdatDataStart = (moovAtEnd ? ftyp.length : ftyp.length + moov.length) + 8
  moov = buildMoov(mdatDataStart, mdatDataStart + 300)

  const bytes = moovAtEnd ? concat(ftyp, mdat, moov) : concat(ftyp, moov, mdat)
  return { blob: new Blob([bytes]), avcC }
}

describe('locateKeyframeInMp4 - faststart（moov 在文件头）', () => {
  it('定位 2s 处关键帧：命中样本 2（pts 1s，0x33 数据，大小 300）', async () => {
    const { blob, avcC } = buildMp4()
    const info = await locateKeyframeInMp4(blob, 2)
    expect(info.codec).toBe('avc1.640028')
    expect(info.width).toBe(1920)
    expect(info.height).toBe(1080)
    expect(info.keyframeIndex).toBe(2)
    expect(info.keyframeSec).toBe(1)
    expect(info.timestampUs).toBe(1000000)
    const u8 = new Uint8Array(info.sampleBuffer)
    expect(u8.length).toBe(300)
    expect(u8[0]).toBe(0x33)
    expect(u8[299]).toBe(0x33)
    expect(Array.from(info.description)).toEqual(Array.from(avcC))
  })
  it('目标时间早于第二个关键帧时取第一个关键帧（跨 chunk 定位）', async () => {
    const { blob } = buildMp4()
    const info = await locateKeyframeInMp4(blob, 0.3)
    expect(info.keyframeIndex).toBe(0)
    const u8 = new Uint8Array(info.sampleBuffer)
    expect(u8.length).toBe(100)
    expect(u8[0]).toBe(0x11)
  })
  it('目标时间超出视频时长时取最后一个关键帧', async () => {
    const { blob } = buildMp4()
    const info = await locateKeyframeInMp4(blob, 99)
    expect(info.keyframeIndex).toBe(2) // 关键帧只有 0 和 2
  })
})

describe('locateKeyframeInMp4 - moov 在文件尾（非 faststart，ffmpeg 默认布局）', () => {
  it('从文件尾回扫定位 moov，结果与 faststart 一致', async () => {
    const { blob } = buildMp4({ moovAtEnd: true })
    const info = await locateKeyframeInMp4(blob, 2)
    expect(info.codec).toBe('avc1.640028')
    expect(info.keyframeIndex).toBe(2)
    const u8 = new Uint8Array(info.sampleBuffer)
    expect(u8.length).toBe(300)
    expect(u8[0]).toBe(0x33)
  })
})

describe('locateKeyframeInMp4 - 无 stss（全部样本视为关键帧）', () => {
  it('取 pts 不超过目标时间的最后一个样本', async () => {
    const { blob } = buildMp4({ noStss: true })
    const info = await locateKeyframeInMp4(blob, 2)
    expect(info.keyframeIndex).toBe(3) // pts 1500ms 是 <=2s 的最后一个样本
    expect(info.timestampUs).toBe(1500000)
    const u8 = new Uint8Array(info.sampleBuffer)
    expect(u8.length).toBe(400)
    expect(u8[0]).toBe(0x44)
  })
})

describe('locateKeyframeInMp4 - 异常输入', () => {
  it('非 MP4 内容（无 moov）报错', async () => {
    const blob = new Blob([new Uint8Array(64).fill(0x00)])
    await expect(locateKeyframeInMp4(blob, 2)).rejects.toThrow()
  })
  it('文件过小报错', async () => {
    const blob = new Blob([new Uint8Array(8)])
    await expect(locateKeyframeInMp4(blob, 2)).rejects.toThrow('文件过小')
  })
})
