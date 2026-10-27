import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowDown, ChevronDown, X } from 'lucide-react'
import Scramble from './Scramble'
import SignOverlay, { type SignState } from './SignOverlay'

export default function SwapSheet({
  name,
  ticker,
  price,
  side,
  onClose,
}: {
  name: string
  ticker: string
  price: number
  side: 'buy' | 'sell'
  onClose: () => void
}) {
  const [amount, setAmount] = useState('2500')
  const [state, setState] = useState<'edit' | SignState>('edit')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 350)
    return () => clearTimeout(t)
  }, [])

  const value = Number(amount || 0)
  let units = value * price
  let payToken = ticker
  let getToken = 'USDC'
  if (side === 'buy') {
    units = value / price
    payToken = 'USDC'
    getToken = ticker
  }

  let sideLabelColor = 'rgba(124,232,242,0.75)'
  let sideLabel = 'buy order'
  let confirmClass = 'neon-btn'
  let confirmLabel = `Buy ${ticker}`
  let tone: 'positive' | 'negative' = 'positive'
  if (side === 'sell') {
    sideLabelColor = 'rgba(196,87,106,0.8)'
    sideLabel = 'sell order'
    confirmClass = 'sell-btn'
    confirmLabel = `Sell ${ticker}`
    tone = 'negative'
  }

  const timers = useRef<number[]>([])

  const confirm = () => {
    setState('signing')
    timers.current = [
      window.setTimeout(() => setState('done'), 1600),
      window.setTimeout(onClose, 3600),
    ]
  }

  const reject = () => {
    timers.current.forEach(clearTimeout)
    setState('failed')
    window.setTimeout(() => setState('edit'), 2200)
  }

  let dismiss = undefined as (() => void) | undefined
  if (state === 'edit') {
    dismiss = onClose
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-40 flex items-end overscroll-contain bg-ink/70 backdrop-blur-md"
      onClick={dismiss}
    >
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 250, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="glass relative w-full overflow-hidden rounded-t-[36px] px-5 pb-8 pt-5"
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.3em]"
              style={{ color: sideLabelColor }}
            >
              <Scramble text={sideLabel} />
            </div>
            <div className="mt-2 flex items-center gap-2.5">
              <div className="flex h-10 shrink-0 items-center justify-center rounded-xl bg-neon/10 px-2.5 font-mono text-[12px] font-bold uppercase text-neon">
                {ticker}
              </div>
              <div className="min-w-0">
                <div className="truncate text-[16px] font-medium leading-tight text-white/90">{name}</div>
                <div className="mt-0.5 font-mono text-[11px] uppercase tracking-wider text-white/35">
                  {ticker}
                </div>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="glass-soft flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white/50"
          >
            <X size={15} />
          </button>
        </div>

        <div className="relative space-y-2">
          <div className="glass-soft rounded-3xl px-5 py-4">
            <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-white/30">
              <span>From</span>
              <span>Balance 184,204.00</span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                ref={inputRef}
                inputMode="decimal"
                placeholder="0"
                className="w-full min-w-0 bg-transparent font-mono text-[30px] font-normal caret-neon outline-none placeholder:text-white/25"
              />
              <button
                type="button"
                className="glass flex shrink-0 items-center gap-1.5 rounded-full px-3 py-2 font-mono text-[12px] font-semibold uppercase"
              >
                {payToken} <ChevronDown size={13} className="text-neon" />
              </button>
            </div>
          </div>

          <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
            <motion.button
              type="button"
              whileTap={{ rotate: 180 }}
              className="glass flex h-11 w-11 items-center justify-center rounded-2xl text-neon"
            >
              <ArrowDown size={16} />
            </motion.button>
          </div>

          <div className="glass-soft rounded-3xl px-5 py-4">
            <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-white/30">
              <span>Receive</span>
              <span>Fee 0.05%</span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="font-mono text-[30px] font-normal text-white/85">
                {units.toLocaleString('en-US', { maximumFractionDigits: 2 })}
              </div>
              <button
                type="button"
                className="glass flex shrink-0 items-center gap-1.5 rounded-full px-3 py-2 font-mono text-[12px] font-semibold uppercase"
              >
                {getToken} <ChevronDown size={13} className="text-neon" />
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          {['25%', '50%', '75%', 'Max'].map((p) => (
            <button
              key={p}
              type="button"
              className="glass-soft flex-1 rounded-xl py-2.5 font-mono text-[11px] text-white/50"
            >
              {p}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-2 px-1 font-mono text-[11px]">
          {[
            ['Vault', name],
            ['Ticker', ticker],
            ['Rate', `1 ${ticker} = $${price.toFixed(4)}`],
            ['Settlement', 'T+0 instant'],
            ['Network fee', '$0.42'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4">
              <span className="shrink-0 text-white/30">{k}</span>
              <span className="truncate text-right text-white/70">{v}</span>
            </div>
          ))}
        </div>

        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          onClick={confirm}
          className={`relative mt-5 flex h-16 w-full items-center justify-center overflow-hidden rounded-3xl text-[15px] font-semibold ${confirmClass}`}
        >
          <span className="relative">{confirmLabel}</span>
        </motion.button>

        <AnimatePresence>
          {state !== 'edit' && (
            <SignOverlay
              state={state}
              tone={tone}
              doneLabel="order filled"
              detail={`${units.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${getToken}`}
              onCancel={reject}
            />
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  )
}
