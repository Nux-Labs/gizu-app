import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  LayoutGrid,
  PieChart,
  ArrowLeftRight,
  Settings as Cog,
  Bell,
  LogOut,
  Search,
  PanelLeft,
} from 'lucide-react'
import { notifications, profile } from '../content'
import AsciiChameleon from '../chameleon/AsciiChameleon'
import useStored from '../useStored'

const NAV = [
  { id: 'home', label: 'Overview', icon: LayoutGrid },
  { id: 'vaults', label: 'Earn', icon: PieChart },
  { id: 'swap', label: 'Swap', icon: ArrowLeftRight },
  { id: 'settings', label: 'Settings', icon: Cog },
] as const

const ease = [0.2, 0.7, 0.2, 1] as const

/** Kurage layout: glass rail on the left, ASCII chameleon ocean behind the main stage. */
export default function DesktopShell({
  tab,
  onTab,
  onDisconnect,
  onSearch,
  children,
}: {
  tab: string
  onTab: (id: string) => void
  onDisconnect: () => void
  onSearch: () => void
  children: ReactNode
}) {
  const [bell, setBell] = useState(false)
  const [read, setRead] = useState<string[]>([])
  const unread = notifications.filter((n) => n.unread && !read.includes(n.id)).length
  const [collapsed, setCollapsed] = useStored('gizu:rail-collapsed', false)
  const hide = collapsed ? 'sr-only' : ''

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-ink">
      <aside
        className={`z-20 flex shrink-0 flex-col overflow-hidden border-r border-white/[0.09] bg-[rgba(6,9,14,0.88)] px-3 pb-3 pt-3.5 backdrop-blur-[18px] transition-[width] duration-200 ease-[cubic-bezier(.2,.7,.2,1)] ${
          collapsed ? 'w-[72px]' : 'w-[248px]'
        }`}
      >
        <div className="mb-3.5 flex h-11 items-center gap-3 px-2.5">
          <img src="/gizulogo.svg" alt="" className="h-6 w-auto" />
          <span className={`text-[17px] font-medium tracking-[-0.025em] ${hide}`}>Gizu</span>
        </div>

        <nav className="flex flex-col gap-1">
          {NAV.map(({ id, label, icon: Icon }) => {
            const on = tab === id
            return (
              <button
                key={id}
                onClick={() => onTab(id)}
                aria-current={on ? 'page' : undefined}
                title={collapsed ? label : undefined}
                className={`relative flex min-h-11 items-center gap-3 rounded-xl px-3 text-left text-[14px] transition-colors duration-150 ${
                  on ? 'text-white' : 'text-[#9aa4b4] hover:bg-white/[0.055] hover:text-white'
                }`}
              >
                {on && (
                  <motion.span
                    layoutId="railActive"
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    className="absolute inset-0 rounded-xl bg-white/[0.08]"
                  >
                    <span className="absolute -left-3 bottom-3 top-3 w-0.5 rounded-full bg-gradient-to-b from-neon to-violet" />
                  </motion.span>
                )}
                <Icon size={19} strokeWidth={1.5} className="relative shrink-0" />
                <span className={`relative whitespace-nowrap ${hide}`}>{label}</span>
              </button>
            )
          })}
        </nav>

        <div className={`mt-5 min-h-0 ${collapsed ? 'hidden' : ''}`}>
          <h3 className="mb-1.5 px-3 font-mono text-[12px] font-normal text-[#808a9a]">recent</h3>
          <ul className="flex flex-col gap-0.5">
            {notifications.slice(0, 4).map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => setBell(true)}
                  className="block w-full truncate rounded-[10px] px-3 py-2 text-left text-[13px] text-[#9aa4b4] hover:bg-white/[0.055] hover:text-white"
                >
                  {n.title}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-auto flex flex-col gap-1 pt-3">
          <div className="flex min-h-11 items-center gap-3 rounded-xl px-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[radial-gradient(circle_at_50%_30%,#14303a,#0a1420_48%,#05080d)] font-mono text-[11px] text-neon shadow-[0_0_0_1px_rgba(142,234,245,0.34),0_0_16px_-3px_rgba(124,232,242,0.55)]">
              {profile.initials}
            </span>
            <span className={`min-w-0 leading-tight ${hide}`}>
              <span className="block truncate text-[13px] font-medium">{profile.name}</span>
              <span className="block font-mono text-[11px] text-[#808a9a]">{profile.address}</span>
            </span>
          </div>
          <button
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand sidebar' : undefined}
            className="flex min-h-11 items-center gap-3 whitespace-nowrap rounded-xl px-3 text-[14px] text-[#9aa4b4] hover:bg-white/[0.055] hover:text-white"
          >
            <PanelLeft size={18} strokeWidth={1.5} className="shrink-0" />
            <span className={hide}>Collapse</span>
          </button>
          <button
            onClick={onDisconnect}
            title={collapsed ? 'Disconnect' : undefined}
            className="flex min-h-11 items-center gap-3 whitespace-nowrap rounded-xl px-3 text-[14px] text-rose-300/70 hover:bg-white/[0.055]"
          >
            <LogOut size={18} strokeWidth={1.5} className="shrink-0" />
            <span className={hide}>Disconnect</span>
          </button>
        </div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 opacity-70 [mask-image:radial-gradient(140%_120%_at_50%_45%,#000_55%,rgba(0,0,0,0.55)_100%)]"
        >
          <AsciiChameleon anchorX={0.74} anchorY={0.8} size={0.1} />
        </div>

        <header className="relative z-30 flex shrink-0 justify-end gap-2 px-6 pt-4">
          <button
            onClick={onSearch}
            className="glass-soft flex h-10 items-center gap-2 rounded-xl pl-3 pr-2 text-[14px] text-[#c9d0db] shadow-[0_14px_34px_-16px_rgba(0,0,0,0.9)] transition-colors hover:border-white/[0.18] hover:text-white"
          >
            <Search size={16} strokeWidth={1.5} />
            Search
            <kbd className="ml-1 flex h-6 items-center rounded-[7px] border border-white/[0.09] bg-white/[0.03] px-2 font-mono text-[12px] text-[#9aa4b4]">
              {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} K
            </kbd>
          </button>
          <div className="relative">
            <button
              onClick={() => setBell((b) => !b)}
              className="glass-soft flex h-10 items-center gap-2 rounded-xl pl-3 pr-2 text-[14px] text-[#c9d0db] shadow-[0_14px_34px_-16px_rgba(0,0,0,0.9)] transition-colors hover:border-white/[0.18] hover:text-white"
            >
              <Bell size={16} strokeWidth={1.5} />
              Notifications
              <kbd className="ml-1 flex h-6 items-center rounded-[7px] border border-white/[0.09] bg-white/[0.03] px-2 font-mono text-[12px] text-[#9aa4b4]">
                {unread}
              </kbd>
            </button>

            <AnimatePresence>
              {bell && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setBell(false)} />
                  <motion.div
                    initial={{ opacity: 0, y: 6, scale: 0.99 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 6, scale: 0.99 }}
                    transition={{ duration: 0.18, ease }}
                    className="absolute right-0 top-12 z-50 w-[400px] overflow-hidden rounded-[18px] border border-white/[0.18] bg-[rgba(9,12,18,0.94)] shadow-[0_40px_120px_-24px_rgba(0,0,0,0.9)] backdrop-blur-[22px]"
                  >
                    <div className="flex items-center justify-between border-b border-white/[0.09] px-4 py-3.5">
                      <span className="text-[15px] font-medium">Notifications</span>
                      <button
                        onClick={() => setRead(notifications.map((n) => n.id))}
                        className="font-mono text-[12px] text-neon/80"
                      >
                        mark all read
                      </button>
                    </div>
                    <div className="max-h-[380px] overflow-y-auto p-2">
                      {notifications.map((n) => {
                        const isUnread = n.unread && !read.includes(n.id)
                        return (
                          <button
                            key={n.id}
                            onClick={() => setRead((r) => (r.includes(n.id) ? r : [...r, n.id]))}
                            className="flex w-full items-start gap-3 rounded-[10px] px-3 py-3 text-left hover:bg-white/[0.055]"
                          >
                            <span
                              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                                isUnread ? 'eyebrow-dot' : 'bg-white/15'
                              }`}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline justify-between gap-3">
                                <span className="truncate text-[14px] font-medium">{n.title}</span>
                                <span className="shrink-0 font-mono text-[11px] text-[#808a9a]">
                                  {n.time}
                                </span>
                              </span>
                              <span className="mt-1 block truncate text-[12px] text-[#9aa4b4]">
                                {n.body}
                              </span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
        </header>

        <div className="relative z-10 flex min-h-0 flex-1 flex-col">{children}</div>
      </main>
    </div>
  )
}
