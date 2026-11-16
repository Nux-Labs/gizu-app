import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowUpRight, Check, Smartphone, X } from 'lucide-react'
import { requestInvitation } from '../earlyAccess'
import { API_URL } from '../apiUrl'

const REPO = 'https://github.com/Nux-Labs/gizu-app'
const GUIDE = `${REPO}/blob/main/docs/app-guide/MOBILE_LOCAL_DEVELOPMENT.md`

export default function TestOnMobile({
  onClose,
  returnFocusTo,
}: {
  onClose: () => void
  returnFocusTo: HTMLButtonElement | null
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [registered, setRegistered] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      await requestInvitation({ email }, API_URL)
      setRegistered(true)
    } catch (err) {
      setError(err instanceof Error && !(err instanceof TypeError) && err.name !== 'TimeoutError'
        ? err.message : 'We couldn’t save your email. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    return () => {
      dialog.close()
      returnFocusTo?.focus()
    }
  }, [returnFocusTo])

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="test-mobile-title"
      aria-describedby="test-mobile-description"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-[560px] overflow-y-auto rounded-[28px] border border-white/10 bg-[#0b100d] p-0 text-[#dfe8e3] shadow-2xl backdrop:bg-ink/80 backdrop:backdrop-blur-md"
    >
      <div className="p-6 sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <h2 id="test-mobile-title" className="flex items-center gap-3 text-[24px] font-medium tracking-tight sm:text-[28px]">
            <Smartphone size={24} strokeWidth={1.7} className="shrink-0 text-neon" />
            Test On Mobile
          </h2>
          <button
            type="button"
            aria-label="Close mobile testing instructions"
            onClick={onClose}
            className="glass-soft flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neon"
          >
            <X size={18} />
          </button>
        </div>

        <p id="test-mobile-description" className="mt-2 text-[14px] leading-relaxed text-white/55">
          Leave your email for the supported iOS or Android testing experience.
          You can also build and test Gizu yourself.
        </p>

        <section className="mt-5" aria-labelledby="mobile-invitation-title">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="mobile-invitation-title" className="text-[16px] font-medium">Get a mobile invitation</h3>
            <span className="rounded-full bg-neon/10 px-2.5 py-1 text-[11px] font-medium text-neon">Recommended</span>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-white/55">
            Test with our supported app build and hosted services. Leave your email
            and we’ll send an invitation when access is ready.
          </p>
          {registered ? (
            <p role="status" className="mt-4 flex items-start gap-2 text-[14px] leading-relaxed text-neon">
              <Check size={18} className="mt-0.5 shrink-0" />
              You’re on the list. We’ll email your invitation when access is ready.
            </p>
          ) : (
            <form onSubmit={submit} className="mt-4">
              <label htmlFor="mobile-invitation-email" className="text-[13px] text-white/70">Email address</label>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                <input
                  id="mobile-invitation-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={email}
                  disabled={submitting}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  aria-describedby={error ? 'mobile-invitation-error' : undefined}
                  className="glass-soft min-w-0 flex-1 rounded-2xl px-4 py-3 text-[14px] caret-neon outline-none placeholder:text-white/30 focus-visible:ring-2 focus-visible:ring-neon"
                />
                <button type="submit" disabled={submitting} className="neon-btn rounded-2xl px-4 py-3 text-[14px] font-semibold disabled:cursor-wait disabled:opacity-60">
                  {submitting ? 'Saving…' : 'Send me an invitation'}
                </button>
              </div>
              {error && <p id="mobile-invitation-error" role="alert" className="mt-3 text-[13px] text-red-300">{error}</p>}
              <p className="mt-3 text-[11px] leading-relaxed text-white/40">We’ll use your email to contact you about Gizu mobile access.</p>
            </form>
          )}
        </section>

        <section className="mt-6 border-t border-white/10 pt-5" aria-labelledby="mobile-self-testing-title">
          <h3 id="mobile-self-testing-title" className="text-[16px] font-medium">Or test it yourself</h3>
          <p className="mt-2 text-[13px] leading-relaxed text-white/55">
            Building from source requires your own setup. A local backend and
            database run separately from our managed testing environment. Differences
            in configuration, app and API versions, connected services and device
            signing can affect available features, data and reliability. We can’t
            guarantee the same experience as an invited build.
          </p>

          <ol className="mt-5 space-y-4 text-[13px] leading-relaxed text-white/60">
            <li>
              <h4 className="text-[14px] font-medium text-white">01 / Get the code and check requirements</h4>
              <p className="mt-1">
                Clone the repository. The setup guide covers Node, Rust and the
                required iOS or Android tools, including device signing.
              </p>
            </li>
            <li>
              <h4 className="text-[14px] font-medium text-white">02 / Build and connect</h4>
              <p className="mt-1">
                Install dependencies, configure the backend and follow the platform
                build steps. Gizu requires a native build; Expo Go cannot run it.
              </p>
            </li>
            <li>
              <h4 className="text-[14px] font-medium text-white">03 / Check the mobile flow</h4>
              <p className="mt-1">
                Continue with a passkey, save and verify your encrypted backup, then
                check Home and Account. Keep the backup and original passkey for recovery.
              </p>
            </li>
          </ol>

          <div className="mt-5 flex flex-wrap gap-3">
            <a href={GUIDE} target="_blank" rel="noopener noreferrer" className="glass-soft inline-flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-[13px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-neon">
              Mobile setup guide <ArrowUpRight size={16} />
            </a>
            <a href={REPO} target="_blank" rel="noopener noreferrer" className="glass-soft inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-[13px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-neon">
              View repository <ArrowUpRight size={16} />
            </a>
          </div>
          <p className="mt-4 text-[11px] leading-relaxed text-white/45">
            Development builds can use real mainnet funds. Review the setup guide
            before funding a wallet or approving a transaction.
          </p>
        </section>
      </div>
    </dialog>
  )
}
