import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  History,
  LayoutGrid,
  PieChart,
  Search,
  Settings as Cog,
  Vault,
  type LucideIcon,
} from 'lucide-react'
import { MONAD_MAINNET_CHAIN_ID } from '../opportunities'
import { useOpportunities } from '../useOpportunities'

export type Command = { id: string; label: string; group: string; icon: LucideIcon; run: () => void; meta?: string }

const ease = [0.2, 0.7, 0.2, 1] as const

/** Kurage History & commands palette: one list for pages, actions and vault search. */
export default function CommandPalette({
  onClose,
  onTab,
  onTransfer,
  onActivity,
  onOpenOpportunity,
}: {
  onClose: () => void
  onTab: (id: string) => void
  onTransfer: (mode: 'deposit' | 'withdraw') => void
  onActivity: () => void
  onOpenOpportunity: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const vaults = useOpportunities({
    protocol: 'all',
    search: query.trim(),
    page: 0,
    items: 5,
    chainId: MONAD_MAINNET_CHAIN_ID,
  })

  const commands = useMemo(() => {
    const go = (fn: () => void) => () => {
      fn()
      onClose()
    }
    const base: Command[] = [
      { id: 'home', group: 'Pages', label: 'Overview', icon: LayoutGrid, run: go(() => onTab('home')) },
      { id: 'vaults', group: 'Pages', label: 'Earn', icon: PieChart, run: go(() => onTab('vaults')) },
      { id: 'swap', group: 'Pages', label: 'Swap', icon: ArrowLeftRight, run: go(() => onTab('swap')) },
      { id: 'settings', group: 'Pages', label: 'Settings', icon: Cog, run: go(() => onTab('settings')) },
      { id: 'deposit', group: 'Actions', label: 'Deposit USDC', icon: ArrowDownLeft, run: go(() => onTransfer('deposit')) },
      { id: 'withdraw', group: 'Actions', label: 'Withdraw', icon: ArrowUpRight, run: go(() => onTransfer('withdraw')) },
      { id: 'activity', group: 'Actions', label: 'Activity', icon: History, run: go(onActivity) },
    ]
    const q = query.trim().toLowerCase()
    const matched = q ? base.filter((c) => c.label.toLowerCase().includes(q)) : base
    const found: Command[] =
      q && vaults.kind === 'ready'
        ? vaults.page.list.map((v) => ({
            id: `vault-${v.id}`,
            group: 'Vaults',
            label: v.name,
            meta: v.protocol?.name,
            icon: Vault,
            run: go(() => onOpenOpportunity(v.id)),
          }))
        : []
    return [...matched, ...found]
  }, [query, vaults, onClose, onTab, onTransfer, onActivity, onOpenOpportunity])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    input.current?.focus()
    return () => previous?.focus()
  }, [])
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(commands.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') commands[active]?.run()
  }

  let lastGroup = ''
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-[60] flex items-start justify-center bg-[rgba(1,2,4,0.64)] pt-[10vh] backdrop-blur-[3px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        initial={{ opacity: 0, y: 6, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.99 }}
        transition={{ duration: 0.18, ease }}
        onKeyDown={onKey}
        className="flex max-h-[min(580px,calc(100dvh-48px))] w-[min(620px,calc(100vw-24px))] flex-col overflow-hidden rounded-[18px] border border-white/[0.18] bg-[rgba(9,12,18,0.94)] shadow-[0_40px_120px_-24px_rgba(0,0,0,0.9)] backdrop-blur-[22px]"
      >
        <div className="flex h-[58px] items-center gap-2.5 border-b border-white/[0.09] pl-4 pr-3 text-[#9aa4b4] focus-within:shadow-[inset_0_-2px_0_#8eeaf5]">
          <Search size={18} strokeWidth={1.5} />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages, actions and vaults"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={commands[active] ? `cmd-${commands[active].id}` : undefined}
            className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-white outline-none placeholder:text-[#808a9a]"
          />
          <kbd className="rounded-[7px] border border-white/[0.09] px-2 py-0.5 font-mono text-[12px]">esc</kbd>
        </div>
        <div ref={list} id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-2">
          {commands.length === 0 && (
            <p className="px-2.5 py-3 text-[14px] text-[#9aa4b4]">
              {vaults.kind === 'loading' ? 'Searching vaults…' : 'No matches.'}
            </p>
          )}
          {commands.map((c, i) => {
            const heading = c.group !== lastGroup
            lastGroup = c.group
            const Icon = c.icon
            return (
              <div key={c.id}>
                {heading && (
                  <h3 className="px-2.5 pb-1.5 pt-3 font-mono text-[12px] font-normal text-[#808a9a]">
                    {c.group.toLowerCase()}
                  </h3>
                )}
                <div
                  id={`cmd-${c.id}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={c.run}
                  className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-[10px] px-2.5 text-[14px] ${
                    i === active
                      ? 'bg-white/[0.08] text-white shadow-[inset_2px_0_0_#7ce8f2]'
                      : 'text-[#c9d0db]'
                  }`}
                >
                  <span className="text-[#9aa4b4]">
                    <Icon size={18} />
                  </span>
                  <span className="truncate">{c.label}</span>
                  {c.meta && <span className="ml-auto pl-3 font-mono text-[12px] text-[#808a9a]">{c.meta}</span>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex flex-wrap gap-x-[18px] gap-y-1.5 border-t border-white/[0.09] px-4 py-2.5 font-mono text-[12px] text-[#808a9a]">
          <span>
            <kbd className="text-[#9aa4b4]">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="text-[#9aa4b4]">enter</kbd> open
          </span>
          <span>
            <kbd className="text-[#9aa4b4]">esc</kbd> close
          </span>
        </div>
      </motion.div>
    </motion.div>
  )
}
