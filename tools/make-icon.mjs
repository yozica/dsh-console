/**
 * 生成应用图标（build/icon.png，512×512）。
 *
 * 由两部分合成：
 *   - 底板：DeepSeek 蓝的圆角方块（用距离场画，自带抗锯齿）
 *   - 标记：**官方 DeepSeek 鲸鱼**（取自 @lobehub/icons-static-png 的白鲸版），
 *     白色压在蓝底上 —— 小到 16px 也读得清，这是应用图标最实际的约束
 *
 * 为什么这里手写 PNG 编解码：仓库不引图像库，而这件事只需要跑一次 ——
 * PNG 的编码就是"每行一个滤波字节 + zlib + CRC"，解码是"inflate + 反滤波"，
 * Node 自带的 zlib 足够。
 *
 * 依赖：`npm i -D @lobehub/icons-static-png @lobehub/icons-static-svg`
 * 用法：node tools/make-icon.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'build', 'icon.png')
const SIZE = 512

/** 白鲸（深色背景用的那版）：深底浅标记 */
const MARK = path.join(ROOT, 'node_modules', '@lobehub', 'icons-static-png', 'dark', 'deepseek.png')

// DeepSeek 的品牌蓝，顶亮底深一点（平面色显廉价）
const TOP = [93, 118, 255]
const BOTTOM = [61, 86, 232]

// ---------------------------------------------------------------- PNG 解码

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 6
  let bitDepth = 8
  const idat = []
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('不支持隔行扫描的 PNG')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (bitDepth !== 8) throw new Error(`只支持 8 位深，实际 ${bitDepth}`)
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const px = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = px.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = value & 0xff
    }
  }

  // 统一展开成 RGBA
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const s = i * channels
    const d = i * 4
    if (colorType === 6) {
      rgba[d] = px[s]
      rgba[d + 1] = px[s + 1]
      rgba[d + 2] = px[s + 2]
      rgba[d + 3] = px[s + 3]
    } else if (colorType === 2) {
      rgba[d] = px[s]
      rgba[d + 1] = px[s + 1]
      rgba[d + 2] = px[s + 2]
      rgba[d + 3] = 255
    } else if (colorType === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]
      rgba[d + 3] = 255
    } else {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]
      rgba[d + 3] = px[s + 1]
    }
  }
  return { width, height, rgba }
}

// ---------------------------------------------------------------- 绘制与合成

/** 有符号距离场：圆角矩形（负值在内部） */
function sdRoundRect(px, py, halfW, halfH, r) {
  const qx = Math.abs(px) - (halfW - r)
  const qy = Math.abs(py) - (halfH - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

/** 距离场 → 覆盖率（一个像素宽的软边） */
const cover = (d, soft = 1.2) => Math.min(1, Math.max(0, 0.5 - d / soft))

function render() {
  const mark = decodePng(fs.readFileSync(MARK))
  const out = new Uint8Array(SIZE * SIZE * 4)
  const c = SIZE / 2

  // 源图是铺满画布的，直接用会被切掉边角 —— 缩到 76% 再居中，
  // 留出四周留白（这也是应用图标的通行做法）。
  const markSize = SIZE * 0.76
  const offset = (SIZE - markSize) / 2
  const step = mark.width / markSize

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - c + 0.5
      const dy = y - c + 0.5
      const tile = cover(sdRoundRect(dx, dy, 232, 232, 108))

      // 底板：自上而下的轻微渐变 + 左上角一点高光
      const t = y / SIZE
      const light = Math.max(0, 1 - Math.hypot(dx + 150, dy + 170) / 420) * 0.18
      const bg = [0, 1, 2].map((i) =>
        Math.min(255, Math.round(TOP[i] * (1 - t) + BOTTOM[i] * t + 255 * light))
      )

      // 取源图对应区域的平均（带小数权重），既降采样又不产生锯齿
      let alpha = 0
      let weight = 0
      const acc = [0, 0, 0]
      const u0 = (x - offset) * step
      const v0 = (y - offset) * step
      const u1 = u0 + step
      const v1 = v0 + step
      const sx0 = Math.max(0, Math.floor(u0))
      const sy0 = Math.max(0, Math.floor(v0))
      const sx1 = Math.min(mark.width - 1, Math.ceil(u1) - 1)
      const sy1 = Math.min(mark.height - 1, Math.ceil(v1) - 1)
      for (let sy = sy0; sy <= sy1; sy++) {
        const wy = Math.min(sy + 1, v1) - Math.max(sy, v0)
        if (wy <= 0) continue
        for (let sx = sx0; sx <= sx1; sx++) {
          const wx = Math.min(sx + 1, u1) - Math.max(sx, u0)
          if (wx <= 0) continue
          const w = wx * wy
          const a = mark.rgba[(sy * mark.width + sx) * 4 + 3] / 255
          acc[0] += mark.rgba[(sy * mark.width + sx) * 4] * a * w
          acc[1] += mark.rgba[(sy * mark.width + sx) * 4 + 1] * a * w
          acc[2] += mark.rgba[(sy * mark.width + sx) * 4 + 2] * a * w
          alpha += a * w
          weight += w
        }
      }
      const coverAlpha = weight > 0 ? alpha / weight : 0
      const mix = (base, over, a) => base * (1 - a) + over * a
      const rgb = [0, 1, 2].map((i) => {
        const markColor = alpha > 0 ? acc[i] / alpha : 255
        return mix(bg[i], markColor, coverAlpha * tile)
      })

      const o = (y * SIZE + x) * 4
      out[o] = Math.round(rgb[0])
      out[o + 1] = Math.round(rgb[1])
      out[o + 2] = Math.round(rgb[2])
      out[o + 3] = Math.round(tile * 255)
    }
  }
  return out
}

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // 滤波类型 0（None）
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型 RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

if (!fs.existsSync(MARK)) {
  console.error(`找不到 DeepSeek 图标：${MARK}\n先跑 npm i -D @lobehub/icons-static-png`)
  process.exit(1)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, encodePng(render(), SIZE, SIZE))
console.log(`已生成 ${OUT}（${SIZE}×${SIZE}，标记取自 ${path.basename(MARK)}）`)
