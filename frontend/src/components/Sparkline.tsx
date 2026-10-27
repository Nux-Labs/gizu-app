import DitherCanvas from './DitherCanvas'

/** Card sparkline: cyan → violet line over a fine dithered fill (Kurage mosaic). */
export default function Sparkline({
  series,
  up,
  width = 60,
  height = 24,
  fluid = false,
  gradientId,
}: {
  series: number[]
  up: boolean
  width?: number
  height?: number
  fluid?: boolean
  gradientId?: string
}) {
  const min = Math.min(...series)
  const max = Math.max(...series)
  const span = max - min || 1
  const pts = series.map((v, i) => ({
    x: (i / (series.length - 1)) * width,
    y: height - ((v - min) / span) * (height - 4) - 2,
  }))
  const d = pts.reduce((acc, p, i) => {
    if (i === 0) return `M${p.x.toFixed(2)},${p.y.toFixed(2)}`
    const p0 = pts[i - 2] ?? pts[i - 1]
    const p1 = pts[i - 1]
    const p3 = pts[i + 1] ?? p
    const c1x = p1.x + (p.x - p0.x) / 6
    const c1y = p1.y + (p.y - p0.y) / 6
    const c2x = p.x - (p3.x - p1.x) / 6
    const c2y = p.y - (p3.y - p1.y) / 6
    return `${acc} C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p.x.toFixed(2)},${p.y.toFixed(2)}`
  }, '')
  const from = up ? '#7ce8f2' : '#c4576a'
  const to = up ? '#b9a6ff' : '#fb7185'
  const id = `${gradientId ?? `sp-w${width}-h${height}`}-${up ? 'up' : 'down'}`

  return (
    <div
      className={`relative ${fluid ? 'w-full' : 'shrink-0'}`}
      style={{ width: fluid ? undefined : width, height }}
    >
      <DitherCanvas points={pts} viewW={width} height={height} from={from} to={to} cell={3} />
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        className="relative block overflow-visible"
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
        </defs>
        <path
          d={d}
          fill="none"
          stroke={`url(#${id})`}
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  )
}
