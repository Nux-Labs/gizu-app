import { useEffect, useRef, useState } from 'react'
import { motion, type Variants } from 'framer-motion'
import NumberFlow from '@number-flow/react'

export type VisualKind =
  | 'wallet'
  | 'funding'
  | 'route'
  | 'keys'
  | 'deposit'
  | 'encrypt'
  | 'batch'
  | 'vault'
  | 'shield'

const EASE = [0.65, 0, 0.35, 1] as const

// how a step turns into the next one
const LAYOUT = { duration: 0.95, ease: [0.22, 1, 0.36, 1] } as const

/** The verification tick from the security card. */
function CheckCircle({ delay = 2.3 }: { delay?: number }) {
  return (
    <span className="relative inline-flex h-[18px] w-[18px] items-center justify-center">
      <motion.span
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, delay }}
        className="absolute h-3 w-3 rounded-full bg-neon drop-shadow-[0_0_3px_rgba(124,232,242,0.9)]"
      />
      <motion.svg
        width="8"
        height="8"
        viewBox="0 0 12 12"
        initial={{ opacity: 0, scale: 0 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3, delay: delay + 0.1 }}
        className="relative"
      >
        <path
          d="M2 6.4 4.6 9 10 3.4"
          stroke="#04060a"
          strokeWidth="1.8"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </motion.svg>
    </span>
  )
}

/** Shared stage, so every step carries the same optical weight. */
const STAGE = 'step-stage relative mx-auto h-[340px] w-full max-w-[820px] sm:h-[440px]'

function Stage({ children }: { children: React.ReactNode }) {
  return <div className={STAGE}>{children}</div>
}

/* ------------------------------------------------------------------ vault */
/* Adapted from the forge ui vault lock, same beats and delays. */

const vaultVariant: Variants = {
  open: { y: -20, transition: { duration: 0.3, ease: 'easeInOut' } },
  close: { y: 0, transition: { duration: 0.3, ease: 'easeInOut' } },
}

const inputVariant: Variants = {
  open: { y: -12, transition: { duration: 0.3, ease: 'easeInOut' } },
  close: { y: 0, transition: { duration: 0.3, ease: 'easeInOut' } },
}

const shineVariant: Variants = {
  open: {
    transform: 'translateX(-50%) translateY(0%) rotate(45deg)',
    scale: 1.2,
    transition: { duration: 0.6, ease: EASE, delay: 2.1 },
  },
  close: {
    transform: 'translateX(-125%) translateY(-60%) rotate(45deg)',
    scale: 1,
    transition: { duration: 0.4, ease: EASE },
  },
}

const lockVariant: Variants = {
  open: { rotate: 90, transition: { duration: 0.6, ease: EASE, delay: 2 } },
  close: { rotate: 0, transition: { duration: 0.4, ease: EASE } },
}

const codeVariant: Variants = {
  open: (index: number) => ({
    opacity: 1,
    filter: 'blur(0px)',
    scale: 1,
    transition: { duration: 0.5, delay: 0.3 + index * 0.15, ease: 'easeInOut' },
  }),
  close: {
    opacity: 0,
    filter: 'blur(10px)',
    scale: 1.02,
    transition: { duration: 0.2, ease: 'easeInOut' },
  },
}

function Vault({ on }: { on: boolean }) {
  return (
    <motion.div
      initial="close"
      animate={on ? 'open' : 'close'}
      transition={{ layout: LAYOUT }}
      className={`group ${STAGE}`}
    >

      {/* the safe body, corners cut like a deposit box */}
      <motion.div
        variants={vaultVariant}
        layoutId="carrier"
      data-carrier
        transition={{ layout: LAYOUT }}
        className="absolute inset-x-0 top-[124px] mx-auto h-52 w-[90%] max-w-[420px] border-t border-white/10 bg-gradient-to-b from-[#141a24] to-[#0b0f16] p-6 shadow-lg"
        style={{
          clipPath:
            'polygon(36px 0%, calc(100% - 36px) 0%, 100% 36px, 100% 100%, 0% 100%, 0% 36px)',
        }}
      />

      {/* the dial */}
      <motion.div
        variants={vaultVariant}
        className="absolute inset-x-0 top-[52px] mx-auto flex h-[88px] w-[88px] items-center justify-center overflow-hidden rounded-full bg-[#04060a] p-1"
      >
        <motion.div
          variants={shineVariant}
          className="absolute left-1/2 top-0 h-full w-10 rounded-full bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.5)_30%,#fff,rgba(255,255,255,0.5)_70%,transparent)] opacity-30"
        />
        <motion.div
          variants={lockVariant}
          className="flex h-full w-full items-center justify-center rounded-full border border-white/10 bg-[repeating-radial-gradient(rgba(80,88,100,0.5)_0.15rem,rgba(30,34,44,0.5)_0.32rem)]"
        >
          <div className="flex h-full w-2.5 items-center justify-center">
            <svg
              width="8"
              height="36"
              viewBox="0 0 8 36"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]"
            >
              <path
                fill="#04060a"
                d="M3 0C1.34315 0 0 1.34315 0 3V19.5858C0 19.851 0.105357 20.1054 0.292893 20.2929L3.29289 23.2929C3.68342 23.6834 3.68342 24.3166 3.29289 24.7071L0.292893 27.7071C0.105357 27.8946 0 28.149 0 28.4142V33C0 34.6569 1.34315 36 3 36H5C6.65685 36 8 34.6569 8 33V16.4142C8 16.149 7.89464 15.8946 7.70711 15.7071L4.70711 12.7071C4.31658 12.3166 4.31658 11.6834 4.70711 11.2929L7.70711 8.29289C7.89464 8.10536 8 7.851 8 7.58579V3C8 1.34315 6.65685 0 5 0H3Z"
              />
            </svg>
          </div>
        </motion.div>
        <div className="absolute inset-x-0 top-0 mx-auto flex h-[88px] w-[88px] items-center justify-center overflow-hidden rounded-full border-4 border-[#04060a]" />
      </motion.div>

      <motion.div
        variants={vaultVariant}
        className="absolute inset-x-0 top-[52px] mx-auto flex h-[88px] w-[88px] items-center justify-center overflow-hidden rounded-full border-b-[3px] border-white/10"
      />

      {/* the code field */}
      <motion.div
        variants={inputVariant}
        className="absolute inset-x-0 top-[198px] mx-auto flex w-[90%] max-w-[300px] items-center justify-between rounded-md border border-white/[0.06] bg-white/[0.04] p-2 drop-shadow-[0_2px_5px_rgba(0,0,0,0.5)] transition-all duration-300 group-hover:border-neon/60 group-hover:[box-shadow:inset_0_0_6px_rgba(124,232,242,0.5)]"
      >
        <div className="ml-2 text-xs text-neon">
          {'••••••••••'.split('').map((char, index) => (
            <motion.span
              key={index}
              className="mr-1 inline-block font-[350]"
              variants={codeVariant}
              custom={index}
            >
              {char}
            </motion.span>
          ))}
        </div>
      </motion.div>
    </motion.div>
  )
}

/* ------------------------------------------------------------- the others */

function Wallet({ on }: { on: boolean }) {
  return (
    <Stage>
      <div className="absolute inset-0 flex items-center justify-center">
        <motion.div
          initial={false}
          animate={{
            y: on ? -6 : 0,
            borderColor: on ? 'rgba(124,232,242,0.28)' : 'rgba(255,255,255,0.08)',
          }}
          transition={{ layout: LAYOUT, duration: 0.4, ease: EASE }}
          layoutId="carrier"
      data-carrier
          className="relative w-[min(400px,100%)] overflow-hidden rounded-xl border bg-gradient-to-b from-[#141a24] to-[#0b0f16] p-4 shadow-lg"
        >
          {/* a light sweeps across the card while it reads the wallet */}
          <motion.span
            initial={false}
            animate={on ? { x: ['-60%', '160%'] } : { x: '-60%' }}
            transition={{
              duration: 2.4,
              repeat: on ? Infinity : 0,
              ease: 'easeInOut',
              repeatDelay: 1,
            }}
            className="pointer-events-none absolute inset-y-0 w-1/3 bg-[linear-gradient(90deg,transparent,rgba(124,232,242,0.12),transparent)]"
          />

          <div className="relative flex items-center gap-3">
            <span className="h-9 w-9 rounded-full bg-gradient-to-br from-neon/70 to-neon/20" />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[12px] text-white/70">0x7a4f...9c2e</div>
              <div className="mt-1.5 h-1.5 w-16 rounded-full bg-white/[0.08]" />
            </div>
            <motion.span
              initial={false}
              animate={{ opacity: on ? 1 : 0, scale: on ? 1 : 0.6 }}
              transition={{ duration: 0.3, delay: on ? 0.5 : 0 }}
            >
              <CheckCircle delay={on ? 0.55 : 0} />
            </motion.span>
          </div>

          <motion.div
            initial={false}
            animate={{
              backgroundColor: on ? 'rgba(124,232,242,1)' : 'rgba(255,255,255,0.06)',
              color: on ? '#04060a' : 'rgba(255,255,255,0.5)',
            }}
            transition={{ duration: 0.4 }}
            className="relative mt-4 flex h-9 items-center justify-center rounded-md text-[12px] font-semibold"
          >
            {on ? 'Connected' : 'Connect wallet'}
          </motion.div>
        </motion.div>
      </div>
    </Stage>
  )
}

function Funding({ on }: { on: boolean }) {
  return (
    <Stage>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
        <div className="text-[11px] uppercase tracking-[0.22em] text-white/35">Funding account</div>
        <motion.div
          layoutId="carrier"
      data-carrier
          className="rounded-xl border border-white/[0.07] bg-[#0b0f16] px-6 py-4"
        >
          <NumberFlow
            value={on ? 184204 : 0}
            format={{ style: 'currency', currency: 'USD', maximumFractionDigits: 0 }}
            transformTiming={{ duration: 900, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }}
            className="font-mono text-[56px] leading-none tabular-nums"
          />
        </motion.div>
        <motion.div
          initial={false}
          animate={{ opacity: on ? 1 : 0.3, width: on ? 120 : 40 }}
          transition={{ duration: 0.6, ease: EASE }}
          className="h-1 rounded-full bg-neon"
        />
      </div>
    </Stage>
  )
}

/** Beam travelling along a routed path, adapted from the fraud card. */
const GLYPHS = '8F2A9C41D7B3E5A6'

/** One wire with a pulse running along it. */
function Wire({ on, delay = 0 }: { on: boolean; delay?: number }) {
  return (
    <div className="relative h-px flex-1 overflow-hidden bg-white/[0.12]">
      <motion.span
        initial={false}
        animate={on ? { x: ['-120%', '260%'] } : { x: '-120%' }}
        transition={{
          duration: 1.5,
          repeat: on ? Infinity : 0,
          repeatDelay: 1.1,
          delay,
          ease: 'easeInOut',
        }}
        className="absolute inset-y-0 w-1/2 bg-[linear-gradient(90deg,transparent,#7ce8f2,transparent)]"
      />
    </div>
  )
}

function Route({ on }: { on: boolean }) {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!on) return
    const id = window.setInterval(() => setTick((v) => v + 1), 90)
    return () => window.clearInterval(id)
  }, [on])

  const cipher = Array.from({ length: 4 }, (_, i) => GLYPHS[(tick + i * 5) % GLYPHS.length])

  return (
    <Stage>
      <div className="absolute inset-0 flex items-center justify-center px-5">
        <div className="flex w-full max-w-[560px] items-center">
          {/* where the value comes from */}
          <div className="relative w-[92px] shrink-0 text-center">
            <div className="rounded-lg border border-white/10 bg-[#0a0d14] py-2 font-mono text-[11px] text-white/70">
              0x7a4f
            </div>
            <div className="absolute inset-x-0 top-full mt-2 text-[9px] uppercase tracking-[0.16em] text-white/30">
              public
            </div>
          </div>

          <Wire on={on} />

          {/* the part nobody gets to read */}
          <motion.div
            initial={false}
            animate={{
              borderColor: on ? 'rgba(124,232,242,0.4)' : 'rgba(255,255,255,0.1)',
              backgroundColor: on ? '#0d1622' : '#0a0d14',
            }}
            transition={{ layout: LAYOUT, duration: 0.4 }}
            layoutId="carrier"
      data-carrier
            className="shrink-0 rounded-full border px-3 py-2 text-center"
          >
            <div className="font-mono text-[12px] tracking-[0.1em] text-neon">
              {on ? cipher.join('') : '••••'}
            </div>
          </motion.div>

          <Wire on={on} delay={0.55} />

          {/* the same address, only nobody can read it any more */}
          <div className="relative w-[92px] shrink-0 text-center">
            <motion.div
              initial={false}
              animate={{
                borderColor: on ? 'rgba(124,232,242,0.35)' : 'rgba(255,255,255,0.1)',
                color: on ? '#7ce8f2' : 'rgba(255,255,255,0.45)',
              }}
              transition={{ duration: 0.4, delay: on ? 1 : 0 }}
              className="rounded-lg border bg-[#0a0d14] py-2 font-mono text-[11px]"
            >
              0x7a4f
            </motion.div>
            <div className="absolute inset-x-0 top-full mt-2 text-[9px] uppercase tracking-[0.16em] text-white/30">
              confidential
            </div>
          </div>
        </div>

      </div>
    </Stage>
  )
}

const DERIVED = ['P1', 'P2', 'P3', 'P4']

function Keys({ on }: { on: boolean }) {
  return (
    <Stage>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4">
        {/* the master account */}
        <motion.div
          initial={false}
          animate={{ y: on ? 0 : 6, opacity: on ? 1 : 0.55 }}
          transition={{ layout: LAYOUT, duration: 0.5, ease: EASE }}
          layoutId="carrier"
      data-carrier
          className="flex items-center gap-2.5 rounded-xl border border-neon/25 bg-[#0d1622] px-3.5 py-2"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neon/15 font-mono text-[12px] font-semibold text-neon">
            M
          </span>
          <span className="text-[11px] text-white/55">one passkey</span>
          <CheckCircle delay={on ? 1.1 : 0} />
        </motion.div>

        {/* and what it derives */}
        <div className="relative h-7 w-full max-w-[420px]">
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox="0 0 420 28"
            fill="none"
            preserveAspectRatio="none"
          >
            {DERIVED.map((_, i) => {
              const x = 46 + i * 110
              return (
                <motion.path
                  key={i}
                  d={`M 210 0 V 12 H ${x} V 28`}
                  stroke={on ? 'rgba(124,232,242,0.45)' : 'rgba(255,255,255,0.12)'}
                  strokeWidth="1"
                  initial={false}
                  animate={{ pathLength: on ? 1 : 0.15 }}
                  transition={{ duration: 0.5, delay: on ? 0.35 + i * 0.1 : 0, ease: EASE }}
                />
              )
            })}
          </svg>
        </div>

        <div className="flex w-full max-w-[420px] justify-between">
          {DERIVED.map((k, i) => (
            <motion.span
              key={k}
              initial={false}
              animate={on ? { opacity: 1, y: 0 } : { opacity: 0.35, y: 5 }}
              transition={{ duration: 0.4, delay: on ? 0.6 + i * 0.1 : 0 }}
              className="w-[88px] rounded-lg border border-neon/25 bg-neon/10 py-1.5 text-center font-mono text-[12px] font-semibold text-neon"
            >
              {k}
            </motion.span>
          ))}
        </div>

        <p className="text-[10px] uppercase tracking-[0.18em] text-white/30">derived, not linked</p>
      </div>
    </Stage>
  )
}

const PRESETS = [
  { label: '25%', value: 12500 },
  { label: '50%', value: 25000 },
  { label: '75%', value: 37500 },
  { label: 'Max', value: 50000 },
]

function Deposit({ on }: { on: boolean }) {
  const [pick, setPick] = useState(1)

  // the amount keeps choosing itself, so the card is never static
  useEffect(() => {
    if (!on) return
    const id = window.setInterval(() => setPick((v) => (v + 1) % PRESETS.length), 2400)
    return () => window.clearInterval(id)
  }, [on])

  return (
    <Stage>
      <div className="absolute inset-0 flex items-center justify-center">
        <motion.div
          initial={false}
          animate={{
            y: on ? -6 : 0,
            borderColor: on ? 'rgba(124,232,242,0.5)' : 'rgba(255,255,255,0.08)',
          }}
          transition={{ layout: LAYOUT, duration: 0.4, ease: EASE }}
          layoutId="carrier"
      data-carrier
          className="w-[min(408px,100%)] rounded-xl border bg-gradient-to-b from-[#141a24] to-[#0b0f16] p-5"
        >
          <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Amount</div>
          <div className="mt-3 flex items-baseline">
            <NumberFlow
              value={on ? PRESETS[pick].value : 25000}
              format={{ style: 'currency', currency: 'USD', maximumFractionDigits: 0 }}
              transformTiming={{ duration: 700, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }}
              className="font-mono text-[38px] leading-none tabular-nums"
            />
            <motion.span
              className="ml-0.5 text-[38px] leading-none text-neon"
              animate={{ opacity: [1, 0, 1] }}
              transition={{ duration: 1.1, repeat: Infinity }}
            >
              |
            </motion.span>
          </div>
          <div className="mt-4 flex gap-1.5">
            {PRESETS.map((preset, i) => (
              <motion.span
                key={preset.label}
                initial={false}
                animate={{
                  backgroundColor:
                    on && i === pick ? 'rgba(124,232,242,0.16)' : 'rgba(255,255,255,0.05)',
                  color: on && i === pick ? '#7ce8f2' : 'rgba(255,255,255,0.45)',
                }}
                transition={{ duration: 0.3 }}
                className="flex-1 rounded-md py-1.5 text-center text-[10px]"
              >
                {preset.label}
              </motion.span>
            ))}
          </div>
        </motion.div>
      </div>
    </Stage>
  )
}

const PLAIN = '$25,000'
const CIPHER = 'A3F91C7'

function Encrypt({ on }: { on: boolean }) {
  return (
    <Stage>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-6">
        {/* every character turns over in place, plain on one face, cipher on the other */}
        <motion.div layoutId="carrier"
      data-carrier transition={{ layout: LAYOUT }} className="flex gap-1 rounded-xl border border-white/[0.07] bg-[#0b0f16] px-3 py-2">
          {PLAIN.split('').map((c, i) => (
            <span key={i} className="relative block h-14 w-[36px] [perspective:400px]">
              <motion.span
                initial={false}
                animate={{ rotateX: on ? -180 : 0 }}
                transition={{ duration: 0.5, delay: on ? 0.2 + i * 0.08 : i * 0.04, ease: EASE }}
                className="absolute inset-0 [transform-style:preserve-3d]"
              >
                <span className="absolute inset-0 flex items-center justify-center rounded-md bg-white/[0.05] font-mono text-[31px] text-white/70 [backface-visibility:hidden]">
                  {c}
                </span>
                <span className="absolute inset-0 flex items-center justify-center rounded-md bg-neon/10 font-mono text-[31px] text-neon [backface-visibility:hidden] [transform:rotateX(180deg)]">
                  {CIPHER[i]}
                </span>
              </motion.span>
            </span>
          ))}
        </motion.div>

        <motion.div
          initial={false}
          animate={{ opacity: on ? 1 : 0.25 }}
          transition={{ duration: 0.4, delay: on ? 0.9 : 0 }}
          className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-white/40"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-neon" />
          encrypted on chain
        </motion.div>
      </div>
    </Stage>
  )
}

const ACCOUNTS = [
  { y: 36, label: 'P1' },
  { y: 92, label: 'P2' },
  { y: 148, label: 'P3' },
  { y: 204, label: 'P4' },
]

const IN_PATH = 'M 132 120 H 196'
const outPath = (y: number) => `M 284 120 C 336 120 344 ${y} 388 ${y}`

/** One deposit goes in, and comes out spread across the anonym accounts, so
 *  nothing leaving the core points back at what entered it. */
function Batch({ on }: { on: boolean }) {
  return (
    <Stage>
      <div className="absolute inset-0">
        {/* fixed box, so the drawing and the html sit in one coordinate space.
            it is centred by transform, not by flow, so it can be wider than
            the stage without pushing the layout around */}
        <div className="absolute left-1/2 top-1/2 h-[240px] w-[520px] -translate-x-1/2 -translate-y-1/2 scale-[0.6] sm:scale-[0.9] lg:scale-[1.28]">
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox="0 0 520 240"
            fill="none"
            preserveAspectRatio="none"
          >
            <path d={IN_PATH} stroke="rgba(255,255,255,0.1)" strokeWidth="1.2" />
            {ACCOUNTS.map((a, i) => (
              <path key={i} d={outPath(a.y)} stroke="rgba(255,255,255,0.1)" strokeWidth="1.2" />
            ))}

            {on && (
              <g stroke="#7ce8f2" strokeWidth="1.6" strokeLinecap="round" fill="none">
                <path className="reactor-flow reactor-flow-in" d={IN_PATH} pathLength={1} />
                {ACCOUNTS.map((a, i) => (
                  <path
                    key={i}
                    className={`reactor-flow reactor-flow-${i}`}
                    d={outPath(a.y)}
                    pathLength={1}
                  />
                ))}
              </g>
            )}
          </svg>

          {/* what goes in */}
          <span
            className="absolute flex h-8 w-[112px] items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] font-mono text-[12px] text-white/55"
            style={{ left: 20, top: 104 }}
          >
            0x7a4f
          </span>

          {/* the core, which the vault grows out of */}
          <div
            className="absolute flex h-[88px] w-[88px] items-center justify-center rounded-full border border-neon/25 bg-[#0d1622]"
            style={{ left: 196, top: 76 }}
          >
            <motion.img
              src="/gizulogo.svg"
              alt=""
              className="h-8 w-auto"
              initial={false}
              animate={{ opacity: on ? [0.7, 1, 0.7] : 0.5 }}
              transition={{ duration: 1.8, repeat: on ? Infinity : 0, ease: 'easeInOut' }}
            />
          </div>

          {/* and what comes out */}
          {ACCOUNTS.map((a, i) => (
            <motion.span
              key={a.label}
              {...(i === 0 ? { layoutId: 'carrier', 'data-carrier': true, transition: { layout: LAYOUT } } : {})}
              className="absolute flex h-8 w-[104px] items-center justify-center rounded-lg border border-neon/30 bg-neon/10 font-mono text-[12px] font-semibold text-neon"
              style={{ left: 388, top: a.y - 16 }}
            >
              {a.label}
            </motion.span>
          ))}
        </div>
      </div>

      <style>{`
        /* the staged reveal sets an animation on every child, so this one
           has to state that it keeps its own */
        .reactor-flow {
          stroke-dasharray: 0.14 1;
          animation: reactor-flow 2.6s linear infinite !important;
        }
        .reactor-flow-in { animation-delay: 0s !important; }
        ${ACCOUNTS.map((_, i) => `
        .reactor-flow-${i} { animation-delay: ${(0.8 + i * 0.18).toFixed(2)}s !important; }`).join('')}
        @keyframes reactor-flow {
          from { stroke-dashoffset: 1.14; }
          to { stroke-dashoffset: 0; }
        }
      `}</style>
    </Stage>
  )
}

function Shield({ on }: { on: boolean }) {
  return (
    <Stage>
      {/* the phone stands past the horizon, so it is never a floating object */}
      <div
        className="absolute inset-x-0 bottom-[14px] top-0 overflow-hidden"
        style={{
          maskImage: 'linear-gradient(to bottom, #000 90%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 90%, transparent 100%)',
        }}
      >
      <motion.div
        initial={false}
        animate={{ y: on ? -22 : 0 }}
        transition={{ layout: LAYOUT, duration: 0.3, ease: 'easeInOut' }}
        layoutId="carrier"
      data-carrier
        className="absolute inset-x-0 top-[74px] mx-auto h-[400px] w-[min(330px,92%)] rounded-[40px] border border-white/10 bg-[#11151d] p-1.5"
      >
        <div className="relative h-full overflow-hidden rounded-[28px] bg-[#070a10]">
          <div className="absolute left-5 top-3 text-[9px] text-white/35">09:41</div>
          <motion.span
            initial={false}
            animate={{ backgroundColor: on ? '#7ce8f2' : 'rgba(255,255,255,0.12)' }}
            transition={{ duration: 0.2 }}
            className="absolute left-1/2 top-2.5 h-5 w-5 -translate-x-1/2 rounded-full"
          />

          <motion.div
            initial={false}
            animate={
              on
                ? { y: 44, scale: 1, filter: 'blur(0px)' }
                : { y: -70, scale: 0.75, filter: 'blur(10px)' }
            }
            transition={{ duration: 0.3, ease: 'easeInOut', delay: on ? 0.1 : 0 }}
            className="absolute inset-x-2.5 z-10 flex items-center gap-2.5 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.08] px-2.5 py-2.5 backdrop-blur-md"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neon/15">
              <img src="/gizulogo.svg" alt="" className="h-4 w-auto" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="flex-1 truncate text-[12px] font-medium leading-none">
                  Position updated
                </span>
                <span className="shrink-0 text-[9px] leading-none text-white/35">now</span>
              </span>
              <span className="mt-2 block truncate text-[11px] leading-none text-white/50">
                Balance •••••• anonym
              </span>
            </span>
          </motion.div>

          {/* home screen behind the alert */}
          <div className="absolute inset-x-5 top-[104px] grid grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <span
                key={i}
                className="aspect-square rounded-xl bg-gradient-to-br from-white/[0.08] to-white/[0.02]"
              />
            ))}
          </div>
        </div>
      </motion.div>

      </div>

      {/* the horizon itself */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[14px] h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.18),transparent)]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-[14px] mx-auto h-20 w-2/3 -translate-y-1/2 rounded-[50%] bg-[radial-gradient(50%_50%_at_50%_50%,rgba(124,232,242,0.1),transparent_70%)]" />
    </Stage>
  )
}

const MAP = {
  wallet: Wallet,
  funding: Funding,
  route: Route,
  keys: Keys,
  deposit: Deposit,
  encrypt: Encrypt,
  batch: Batch,
  vault: Vault,
  shield: Shield,
}

export default function StepVisual({ kind, on }: { kind: VisualKind; on: boolean }) {
  const Comp = MAP[kind]
  return <Comp on={on} />
}
