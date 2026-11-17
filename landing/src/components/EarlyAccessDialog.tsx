import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, Check, LoaderCircle, X } from 'lucide-react'
import {
  requestEarlyAccess,
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
  const platform = request.platform
  const platformName = platform === 'ios' ? 'iOS' : 'Android'
  const isInvite = Boolean(platform)
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
          endpoint: import.meta.env.VITE_EARLY_ACCESS_ENDPOINT?.trim() || (import.meta.env.DEV ? 'http://127.0.0.1:3000/v1/early-access' : 'https://api.gizu.io/v1/early-access')
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
          {sent ? (isInvite ? 'Invitation requested.' : 'You’re on the waitlist.') : (isInvite ? `Try Gizu on ${platformName}` : 'Join the Gizu waitlist')}
        </h2>
        <p
          id="access-description"
          className="mt-3 text-[15px] leading-relaxed text-white/50"
        >
          {sent
            ? (isInvite ? `We will email you when your ${platformName} invitation is available.` : 'We will email you when Gizu is ready for you.')
            : (isInvite ? `Leave your email to request a ${platformName} app invitation.` : 'Leave your email to hear when Gizu launches.')}
        </p>
        {sent ? (
          <div className="mt-8">
            <div
              className="mb-7 flex items-center gap-3 text-neon"
              role="status"
            >
              <Check size={20} />
              {isInvite ? 'Invitation requested' : 'Added to the waitlist'}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="early-access-button w-full justify-center"
            >
              <span>Back to Gizu</span>
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
                {isInvite ? 'Email me my app invitation and Gizu access updates.' : 'Email me Gizu launch and waitlist updates.'}
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
              <span>{pending ? (isInvite ? 'Requesting invitation' : 'Joining waitlist') : (isInvite ? 'Request app invitation' : 'Join waitlist')}</span>
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
