import { RotateCw, TriangleAlert } from 'lucide-react'

/** Failed load with a plain message and a retry, instead of a silent caption. */
export default function LoadError({
  message,
  onRetry,
  className = '',
}: {
  message: string
  onRetry: () => void
  className?: string
}) {
  return (
    <div role="alert" className={`flex flex-col items-center gap-3 py-10 text-center ${className}`}>
      <span className="flex items-center gap-2 text-[14px] text-[#c9d0db]">
        <TriangleAlert size={16} className="text-rose-300" />
        {message}. Check your connection and try again.
      </span>
      <button
        onClick={onRetry}
        className="glass-soft flex h-10 items-center gap-2 rounded-xl px-4 text-[13px] text-white transition-colors hover:border-white/20"
      >
        <RotateCw size={14} /> Try again
      </button>
    </div>
  )
}
