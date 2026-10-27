import { useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import Chart from '../components/Chart'
import OpportunityCard from '../components/OpportunityCard'
import SpotlightCard from '../components/SpotlightCard'
import useSize from '../useSize'
import { holdings, portfolioSeries } from '../data'
import { MONAD_MAINNET_CHAIN_ID } from '../opportunities'
import { useOpportunities } from '../useOpportunities'

// Demo series window per period: newest samples last.
const RANGES = { '1D': 8, '1W': 18, '1M': 36, '1Y': 60, All: 72 } as const
type Range = keyof typeof RANGES

export default function DesktopHome({
  onOpenOpportunity,
  onTransfer,
  onActivity,
  onSeeAllVaults,
}: {
  onOpenOpportunity: (id: string) => void
  onTransfer: (mode: 'deposit' | 'withdraw') => void
  onActivity: () => void
  onSeeAllVaults: () => void
}) {
  const total = holdings.reduce((a, h) => a + h.value, 0)
  const [whole, cents] = total.toFixed(2).split('.')
  const chart = useSize<HTMLDivElement>()
  const [range, setRange] = useState<Range>('1M')
  const series = portfolioSeries.slice(-RANGES[range])
  const change = ((series[series.length - 1] - series[0]) / series[0]) * 100
  const up = change >= 0
  const vaults = useOpportunities({
    protocol: 'all',
    search: '',
    page: 0,
    items: 4,
    chainId: MONAD_MAINNET_CHAIN_ID,
  })

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1520px] flex-1 flex-col px-14 pb-6 pt-1">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex shrink-0 items-center justify-between"
      >
        <div>
          <h1 className="text-[38px] font-light leading-[1.1] tracking-[-0.04em]">
            Good evening, <span className="text-gradient">Cankat</span>
          </h1>
          <p className="mt-1.5 text-[13px] text-[#9aa4b4]">
            Three vaults active, next redemption window opens in 6 days.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => onTransfer('deposit')}
            className="neon-btn flex h-11 items-center gap-2 rounded-2xl px-5 text-[14px] font-semibold"
          >
            <ArrowDownLeft size={16} /> Deposit
          </button>
          <button
            onClick={() => onTransfer('withdraw')}
            className="glass flex h-11 items-center gap-2 rounded-2xl px-5 text-[14px] font-medium"
          >
            <ArrowUpRight size={16} className="text-neon" /> Withdraw
          </button>
        </div>
      </motion.div>

      <div className="mt-5 grid min-h-0 flex-1 grid-cols-3 gap-5">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="col-span-2 flex min-h-0"
        >
          <SpotlightCard
            className="flex min-h-0 w-full flex-col rounded-[28px] p-7"
            contentClassName="flex min-h-0 flex-1 flex-col"
          >
            <div className="flex shrink-0 items-start justify-between">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-white/30">
                  Portfolio value
                </div>
                <div className="mt-2 flex items-end gap-1">
                  <span className="text-[46px] font-normal leading-none tracking-tight">
                    ${Number(whole).toLocaleString('en-US')}
                  </span>
                  <span className="pb-0.5 text-[22px] text-white/35">.{cents}</span>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <span
                    className={`rounded-full px-3 py-1 font-mono text-[12px] ${
                      up ? 'bg-neon/10 text-neon' : 'bg-rose-400/10 text-rose-300'
                    }`}
                  >
                    {up ? '+' : '-'} {Math.abs(change).toFixed(2)}%
                  </span>
                  <span className="font-mono text-[12px] text-white/30">+$30,412.09 today</span>
                </div>
              </div>
              <div
                role="radiogroup"
                aria-label="Chart period"
                className="flex gap-2 font-mono text-[10px] uppercase tracking-widest"
              >
                {(Object.keys(RANGES) as Range[]).map((t) => (
                  <button
                    key={t}
                    role="radio"
                    aria-checked={t === range}
                    onClick={() => setRange(t)}
                    className={`rounded-full px-3 py-1.5 transition-colors ${
                      t === range ? 'bg-neon/15 text-neon' : 'text-white/45 hover:text-white/80'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div ref={chart.ref} className="mt-5 min-h-0 flex-1">
              {chart.height > 20 && (
                <Chart key={range} series={series} height={chart.height} up={up} />
              )}
            </div>
          </SpotlightCard>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="flex min-h-0 flex-col gap-5"
        >
          <SpotlightCard
            className="flex min-h-0 flex-1 flex-col rounded-[28px] p-6"
            contentClassName="flex min-h-0 flex-1 flex-col"
          >
            <div className="flex shrink-0 items-center justify-between">
              <h3 className="text-[17px] font-medium tracking-tight">Holdings</h3>
              <button
                onClick={onActivity}
                className="font-mono text-[10px] uppercase tracking-widest text-neon/70"
              >
                activity
              </button>
            </div>
            <div className="mt-2 min-h-0 flex-1 divide-y divide-white/5 overflow-y-auto">
              {holdings.map((h) => (
                <div key={h.id} className="flex items-center justify-between py-3.5">
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium">{h.name}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-white/30">{h.units} units</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-[14px] font-normal">
                      ${h.value.toLocaleString('en-US')}
                    </div>
                    <div
                      className={`font-mono text-[10px] ${
                        h.change >= 0 ? 'text-neon/70' : 'text-rose-400/80'
                      }`}
                    >
                      {h.change >= 0 ? '+' : ''}
                      {h.change}%
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </SpotlightCard>

          <SpotlightCard className="shrink-0 rounded-[28px] p-6">
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-white/30">
              Available to invest
            </div>
            <div className="mt-2 font-mono text-[26px] font-normal tracking-tight">$184,204.00</div>
            <div className="mt-1 font-mono text-[11px] text-white/30">USDC on Monad</div>
          </SpotlightCard>
        </motion.div>
      </div>

      <section className="mt-6 shrink-0">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="text-[18px] font-medium tracking-tight">Confidential vaults</h2>
          <div className="flex items-center gap-4">
            <button
              onClick={onSeeAllVaults}
              className="font-mono text-[10px] uppercase tracking-widest text-neon/70"
            >
              see all
            </button>
          </div>
        </div>
        {vaults.kind === 'loading' && (
          <div className="py-10 text-center font-mono text-[11px] uppercase tracking-[0.25em] text-white/25">
            Loading vaults
          </div>
        )}
        {vaults.kind === 'failed' && (
          <div className="py-10 text-center font-mono text-[11px] uppercase tracking-[0.25em] text-white/25">
            {vaults.message}
          </div>
        )}
        {vaults.kind === 'ready' && vaults.page.list.length === 0 && (
          <div className="py-10 text-center font-mono text-[11px] uppercase tracking-[0.25em] text-white/25">
            No vaults
          </div>
        )}
        {vaults.kind === 'ready' && (
          <div className="grid grid-cols-4 gap-5">
            {vaults.page.list.map((opportunity, i) => (
              <OpportunityCard
                key={opportunity.id}
                opportunity={opportunity}
                delay={0.05 * i}
                className="h-[196px]"
                chartHeight={60}
                onOpen={onOpenOpportunity}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
