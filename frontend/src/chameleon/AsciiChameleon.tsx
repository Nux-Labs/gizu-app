import { useEffect, useRef } from 'react'
import { useReducedMotion } from 'framer-motion'
import { createStyler, frame, type Layout } from './field'

const FONT = '"Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace'
const DUST = ['.', '.', '.', '-', '-', "'", ',', '·']
type Dust = { x: number; y: number; vx: number; vy: number; seed: number; glyph: string; color: string }

/**
 * Gizu's mascot as a live ASCII mosaic: the Kurage jellyfish canvas engine re-rigged as a
 * chameleon on a branch. Glyphs on tinted tiles, drifting dust and a faint cell grid.
 * Pauses while the tab is hidden; reduced motion draws one still frame.
 */
export default function AsciiChameleon({
  anchorX = 0.5,
  anchorY = 0.45,
  size = 0.2,
  grid = true,
  className = '',
}: {
  anchorX?: number
  anchorY?: number
  /** Body unit as a fraction of the canvas width (capped by height). */
  size?: number
  grid?: boolean
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const reduce = useReducedMotion()

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const styler = createStyler()
    let time = 4
    let dust: Dust[] = []
    let layout: Layout | null = null
    let fs = 11
    let raf = 0
    let last = 0

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cw = width < 600 ? 8 : width < 1100 ? 9 : 10
      const ch = Math.round(cw * 1.5)
      fs = Math.round(ch * 0.74)
      layout = { width, height, cw, ch, anchorX, anchorY, scale: Math.min(width * size, height * 0.32) }
      dust = Array.from({ length: Math.round((width / cw) * (height / ch) / 80) }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vy: 3 + Math.random() * 8,
        vx: (Math.random() - 0.5) * 3,
        seed: Math.random() * 6.28,
        glyph: DUST[(Math.random() * DUST.length) | 0],
        color: `rgba(150,172,205,${(0.14 + Math.random() * 0.3).toFixed(3)})`,
      }))
    }

    const render = () => {
      if (!layout) return
      const { width, height, cw, ch } = layout
      ctx.clearRect(0, 0, width, height)
      if (grid) {
        ctx.fillStyle = 'rgba(255,255,255,0.03)'
        for (let x = cw; x < width; x += cw) ctx.fillRect(x, 0, 1, height)
        for (let y = ch; y < height; y += ch) ctx.fillRect(0, y, width, 1)
      }
      ctx.font = `500 ${fs}px ${FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (const d of dust) {
        ctx.fillStyle = d.color
        ctx.fillText(d.glyph, Math.floor(d.x / cw) * cw + cw / 2, Math.floor(d.y / ch) * ch + ch / 2 + 0.5)
      }
      for (const cell of frame(layout, time, styler)) {
        if (cell.tile) {
          ctx.fillStyle = cell.tile
          ctx.fillRect(cell.x + 1, cell.y + 1, cw - 2, ch - 2)
        }
        ctx.fillStyle = cell.color
        ctx.fillText(cell.glyph, cell.x + cw / 2, cell.y + ch / 2 + 0.5)
      }
    }

    const step = (dt: number) => {
      time += dt
      if (!layout) return
      for (const d of dust) {
        d.y += d.vy * dt
        d.x += (d.vx + Math.sin(time * 0.3 + d.seed) * 2) * dt
        if (d.y > layout.height + layout.ch) {
          d.y = -layout.ch
          d.x = Math.random() * layout.width
        }
      }
    }

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (document.hidden) return
      if (!last) last = now
      if (now - last < 1000 / 30) return
      step(Math.min(0.1, (now - last) / 1000))
      last = now
      render()
    }

    resize()
    render()
    const observer = new ResizeObserver(() => {
      resize()
      render()
    })
    observer.observe(canvas)
    // The ramp needs the monospace face; redraw once it has loaded.
    document.fonts?.load(`500 11px "Geist Mono"`).then(render).catch(() => undefined)
    if (!reduce) raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [anchorX, anchorY, size, grid, reduce])

  return <canvas ref={canvasRef} aria-hidden className={`block h-full w-full ${className}`} />
}
