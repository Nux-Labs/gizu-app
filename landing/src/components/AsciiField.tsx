import { useEffect, useRef } from 'react'
import { useReducedMotion } from 'framer-motion'

// ASCII wave field, ported from mimir/HeroAscii and tuned for Gizu.
// Cached glyph sprites, a bounded grid and precomputed field geometry keep
// the full screen animation away from the text rasterizer on every frame.
const BASE: [number, number, number] = [170, 186, 210]
const PEAK: [number, number, number] = [124, 232, 242]
const LEVELS = 7
const CHARS = ' .:-=+*#%@'

const SIN_N = 2048
const SIN_MASK = SIN_N - 1
const SIN_SCALE = SIN_N / (Math.PI * 2)
const SIN = new Float32Array(SIN_N)
for (let i = 0; i < SIN_N; i++) SIN[i] = Math.sin((i / SIN_N) * Math.PI * 2)

type Props = {
  className?: string
  /** smaller means a denser grid */
  fontSize?: number
  speed?: number
  opacity?: number
  /** how far the pointer ripple reaches, 0 disables it */
  pointer?: number
  paused?: boolean
}

export default function AsciiField({
  className = '',
  fontSize = 13,
  speed = 0.55,
  opacity = 1,
  pointer = 0.4,
  paused = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const reduce = useReducedMotion()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    // Rasterize glyphs once, then copy small sprites instead of shaping text
    // thousands of times every frame. Keep the grid bounded on wide screens.
    const atlas = document.createElement('canvas')
    const atlasCtx = atlas.getContext('2d')
    if (!atlasCtx) return
    let cellW = fontSize * 0.6
    let cellH = fontSize
    let spriteW = 1
    let spriteH = 1
    let image: ImageData
    let pixels: Uint32Array
    let glyphRows: Uint32Array[][] = []
    let previousGlyphs = new Uint8Array(0)

    // The palette and every glyph row are cached until the canvas resizes.
    const palette = Array.from({ length: LEVELS }, (_, i) => {
      const t = i / (LEVELS - 1)
      const mix = Math.max(0, t - 0.45) * 1.9
      const r = Math.round(BASE[0] * (1 - mix) + PEAK[0] * mix)
      const g = Math.round(BASE[1] * (1 - mix) + PEAK[1] * mix)
      const b = Math.round(BASE[2] * (1 - mix) + PEAK[2] * mix)
      const a = (0.08 + t * 0.55) * opacity
      return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`
    })

    let W = 0
    let H = 0
    let cols = 0
    let rows = 0
    let aspect = 1

    // per column terms, rebuilt only on resize
    let xNorm = new Float32Array(0)
    let cx2 = new Float32Array(0)
    let sinX = new Float32Array(0)
    let cosX = new Float32Array(0)
    let distances = new Float32Array(0)
    let rowSin = new Float32Array(0)
    let rowCos = new Float32Array(0)

    // the canvas sits at the top of the page, so its box follows scroll
    let baseTop = 0
    let left = 0
    let top = 0

    const measure = () => {
      const rect = canvas.getBoundingClientRect()
      left = rect.left
      baseTop = rect.top + window.scrollY
      top = rect.top
    }

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      W = rect.width
      H = rect.height
      cellH = Math.max(fontSize, W / 100)
      cellW = cellH * 0.6
      cols = Math.ceil(W / cellW)
      rows = Math.ceil(H / cellH)
      aspect = cols / Math.max(rows, 1)

      spriteW = Math.ceil(cellW)
      spriteH = Math.ceil(cellH)
      canvas.width = cols * spriteW
      canvas.height = rows * spriteH
      image = ctx.createImageData(canvas.width, canvas.height)
      pixels = new Uint32Array(image.data.buffer)
      atlas.width = spriteW * CHARS.length
      atlas.height = spriteH * LEVELS
      atlasCtx.font = `${cellH}px ui-monospace, SFMono-Regular, Menlo, monospace`
      atlasCtx.textBaseline = 'top'
      for (let level = 0; level < LEVELS; level++) {
        atlasCtx.fillStyle = palette[level]
        for (let ch = 1; ch < CHARS.length; ch++) atlasCtx.fillText(CHARS[ch], ch * spriteW, level * spriteH)
      }
      const atlasPixels = atlasCtx.getImageData(0, 0, atlas.width, atlas.height)
      glyphRows = Array.from({ length: LEVELS * CHARS.length }, (_, index) => {
        const level = Math.floor(index / CHARS.length)
        const char = index % CHARS.length
        return Array.from({ length: spriteH }, (_, row) => new Uint32Array(atlasPixels.data.buffer, ((level * spriteH + row) * atlas.width + char * spriteW) * 4, spriteW))
      })
      previousGlyphs = new Uint8Array(cols * rows).fill(255)

      xNorm = new Float32Array(cols)
      cx2 = new Float32Array(cols)
      sinX = new Float32Array(cols)
      cosX = new Float32Array(cols)
      distances = new Float32Array(cols * rows)
      rowSin = new Float32Array(rows)
      rowCos = new Float32Array(rows)
      for (let x = 0; x < cols; x++) {
        const n = x / cols
        const cx = n - 0.5
        xNorm[x] = n
        cx2[x] = cx * cx
        sinX[x] = Math.sin(x * 0.28)
        cosX[x] = Math.cos(x * 0.28)
      }
      for (let y = 0; y < rows; y++) {
        rowSin[y] = Math.sin(y * 0.32)
        rowCos[y] = Math.cos(y * 0.32)
        for (let x = 0; x < cols; x++) distances[y * cols + x] = Math.sqrt(cx2[x] + (y / rows - 0.5) ** 2)
      }

      measure()
    }

    resize()

    let resizeTimer = 0
    const onResize = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        resize()
        if (!running) draw(performance.now())
      }, 120)
    }
    const onScroll = () => {
      top = baseTop - window.scrollY
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, { passive: true })

    const target = { x: 0.5, y: 0.5, on: 0 }
    const cur = { x: 0.5, y: 0.5, on: 0 }

    // no layout reads here, the box is cached above
    const onMove = (e: PointerEvent) => {
      if (!W || !H) return
      target.x = (e.clientX - left) / W
      target.y = (e.clientY - top) / H
      target.on = 1
    }
    const onLeave = () => {
      target.on = 0
    }

    if (pointer > 0) {
      window.addEventListener('pointermove', onMove, { passive: true })
      window.addEventListener('pointerleave', onLeave)
    }

    let frame = 0
    let raf = 0
    let running = !reduce && !paused
    let last = 0
    let elapsed = 0
    const step = 1000 / 60
    const reach2 = pointer * pointer

    const draw = (now: number) => {
      if (running) raf = requestAnimationFrame(draw)
      const delta = last ? Math.min(now - last, 64) : step
      if (last && now - last < step - 1) return
      last = now
      elapsed += delta
      frame = elapsed / (1000 / 30) * speed

      cur.x += (target.x - cur.x) * 0.1
      cur.y += (target.y - cur.y) * 0.1
      cur.on += (target.on - cur.on) * 0.07

      const t = frame * 0.03
      const rippleT = frame * 0.1
      const live = cur.on > 0.02

      // the noise term is sin(x·a + t1)·cos(y·b + t2), expanded so the per cell
      // work is multiplication only
      const nT1 = frame * 0.012
      const nT2 = frame * 0.02
      const s1 = Math.sin(nT1)
      const c1 = Math.cos(nT1)
      const s2 = Math.sin(nT2)
      const c2 = Math.cos(nT2)

      for (let y = 0; y < rows; y++) {
        const py = y / rows - cur.y
        const py2 = py * py
        const sy = rowSin[y]
        const cyc = rowCos[y]
        const noiseY = cyc * c2 - sy * s2

        for (let x = 0; x < cols; x++) {
          const dist = distances[y * cols + x]
          const wave = SIN[(((dist * 14 - t) * SIN_SCALE) | 0) & SIN_MASK] * 0.5 + 0.5
          const noise = (sinX[x] * c1 + cosX[x] * s1) * noiseY

          let ripple = 0
          if (live) {
            const dx = (xNorm[x] - cur.x) * aspect
            const d2 = dx * dx + py2
            if (d2 < reach2) {
              const pd = Math.sqrt(d2)
              const falloff = 1 - pd / pointer
              ripple =
                SIN[(((pd * 26 - rippleT) * SIN_SCALE) | 0) & SIN_MASK] *
                falloff *
                falloff *
                cur.on
            }
          }

          const val = wave * 0.62 + noise * 0.24 + ripple * 0.7
          const clamped = val < 0 ? 0 : val > 1 ? 1 : val
          const ch = (clamped * (CHARS.length - 1)) | 0
          const level = Math.round(clamped * (LEVELS - 1))
          const glyphIndex = ch && level ? level * CHARS.length + ch : 0
          const cellIndex = y * cols + x
          if (previousGlyphs[cellIndex] !== glyphIndex) {
            previousGlyphs[cellIndex] = glyphIndex
            const glyph = glyphRows[glyphIndex]
            const start = y * spriteH * canvas.width + x * spriteW
            for (let row = 0; row < spriteH; row++) pixels.set(glyph[row], start + row * canvas.width)
          }
        }
      }
      // One canvas upload per frame; no per-cell drawing or text calls.
      ctx.putImageData(image, 0, 0)
    }

    draw(performance.now())

    // Decoration stops off screen and in background tabs, without catching up.
    let inView = true
    const sync = () => {
      running = inView && !document.hidden && !reduce && !paused
      last = 0
      if (running && !raf) raf = requestAnimationFrame(draw)
      if (!running && raf) { cancelAnimationFrame(raf); raf = 0 }
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        inView = entry.isIntersecting
        sync()
      },
      { threshold: 0 },
    )
    io.observe(canvas)
    document.addEventListener('visibilitychange', sync)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      io.disconnect()
      document.removeEventListener('visibilitychange', sync)
      window.clearTimeout(resizeTimer)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerleave', onLeave)
    }
  }, [fontSize, speed, opacity, pointer, reduce, paused])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`pointer-events-none h-full w-full ${className}`}
    />
  )
}
