import { useState, type CSSProperties, type ReactNode } from 'react'

/** One device frame for both the live demo and captured interface previews. */
export default function PhoneFrame({
  src,
  alt,
  className = '',
  style,
  children,
}: {
  src?: string
  alt: string
  className?: string
  style?: CSSProperties
  children?: ReactNode
}) {
  const [missing, setMissing] = useState(false)
  return (
    <div
      className={`relative aspect-[9/19.5] rounded-[46px] border border-white/15 bg-[#0b0f16] p-[10px] shadow-[0_40px_120px_-30px_rgba(124,232,242,0.35)] ${className}`}
      style={style}
    >
      <div className="relative h-full w-full overflow-hidden rounded-[36px] bg-ink">
        {children ?? (missing || !src ? (
          <div className="flex h-full w-full items-center justify-center">
            <img src="/gizulogo.svg" alt="" className="w-[28%] opacity-80" />
          </div>
        ) : (
          <img src={src} alt={alt} loading="lazy" width={780} height={1690} className="h-full w-full object-cover" onError={() => setMissing(true)} />
        ))}
        <div className="pointer-events-none absolute left-1/2 top-[1.6%] h-[4.5%] w-[32%] -translate-x-1/2 rounded-full bg-black" aria-hidden="true" />
      </div>
    </div>
  )
}
