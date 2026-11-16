import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, Check, LoaderCircle, X } from 'lucide-react'
import {
  requestEarlyAccess,
  type AccessPlatform,
  type AccessRequest
} from '../services/earlyAccess'
import { setScrollPaused } from '../smoothScroll'
import { usePresence, useReducedMotion } from 'framer-motion'

export default function EarlyAccessDialog({
  request,
  onClose
}: {
  request: AccessRequest
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const submission = useRef<AbortController | null>(null)
  const [email, setEmail] = useState('')
  const [platform, setPlatform] = useState<AccessPlatform>(request.platform)
  const [consent, setConsent] = useState(false)
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [present, safeToRemove] = usePresence()
  const reduce = useReducedMotion()
  useEffect(() => {
    if (present) return
    submission.current?.abort()
    const timer = window.setTimeout(() => safeToRemove?.(), reduce ? 0 : 220)
    return () => window.clearTimeout(timer)
  }, [present, reduce, safeToRemove])

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    setScrollPaused(true)
    return () => {
      submission.current?.abort()
      dialog.current?.close()
      setScrollPaused(false)
      trigger?.focus({ preventScroll: true })
    }
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submission.current) return
    const controller = new AbortController()
    submission.current = controller
    setPending(true)
    setError('')
    try {
      await requestEarlyAccess(
        { email, platform, consent, source: request.source },
        {
          endpoint: import.meta.env.VITE_EARLY_ACCESS_ENDPOINT,
          publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
        },
        controller.signal
      )
      if (!controller.signal.aborted) setSent(true)
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'We could not save your email. Please try again.'
        )
    } finally {
      if (!controller.signal.aborted) setPending(false)
      if (submission.current === controller) submission.current = null
    }
  }

  return (
    <dialog
      ref={dialog}
      data-lenis-prevent
      data-closing={!present || undefined}
      className="early-access-dialog"
      aria-labelledby="access-title"
      aria-describedby="access-description"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="relative p-6 sm:p-9">
        <button
          type="button"
          className="access-close"
          aria-label="Close early access"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <img src="/gizulogo.svg" alt="Gizu" className="mb-8 h-9 w-auto" />
        <h2
          id="access-title"
          className="pr-8 text-[32px] font-medium leading-tight tracking-[-0.04em]"
        >
          {sent ? 'You are on the list.' : 'Your invitation starts here.'}
        </h2>
        <p
          id="access-description"
          className="mt-3 text-[15px] leading-relaxed text-white/50"
        >
          {sent
            ? 'We will email you when access is available for your platform.'
            : 'Leave your email and be among the first to try Gizu.'}
        </p>
        {sent ? (
          <div className="mt-8">
            <div
              className="mb-7 flex items-center gap-3 text-neon"
              role="status"
            >
              <Check size={20} />
              Invitation requested
            </div>
            <button
              type="button"
              onClick={onClose}
              className="early-access-button w-full justify-center"
            >
              Back to Gizu
              <ArrowRight size={17} />
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-8 space-y-6">
            <div>
              <label htmlFor="access-email" className="text-sm font-medium">
                Email address
              </label>
              <input
                autoFocus
                required
                type="email"
                name="email"
                id="access-email"
                autoComplete="email"
                maxLength={254}
                placeholder="you@example.com"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value)
                  setError('')
                }}
                disabled={pending}
                aria-invalid={error.includes('valid email')}
                aria-describedby={error ? 'access-error' : undefined}
                className="access-input mt-2"
              />
            </div>
            <fieldset disabled={pending}>
              <legend className="mb-3 text-sm font-medium">
                Where will you use Gizu?
              </legend>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ['ios', 'iOS'],
                    ['android', 'Android'],
                    ['both', 'Both']
                  ] as const
                ).map(([value, label]) => (
                  <label
                    key={value}
                    className={`access-platform ${platform === value ? 'is-selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="platform"
                      value={value}
                      checked={platform === value}
                      onChange={() => setPlatform(value)}
                      className="sr-only"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="flex cursor-pointer items-start gap-3 text-[13px] leading-relaxed text-white/50">
              <input
                type="checkbox"
                required
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
                disabled={pending}
                className="mt-0.5 h-5 w-5 shrink-0 accent-[#7ce8f2]"
              />
              <span>
                Email me my invitation and Gizu access updates. I can
                unsubscribe anytime.
              </span>
            </label>
            {error && (
              <p
                id="access-error"
                role="alert"
                className="text-sm leading-relaxed text-[#fca5a5]"
              >
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={pending}
              className="early-access-button w-full justify-between disabled:cursor-wait disabled:opacity-60"
            >
              {pending ? 'Requesting invitation' : 'Join the early access list'}
              {pending ? (
                <LoaderCircle
                  size={18}
                  className="animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <ArrowRight size={18} aria-hidden="true" />
              )}
            </button>
          </form>
        )}
      </div>
    </dialog>
  )
}
