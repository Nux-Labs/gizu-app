import { useEffect, useRef } from 'react'

// ASCII wave field, ported from mimir/HeroAscii and tuned for Gizu.
// Two things keep a full screen field cheap: drawing is batched into runs of
// cells that share a colour level, and the per cell trigonometry is replaced by
// a sine table plus per row and per column terms computed once per frame.
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
}

export default function AsciiField({
  className = '',
  fontSize = 13,
  speed = 0.55,
  opacity = 1,
  pointer = 0.4,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 1.25)
    const cellW = fontSize * 0.6

    // one colour per level, so fillStyle changes at most LEVELS times per row
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
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`
      ctx.textBaseline = 'top'
      cols = Math.ceil(W / cellW)
      rows = Math.ceil(H / fontSize)
      aspect = cols / Math.max(rows, 1)

      xNorm = new Float32Array(cols)
      cx2 = new Float32Array(cols)
      sinX = new Float32Array(cols)
      cosX = new Float32Array(cols)
      for (let x = 0; x < cols; x++) {
        const n = x / cols
        const cx = n - 0.5
        xNorm[x] = n
        cx2[x] = cx * cx
        sinX[x] = Math.sin(x * 0.28)
        cosX[x] = Math.cos(x * 0.28)
      }

      measure()
    }

    resize()

    let resizeTimer = 0
    const onResize = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(resize, 120)
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
    let running = true
    let last = 0
    const step = 1000 / 30
    const reach2 = pointer * pointer

    const draw = (now: number) => {
      if (running) raf = requestAnimationFrame(draw)
      if (now - last < step) return
      last = now

      cur.x += (target.x - cur.x) * 0.1
      cur.y += (target.y - cur.y) * 0.1
      cur.on += (target.on - cur.on) * 0.07

      ctx.clearRect(0, 0, W, H)
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
        const cy = y / rows - 0.5
        const cy2 = cy * cy
        const py = y / rows - cur.y
        const py2 = py * py
        const rowY = y * fontSize
        const sy = Math.sin(y * 0.32)
        const cyc = Math.cos(y * 0.32)
        const noiseY = cyc * c2 - sy * s2

        let run = ''
        let runLevel = -1
        let runStart = 0

        for (let x = 0; x < cols; x++) {
          const dist = Math.sqrt(cx2[x] + cy2)
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
          const ch = CHARS[(clamped * (CHARS.length - 1)) | 0]
          const level = ch === ' ' ? -1 : Math.round(clamped * (LEVELS - 1))

          if (level !== runLevel) {
            if (run && runLevel > 0) {
              ctx.fillStyle = palette[runLevel]
              ctx.fillText(run, runStart * cellW, rowY)
            }
            run = ''
            runStart = x
            runLevel = level
          }
          if (level >= 0) run += ch
        }

        if (run && runLevel > 0) {
          ctx.fillStyle = palette[runLevel]
          ctx.fillText(run, runStart * cellW, rowY)
        }
      }

      frame += speed
    }

    raf = requestAnimationFrame(draw)

    // decoration only, so it stops while off screen
    const io = new IntersectionObserver(
      ([entry]) => {
        running = entry.isIntersecting
        if (running && !raf) raf = requestAnimationFrame(draw)
        if (!running && raf) {
          cancelAnimationFrame(raf)
          raf = 0
        }
      },
      { threshold: 0 },
    )
    io.observe(canvas)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      io.disconnect()
      window.clearTimeout(resizeTimer)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerleave', onLeave)
    }
  }, [fontSize, speed, opacity, pointer])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`pointer-events-none h-full w-full ${className}`}
    />
  )
}
