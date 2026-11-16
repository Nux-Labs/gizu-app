import { useId } from 'react'

export default function DemoChart({
  compact = false,
  range = '1M'
}: {
  compact?: boolean
  range?: string
}) {
  const id = useId().replace(/:/g, '')
  const paths: Record<string, string> = {
    '1D': 'M0 78L18 82L36 74L54 79L72 61L90 65L108 53L126 58L144 42L162 46L180 30L198 38L216 22L234 29L252 14L280 20',
    '1W': 'M0 93L20 84L40 90L60 77L80 81L100 64L120 70L140 59L160 67L180 44L200 50L220 31L240 38L260 20L280 16',
    '1M': 'M0 98L16 91L32 96L48 84L64 86L80 65L96 75L112 61L128 67L144 50L160 54L176 37L192 46L208 31L224 38L240 17L256 24L280 10',
    '1Y': 'M0 105L20 99L40 94L60 98L80 79L100 84L120 69L140 74L160 54L180 59L200 40L220 48L240 26L260 33L280 8'
  }
  const path = paths[range] ?? paths['1M']
  return (
    <svg
      className={`demo-chart ${compact ? 'is-compact' : ''}`}
      viewBox="0 0 280 120"
      preserveAspectRatio="none"
      aria-label="Illustrative demo chart"
      role="img"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#7ce8f2" stopOpacity=".15" />
          <stop offset="1" stopColor="#7ce8f2" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M0 38H280M0 78H280M0 118H280" stroke="#ffffff08" fill="none" />
      <path d={`${path}L280 120H0Z`} fill={`url(#${id})`} />
      <path
        d={path}
        stroke="#7ce8f2"
        strokeWidth="1.5"
        fill="none"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  )
}
