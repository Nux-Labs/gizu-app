import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Search } from 'lucide-react'
import OpportunityCard from './OpportunityCard'
import ProtocolFilters from './ProtocolFilters'
import { MONAD_MAINNET_CHAIN_ID, type ProtocolSelection } from '../opportunities'
import { useOpportunities } from '../useOpportunities'
import LoadError from './LoadError'

export default function Vaults({ onOpenOpportunity }: { onOpenOpportunity: (id: string) => void }) {
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
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-36 pt-14">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <h2 className="text-[30px] font-medium tracking-tight">Confidential vaults</h2>
      </motion.div>

      <div className="mt-6">
        <div className="glass-soft flex flex-1 items-center gap-3 rounded-2xl px-4">
          <Search size={15} className="shrink-0 text-white/35" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(0)
            }}
            aria-label="Search opportunities"
            placeholder="Search tokens, tags, campaigns"
            className="h-12 w-full min-w-0 bg-transparent text-[14px] outline-none placeholder:text-white/25"
          />
        </div>
      </div>

      <div className="mt-4">
        <ProtocolFilters
          value={protocol}
          onChange={(next) => {
            setProtocol(next)
            setPage(0)
          }}
        />
      </div>

      {load.kind === 'loading' && (
        <div className="mt-16 text-center font-mono text-[11px] uppercase tracking-[0.25em] text-white/25">
          Loading vaults
        </div>
      )}
      {load.kind === 'failed' && (
        <LoadError className="mt-10" message={load.message} onRetry={load.retry} />
      )}
      {load.kind === 'ready' && load.page.list.length === 0 && (
        <div className="mt-16 text-center font-mono text-[11px] uppercase tracking-[0.25em] text-white/25">
          No vault matches
        </div>
      )}
      {load.kind === 'ready' && (
        <div className="mt-5 grid grid-cols-2 gap-3">
          {load.page.list.map((opportunity, i) => (
            <OpportunityCard
              key={opportunity.id}
              opportunity={opportunity}
              delay={0.05 * i}
              onOpen={onOpenOpportunity}
            />
          ))}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          disabled={!canPrev}
          onClick={() => setPage(page - 1)}
          className="glass-soft rounded-full px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-white/50 disabled:opacity-30"
        >
          Prev
        </button>
        <span className="font-mono text-[10px] uppercase tracking-widest text-white/30">
          {page + 1}
        </span>
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
