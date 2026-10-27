import { useState } from 'react'
import { motion } from 'framer-motion'
import { Fingerprint, Bell, Globe, ShieldCheck, FileText, LifeBuoy, ChevronRight, Copy } from 'lucide-react'
import SpotlightCard from '../components/SpotlightCard'
import { profile } from '../content'

const groups = [
  {
    title: 'Security',
    rows: [
      { id: 'passkey-wallet', icon: Fingerprint, label: 'Passkey wallet', value: 'Active' },
      { id: 'transaction-signing', icon: ShieldCheck, label: 'Transaction signing', value: 'Biometric' },
      { id: 'alerts', icon: Bell, label: 'Push alerts', toggle: true },
    ],
  },
  {
    title: 'Preferences',
    rows: [
      { id: 'currency', icon: Globe, label: 'Currency', value: 'USD' },
      { id: 'statements', icon: FileText, label: 'Statements', value: 'Monthly' },
    ],
  },
  {
    title: 'Support',
    rows: [
      { id: 'contact-desk', icon: LifeBuoy, label: 'Contact desk' },
      { id: 'terms', icon: FileText, label: 'Terms and disclosures' },
    ],
  },
] as const

export default function DesktopSettings({ onOpen }: { onOpen: (id: string) => void }) {
  const [alerts, setAlerts] = useState(true)

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1520px] flex-1 flex-col px-14 pb-6 pt-7">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="shrink-0">
        <h1 className="text-[28px] font-medium tracking-tight">Account</h1>
        <p className="mt-1 text-[13px] text-white/40">Member since September 2026, desk coverage EMEA.</p>
      </motion.div>

      <div className="mt-5 grid min-h-0 flex-1 grid-cols-3 items-start gap-5">
        <section>
          <div className="mb-3 px-1 font-mono text-[10px] uppercase tracking-[0.25em] text-white/30">
            Profile
          </div>
          <SpotlightCard className="rounded-3xl p-6">
          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-neon/10 font-mono text-[17px] text-neon">
              CP
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[17px] font-medium">{profile.name}</div>
              <div className="mt-1 truncate font-mono text-[12px] text-white/30">{profile.address}</div>
            </div>
            <button className="glass-soft flex h-10 w-10 items-center justify-center rounded-xl text-white/45">
              <Copy size={14} />
            </button>
          </div>
            <div className="mt-6 space-y-3 font-mono text-[12px]">
            {[
              ['Network', 'Monad'],
              ['Wallet', 'Passkey'],
              ['Tier', 'Qualified member'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-white/30">{k}</span>
                <span className="text-white/70">{v}</span>
              </div>
            ))}
            </div>
          </SpotlightCard>
        </section>

        <div className="col-span-2 space-y-5">
          {groups.map((g, gi) => (
            <motion.section
              key={g.title}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 * gi }}
            >
              <div className="mb-3 px-1 font-mono text-[10px] uppercase tracking-[0.25em] text-white/30">
                {g.title}
              </div>
              <div className="glass divide-y divide-white/5 rounded-3xl">
                {g.rows.map((r) => {
                  const Icon = r.icon
                  return (
                    <div
                      key={r.id}
                      role={'toggle' in r ? undefined : 'button'}
                      onClick={() => !('toggle' in r) && onOpen(r.id)}
                      className="flex min-h-[58px] items-center gap-4 px-6 text-left hover:bg-white/[0.02]"
                    >
                      <Icon size={16} className="shrink-0 text-white/40" />
                      <span className="flex-1 truncate text-[14px] text-white/85">{r.label}</span>
                      {'toggle' in r ? (
                        <button
                          onClick={() => setAlerts((a) => !a)}
                          className={`flex h-6 w-11 items-center rounded-full p-0.5 transition-colors ${
                            alerts ? 'bg-neon' : 'bg-white/10'
                          }`}
                        >
                          <motion.span
                            layout
                            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                            className={`h-5 w-5 rounded-full bg-ink ${alerts ? 'ml-auto' : ''}`}
                          />
                        </button>
                      ) : null}
                      {'toggle' in r ? (
                        <span className="w-[15px]" />
                      ) : (
                        <>
                          {'value' in r && r.value && (
                            <span className="font-mono text-[12px] text-white/45">{r.value}</span>
                          )}
                          <ChevronRight size={15} className="text-white/25" />
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </motion.section>
          ))}
        </div>
      </div>
    </div>
  )
}
