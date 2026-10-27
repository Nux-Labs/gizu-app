import { useId, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import DitherCanvas from './DitherCanvas'

type Props = {
  series: number[]
  height?: number
  up?: boolean
  interactive?: boolean
}

const W = 320

// ponytail: catmull-rom -> kubik bezier, tek gecis
const smooth = (pts: { x: number; y: number }[]) =>
  pts.reduce((d, p, i) => {
    if (i === 0) return `M${p.x.toFixed(2)},${p.y.toFixed(2)}`
    const p0 = pts[i - 2] ?? pts[i - 1]
    const p1 = pts[i - 1]
    const p3 = pts[i + 1] ?? p
    const c1x = p1.x + (p.x - p0.x) / 6
    const c1y = p1.y + (p.y - p0.y) / 6
    const c2x = p.x - (p3.x - p1.x) / 6
    const c2y = p.y - (p3.y - p1.y) / 6
    return `${d} C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p.x.toFixed(2)},${p.y.toFixed(2)}`
  }, '')

export default function Chart({ series, height = 160, up = true, interactive = true }: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const uid = useId().replace(/:/g, '')
  const ref = useRef<SVGSVGElement>(null)

  const { line, points, min, max } = useMemo(() => {
    const min = Math.min(...series)
    const max = Math.max(...series)
    const span = max - min || 1
    const pts = series.map((v, i) => ({
      x: (i / (series.length - 1)) * W,
      y: height - ((v - min) / span) * (height - 18) - 9,
      v,
    }))
    return { line: smooth(pts), points: pts, min, max }
  }, [series, height])

  // Kurage ramp: cyan → violet when up, sell → rose when down.
  const color = up ? '#7ce8f2' : '#c4576a'
  const colorTo = up ? '#b9a6ff' : '#fb7185'
  const active = hover === null ? points[points.length - 1] : points[hover]
  const reveal = {
    initial: { clipPath: 'inset(0 100% 0 0)' },
    animate: { clipPath: 'inset(0 0% 0 0)' },
    transition: { duration: 1, ease: 'easeOut' },
  } as const

  const onMove = (e: React.PointerEvent) => {
    if (!interactive || !ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    const idx = Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))))
    setHover(idx)
  }

  return (
    <div className="relative select-none">
      <motion.div {...reveal} className="pointer-events-none absolute inset-x-0 top-0" style={{ height }}>
        <DitherCanvas
          points={points}
          viewW={W}
          height={height}
          from={color}
          to={colorTo}
          focusX={hover === null ? null : points[hover].x}
          ground
        />
      </motion.div>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        className="block touch-none overflow-visible"
      >
        <defs>
          <linearGradient id={`stroke-${uid}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={color} />
            <stop offset="100%" stopColor={colorTo} />
          </linearGradient>
        </defs>

        {[0.25, 0.5, 0.75].map((g) => (
          <line
            key={g}
            x1="0"
            x2={W}
            y1={height * g}
            y2={height * g}
            stroke="rgba(255,255,255,0.06)"
            strokeDasharray="2 6"
          />
        ))}

        <motion.g {...reveal}>
          <path
            d={line}
            fill="none"
            stroke={`url(#stroke-${uid})`}
            strokeOpacity="0.2"
            strokeWidth="8"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={line}
            fill="none"
            stroke={`url(#stroke-${uid})`}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </motion.g>

        {active && (
          <>
            <line
              x1={active.x}
              x2={active.x}
              y1={0}
              y2={height}
              stroke="rgba(255,255,255,0.22)"
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>

      {active && (
        <span
          className="pointer-events-none absolute h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: `${(active.x / W) * 100}%`,
            top: `${(active.y / height) * 100}%`,
            background: colorTo,
            boxShadow: `0 0 0 4px ${colorTo}26, 0 0 14px ${colorTo}`,
          }}
        >
          {/* live point heartbeat */}
          <span
            className="absolute inset-0 animate-ping rounded-full motion-reduce:hidden"
            style={{ background: colorTo, opacity: 0.45 }}
          />
        </span>
      )}

      <div className="pointer-events-none absolute inset-x-0 -top-1 flex justify-between font-mono text-[10px] uppercase tracking-widest text-white/30">
        <span>{min.toFixed(2)}</span>
        <span>{max.toFixed(2)}</span>
      </div>
    </div>
  )
}
