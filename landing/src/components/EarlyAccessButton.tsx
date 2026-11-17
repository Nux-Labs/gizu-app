import { ArrowUpRight } from 'lucide-react'

export default function EarlyAccessButton({
  onClick
}: {
  onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick} className="early-access-button">
      <span>Join waitlist</span>
      <ArrowUpRight size={18} aria-hidden="true" />
    </button>
  )
}
