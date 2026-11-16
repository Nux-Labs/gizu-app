import { useEffect, useRef, useState, type FormEvent } from 'react'
import { motion } from 'framer-motion'
import { X, Check } from 'lucide-react'
import Scramble from './Scramble'
import { requestInvitation } from '../earlyAccess'
import { API_URL } from '../apiUrl'

const AMOUNTS = [
  'Under $500',
  '$500 to $2,000',
  '$2,000 to $10,000',
  '$10,000 to $50,000',
  '$50,000+',
  'Just exploring',
]

const PLATFORMS = ['Aave', 'Morpho', 'Pendle', 'Yearn', 'Binance or Coinbase', 'New to DeFi']

export default function RequestAccess({
  onClose,
  variant = 'sheet',
  returnFocusTo,
}: {
  onClose: () => void
  variant?: 'sheet' | 'modal'
  returnFocusTo: HTMLButtonElement | null
}) {
  const modal = variant === 'modal'
  const [email, setEmail] = useState('')
  const [amount, setAmount] = useState('')
  const [platforms, setPlatforms] = useState<string[]>([])
  const [other, setOther] = useState('')
  const [sent, setSent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    return () => {
      dialog.close()
      returnFocusTo?.focus()
    }
  }, [returnFocusTo])

  const toggle = (p: string) =>
    setPlatforms((list) => (list.includes(p) ? list.filter((x) => x !== p) : [...list, p]))

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      await requestInvitation({
        email,
        ...(amount ? { investmentRange: amount } : {}),
        ...(platforms.length ? { platforms } : {}),
        ...(other.trim() ? { otherPlatform: other.trim() } : {}),
      }, API_URL)
      setSent(true)
    } catch (err) {
      setError(err instanceof Error && !(err instanceof TypeError) && err.name !== 'TimeoutError'
        ? err.message : 'We couldn’t save your email. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="request-access-title"
      aria-describedby="request-access-description"
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
      className={`max-h-[90dvh] border-0 bg-transparent p-0 text-[#dfe8e3] backdrop:bg-ink/80 backdrop:backdrop-blur-md ${
        modal ? 'm-auto w-[calc(100%_-_2rem)] max-w-[520px]' : 'm-0 mt-auto w-full max-w-none'
      }`}
    >
      <motion.form
        onSubmit={submit}
        initial={modal ? { y: 24, opacity: 0, scale: 0.98 } : { y: '100%' }}
        animate={modal ? { y: 0, opacity: 1, scale: 1 } : { y: 0 }}
        exit={modal ? { y: 24, opacity: 0, scale: 0.98 } : { y: '100%' }}
        transition={{ type: 'spring', stiffness: 250, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className={`glass relative flex max-h-[88dvh] w-full flex-col overflow-hidden ${
          modal ? 'max-w-[520px] rounded-[32px] p-8' : 'rounded-t-[36px] px-5 pb-8 pt-5'
        }`}
      >
        {!sent && <>
        <div className="flex shrink-0 items-start justify-between">
          <div>
            <h2 id="request-access-title" className="text-[24px] font-medium tracking-tight">Request early access</h2>
            <p id="request-access-description" className="mt-2 max-w-[360px] text-[13px] leading-relaxed text-white/45">
              Help us shape Gizu. Answer three quick questions to join the early access list.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close request access"
            onClick={onClose}
            className="glass-soft flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white/70"
          >
            <X size={15} />
          </button>
        </div>

        <div className="mt-6 min-h-0 flex-1 space-y-7 overflow-y-auto pr-1">
          <section>
            <label htmlFor="request-access-email" className="text-[14px] font-medium">Where should we send your invitation?</label>
            <input
              id="request-access-email"
              name="email"
              autoComplete="email"
              required
              maxLength={254}
              disabled={submitting}
              aria-describedby={error ? 'request-access-error' : undefined}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              placeholder="Email address"
              className="glass-soft mt-3 h-13 w-full rounded-2xl px-5 py-4 text-[14px] caret-neon outline-none placeholder:text-white/40 focus-visible:ring-2 focus-visible:ring-neon"
            />
          </section>

          <section>
            <div className="text-[14px] font-medium">
              How much would you consider investing through Gizu?
            </div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-white/30">
              Select one, not a commitment
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {AMOUNTS.map((a) => (
                <button
                  type="button"
                  key={a}
                  aria-pressed={amount === a}
                  onClick={() => setAmount(a)}
                  className={`min-h-11 rounded-2xl px-4 py-3 text-left text-[13px] ${
                    amount === a ? 'bg-neon/10 text-neon' : 'glass-soft text-white/60'
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="text-[14px] font-medium">
              Which platforms do you use to invest or earn yield?
            </div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-white/30">
              Select all that apply
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {PLATFORMS.map((p) => (
                <button
                  type="button"
                  key={p}
                  aria-pressed={platforms.includes(p)}
                  onClick={() => toggle(p)}
                  className={`min-h-11 rounded-full px-4 py-2.5 text-[13px] ${
                    platforms.includes(p) ? 'bg-neon/10 text-neon' : 'glass-soft text-white/60'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
            <input
              aria-label="Other investment platform"
              maxLength={500}
              value={other}
              onChange={(e) => setOther(e.target.value)}
              placeholder="Other"
              className="glass-soft mt-3 w-full rounded-2xl px-5 py-3.5 text-[13px] caret-neon outline-none placeholder:text-white/40 focus-visible:ring-2 focus-visible:ring-neon"
            />
          </section>
        </div>

        {error && <p id="request-access-error" role="alert" className="mt-4 text-[13px] text-red-300">{error}</p>}
        <p className="mt-4 text-[11px] leading-relaxed text-white/40">We’ll use your email to contact you about Gizu access. Other answers are optional.</p>

        <button
          type="submit"
          disabled={submitting}
          className="neon-btn mt-4 flex h-15 w-full shrink-0 items-center justify-center rounded-3xl py-5 text-[15px] font-semibold disabled:cursor-wait disabled:opacity-60"
        >
          {submitting ? 'Saving…' : 'Request access'}
        </button>
        </>}

          {sent && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex min-h-0 flex-col items-center overflow-y-auto py-4"
              role="status"
            >
              <motion.div
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 220, damping: 18 }}
                className="glass flex h-20 w-20 items-center justify-center rounded-[28px]"
              >
                <Check size={38} strokeWidth={2.2} className="text-neon" />
              </motion.div>
              <h2 id="request-access-title" className="mt-7 font-mono text-[11px] uppercase tracking-[0.3em] text-neon/80">
                <Scramble text="you are on the list" />
              </h2>
              <p id="request-access-description" className="mt-4 max-w-[320px] px-4 text-center text-[14px] leading-relaxed text-white/60">We’ll email your invitation when access is ready.</p>
              <button type="button" autoFocus onClick={onClose} className="neon-btn mt-6 rounded-2xl px-8 py-3 text-[14px] font-semibold">Done</button>
            </motion.div>
          )}
      </motion.form>
    </dialog>
  )
}
