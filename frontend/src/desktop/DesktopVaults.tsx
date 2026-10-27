import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Search } from 'lucide-react'
import OpportunityCard from '../components/OpportunityCard'
import ProtocolFilters from '../components/ProtocolFilters'
import { MONAD_MAINNET_CHAIN_ID, type ProtocolSelection } from '../opportunities'
import { useOpportunities } from '../useOpportunities'
import LoadError from '../components/LoadError'

export default function DesktopVaults({
  onOpenOpportunity,
}: {
  onOpenOpportunity: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [protocol, setProtocol] = useState<ProtocolSelection>('all')
  const [page, setPage] = useState(0)
  const items = 8
  const load = useOpportunities({
    protocol,
    search,
    page,
    items,
    chainId: MONAD_MAINNET_CHAIN_ID,
  })

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query)
    }, 300)
    return () => clearTimeout(timer)
  }, [query])

  let total = 0
  if (load.kind === 'ready') {
    total = load.page.total
  }
  let canPrev = false
  if (page > 0) {
    canPrev = true
  }
  let canNext = false
  if (total > (page + 1) * items) {
    canNext = true
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1520px] flex-1 flex-col px-14 pb-6 pt-7">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="shrink-0">
        <h1 className="text-[28px] font-medium tracking-tight">Confidential vaults</h1>
        <p className="mt-1 text-[13px] text-white/40">Settlement on Monad.</p>
      </motion.div>

      <div className="mt-5 flex shrink-0 items-center gap-3">
        <div className="glass-soft flex flex-1 items-center gap-3 rounded-2xl px-5 py-3">
          <Search size={16} className="shrink-0 text-white/35" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(0)
            }}
            aria-label="Search opportunities"
            placeholder="Search tokens, tags, campaigns"
            className="h-7 w-full min-w-0 bg-transparent text-[14px] outline-none placeholder:text-white/25"
          />
        </div>
      </div>

      <div className="mt-4 shrink-0">
        <ProtocolFilters
          value={protocol}
          onChange={(next) => {
            setProtocol(next)
            setPage(0)
          }}
        />
      </div>

      {load.kind === 'loading' && (
        <div className="flex flex-1 items-center justify-center font-mono text-[11px] uppercase tracking-[0.25em] text-white/25">
          Loading vaults
        </div>
      )}
      {load.kind === 'failed' && (
        <LoadError className="flex-1 justify-center" message={load.message} onRetry={load.retry} />
      )}
      {load.kind === 'ready' && load.page.list.length === 0 && (
        <div className="flex flex-1 items-center justify-center font-mono text-[11px] uppercase tracking-[0.25em] text-white/25">
          No vault matches
        </div>
      )}
      {load.kind === 'ready' && (
        <div className="mt-5 grid min-h-0 flex-1 grid-cols-4 gap-5">
          {load.page.list.map((opportunity, i) => (
            <OpportunityCard
              key={opportunity.id}
              opportunity={opportunity}
              delay={0.04 * i}
              className="h-full"
              chartHeight={96}
              onOpen={onOpenOpportunity}
            />
          ))}
        </div>
      )}

      <div className="mt-4 flex shrink-0 items-center justify-end gap-3">
        <button
          type="button"
          disabled={!canPrev}
          onClick={() => setPage(page - 1)}
          className="glass-soft rounded-full px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-white/50 disabled:opacity-30"
        >
          Prev
        </button>
        <span className="font-mono text-[10px] uppercase tracking-widest text-white/30">{page + 1}</span>
        <button
          type="button"
          disabled={!canNext}
          onClick={() => setPage(page + 1)}
          className="glass-soft rounded-full px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-white/50 disabled:opacity-30"
        >
          Next
        </button>
      </div>
    </div>
  )
}
