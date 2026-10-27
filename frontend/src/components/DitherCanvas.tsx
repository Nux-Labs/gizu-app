import { useEffect, useRef } from 'react'
import { ditherCells, type ChartPoint } from './dither'

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * Dithered pixel fill under a chart line (Kurage mosaic / portfolio DitherGrowthChart).
 * `points` and `focusX` are in viewBox units (`viewW` wide); the canvas fills its parent.
 */
export default function DitherCanvas({
  points,
  viewW,
  height,
  from,
  to,
  cell = 4,
  focusX = null,
  ground = false,
}: {
  points: ChartPoint[]
  viewW: number
  height: number
  from: string
  to: string
  cell?: number
  focusX?: number | null
  ground?: boolean
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const draw = () => {
      const width = Math.max(1, Math.round(canvas.getBoundingClientRect().width))
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      if (ground) {
        ctx.fillStyle = 'rgba(255,255,255,0.025)'
        for (let x = 0; x < width; x += cell)
          for (let y = 0; y < height; y += cell) ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2)
      }
      const k = width / viewW
      const scaled = points.map((p) => ({ x: p.x * k, y: p.y }))
      const a = rgb(from),
        b = rgb(to)
      for (const c of ditherCells(scaled, width, height, cell, focusX === null ? null : focusX * k)) {
        const col = a.map((v, i) => Math.round(v + (b[i] - v) * c.t)).join(',')
        const inset = (cell - c.size) / 2
        ctx.fillStyle = `rgba(${col},${c.alpha.toFixed(2)})`
        ctx.fillRect(c.x + inset, c.y + inset, c.size, c.size)
      }
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [points, viewW, height, from, to, cell, focusX, ground])

  return <canvas ref={ref} aria-hidden className="absolute inset-0 block w-full" style={{ height }} />
}
