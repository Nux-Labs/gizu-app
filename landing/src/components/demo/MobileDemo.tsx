import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from 'react'
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Eye,
  Fingerprint,
  House,
  LockKeyhole,
  MoreHorizontal,
  PieChart,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Signal,
  Wifi,
  type LucideIcon
} from 'lucide-react'
import AsciiChameleon from '../../chameleon/AsciiChameleon'
import DemoChart from './DemoChart'
import {
  applyDemoTransaction,
  DEMO_VAULTS,
  demoMoney,
  INITIAL_WALLET,
  parseDemoAmount,
  type DemoScreen,
  type DemoTransaction
} from './demoModel'

const TABS: { screen: DemoScreen; label: string; icon: LucideIcon }[] = [
  { screen: 'home', label: 'Home', icon: House },
  { screen: 'earn', label: 'Earn', icon: PieChart },
  { screen: 'swap', label: 'Swap', icon: ArrowLeftRight },
  { screen: 'settings', label: 'Settings', icon: Settings }
]
const BACK: Partial<Record<DemoScreen, DemoScreen>> = {
  vault: 'earn',
  invest: 'vault',
  review: 'invest',
  'swap-review': 'swap',
  receive: 'home',
  send: 'home',
  activity: 'home',
  complete: 'home'
}

function DemoButton({
  children,
  onClick,
  secondary = false,
  disabled = false,
  type = 'button'
}: {
  children: ReactNode
  onClick?: () => void
  secondary?: boolean
  disabled?: boolean
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`demo-button ${secondary ? 'is-secondary' : ''}`}
    >
      {children}
    </button>
  )
}

/** Browser demo of the native screens. All data and approvals stay in local memory. */
export default function MobileDemo({
  initialScreen = 'welcome'
}: {
  initialScreen?: DemoScreen
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const confirming = useRef(false)
  const [scale, setScale] = useState(1)
  const [screen, setScreen] = useState<DemoScreen>(initialScreen)
  const [wallet, setWallet] = useState(() => ({
    ...INITIAL_WALLET,
    activity: [] as DemoTransaction[]
  }))
  const [selected, setSelected] = useState<(typeof DEMO_VAULTS)[number]>(
    DEMO_VAULTS[0]
  )
  const [amount, setAmount] = useState('250')
  const [query, setQuery] = useState('')
  const [protocol, setProtocol] = useState('All')
  const [range, setRange] = useState('1M')
  const [performance, setPerformance] = useState(false)
  const [privateBalance, setPrivateBalance] = useState(false)
  const [mode, setMode] = useState<'buy' | 'sell'>('buy')
  const [token, setToken] = useState('AAPL')
  const [error, setError] = useState('')
  const uid = useId()
  const total = wallet.available + wallet.invested + wallet.stock

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setScale(entry.contentRect.width / 390)
    )
    if (viewport.current) observer.observe(viewport.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    scroll.current?.scrollTo({ top: 0 })
    confirming.current = false
  }, [screen])

  function go(next: DemoScreen) {
    setError('')
    setScreen(next)
  }
  function review(event: FormEvent) {
    event.preventDefault()
    const cents = parseDemoAmount(amount)
    const available =
      screen === 'swap' && mode === 'sell' ? wallet.stock : wallet.available
    if (!cents || cents > available) {
      setError(
        !cents
          ? 'Enter a positive amount with up to two decimals.'
          : 'Not enough demo funds. Try a smaller amount.'
      )
      return
    }
    go(screen === 'swap' ? 'swap-review' : 'review')
  }
  function transact(kind: DemoTransaction['kind'], name: string) {
    if (confirming.current) return
    const cents = parseDemoAmount(amount)
    if (!cents) {
      setError('Enter a valid amount.')
      return
    }
    try {
      const next = applyDemoTransaction(wallet, { kind, cents, name })
      confirming.current = true
      setWallet(next)
      go('complete')
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Try a smaller amount.'
      )
    }
  }
  function sell() {
    if (confirming.current) return
    const cents = parseDemoAmount(amount)
    if (!cents || cents > wallet.stock) {
      setError('Not enough demo assets.')
      return
    }
    confirming.current = true
    setWallet({
      ...wallet,
      stock: wallet.stock - cents,
      available: wallet.available + cents,
      activity: [
        { kind: 'swap', cents, name: `Sell ${token}` },
        ...wallet.activity
      ]
    })
    go('complete')
  }
  const tab = ['vault', 'invest', 'review'].includes(screen)
    ? 'earn'
    : screen === 'swap-review'
      ? 'swap'
      : ['receive', 'send', 'activity', 'complete'].includes(screen)
        ? 'home'
        : screen
  const filtered = DEMO_VAULTS.filter(
    (vault) =>
      (protocol === 'All' || vault.protocol === protocol) &&
      `${vault.name} ${vault.protocol} ${vault.chain}`
        .toLowerCase()
        .includes(query.toLowerCase())
  )
  const header = (title: string, extra?: ReactNode) => (
    <div className="demo-page-heading">
      {BACK[screen] && (
        <button
          type="button"
          className="demo-icon-button"
          aria-label="Back in demo"
          onClick={() => go(BACK[screen]!)}
        >
          <ArrowLeft size={19} />
        </button>
      )}
      <h2>{title}</h2>
      {extra}
    </div>
  )
  const amountInput = (label = 'Amount in USDC') => (
    <label className="demo-amount">
      <span>{label}</span>
      <div>
        <input
          aria-label={label}
          inputMode="decimal"
          autoComplete="off"
          maxLength={10}
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value)
            setError('')
          }}
        />
        <span>USDC</span>
      </div>
      <small>Available: {demoMoney(wallet.available)}</small>
    </label>
  )

  return (
    <div
      ref={viewport}
      className="demo-viewport"
      role="region"
      aria-label="Gizu interactive app demo"
      data-lenis-prevent
    >
      <div
        className="demo-canvas"
        style={{ transform: `scale(${scale})` }}
        data-demo-screen={screen}
      >
        <div className="demo-status" aria-hidden="true">
          <span>9:41</span>
          <div>
            <Signal size={14} />
            <Wifi size={14} />
            <span className="demo-battery" />
          </div>
        </div>
        <div
          ref={scroll}
          className={`demo-scroll ${screen === 'welcome' ? 'is-welcome' : ''}`}
        >
          {screen === 'welcome' ? (
            <>
              <div className="demo-wordmark">
                <img src="/gizulogo.svg" alt="" />
                Gizu<span>Demo</span>
              </div>
              <div className="demo-welcome-art" aria-hidden="true">
                <AsciiChameleon grid={false} size={0.2} paused />
              </div>
              <div className="demo-welcome-copy">
                <h2>
                  <span>DeFi</span> in
                  <br />
                  <span>Stealth</span> Mode
                </h2>
                <p>
                  Explore investments. Protect your privacy. Stay in control.
                </p>
                <DemoButton onClick={() => go('home')}>
                  <Fingerprint size={21} />
                  Continue with passkey
                  <ArrowRight size={18} />
                </DemoButton>
                <p className="demo-disclosure">
                  Demo access. No wallet or passkey needed.
                </p>
              </div>
            </>
          ) : null}

          {screen === 'home' ? (
            <>
              <div className="demo-home-hero">
                <div className="demo-home-top">
                  <img src="/gizulogo.svg" alt="Gizu" />
                  <span className="demo-mark">Demo</span>
                  <button
                    type="button"
                    aria-label="Demo notifications"
                    className="demo-icon-button"
                    onClick={() => go('activity')}
                  >
                    <Bell size={18} />
                  </button>
                </div>
                <div className="demo-mascot" aria-hidden="true">
                  <AsciiChameleon grid={false} size={0.19} paused />
                </div>
                <h2>Your portfolio</h2>
              </div>
              <section className="demo-surface demo-balance">
                <div className="demo-between">
                  <span>Total balance</span>
                  <button
                    type="button"
                    onClick={() => setPerformance((value) => !value)}
                  >
                    Performance
                    <ChevronDown size={13} />
                  </button>
                </div>
                <div className="demo-total">
                  {privateBalance ? '••••••' : demoMoney(total).slice(1)}
                  <small> USD</small>
                </div>
                <p className="demo-positive">
                  +3.84% <span>in the last month</span>
                </p>
                <div className="demo-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setAmount('250')
                      go('receive')
                    }}
                  >
                    <ArrowDownLeft size={17} />
                    Receive
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAmount('100')
                      go('send')
                    }}
                  >
                    <ArrowUpRight size={17} />
                    Send
                  </button>
                  <button
                    type="button"
                    aria-label="View demo activity"
                    onClick={() => go('activity')}
                  >
                    <MoreHorizontal size={19} />
                  </button>
                </div>
                <DemoChart compact={!performance} range={range} />
                {performance && (
                  <div className="demo-ranges">
                    {['1D', '1W', '1M', '1Y'].map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={range === value}
                        onClick={() => setRange(value)}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                )}
              </section>
              <div className="demo-section-title">
                <h3>Your vaults</h3>
                <button type="button" onClick={() => go('earn')}>
                  See all
                  <ArrowRight size={13} />
                </button>
              </div>
              <button
                type="button"
                className="demo-surface demo-holding"
                onClick={() => {
                  setSelected(DEMO_VAULTS[0])
                  go('vault')
                }}
              >
                <img src="/logos/morpho.png" alt="" />
                <div>
                  <strong>Morpho USDC</strong>
                  <small>Ethereum</small>
                </div>
                <div>
                  <strong>
                    {privateBalance ? '••••' : demoMoney(wallet.invested)}
                  </strong>
                  <small className="demo-positive">6.10% demo APR</small>
                </div>
              </button>
              <div className="demo-section-title">
                <h3>Assets</h3>
              </div>
              <div className="demo-surface">
                <button
                  type="button"
                  className="demo-holding"
                  onClick={() => go('swap')}
                >
                  <img src="/logos/usdc.png" alt="" />
                  <div>
                    <strong>USDC</strong>
                    <small>Available balance</small>
                  </div>
                  <strong>
                    {privateBalance ? '••••' : demoMoney(wallet.available)}
                  </strong>
                </button>
                <button
                  type="button"
                  className="demo-holding demo-divider"
                  onClick={() => go('swap')}
                >
                  <span className="demo-token-mark">A</span>
                  <div>
                    <strong>Tokenized stocks</strong>
                    <small>Sample holdings</small>
                  </div>
                  <strong>
                    {privateBalance ? '••••' : demoMoney(wallet.stock)}
                  </strong>
                </button>
              </div>
            </>
          ) : null}

          {screen === 'earn' ? (
            <>
              {header('Earn')}
              <p className="demo-muted demo-intro">
                Earn yield on your USDC with selected vaults.
              </p>
              <div
                className="demo-filters"
                role="group"
                aria-label="Demo protocol filter"
              >
                {['All', 'Morpho', 'Curvance', 'Aave'].map((value) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={protocol === value}
                    onClick={() => setProtocol(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
              <label className="demo-search">
                <Search size={17} />
                <input
                  aria-label="Search demo vaults"
                  value={query}
                  placeholder="Search opportunities"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="demo-vault-list">
                {filtered.map((vault) => (
                  <button
                    key={vault.id}
                    type="button"
                    className="demo-surface demo-vault-card"
                    onClick={() => {
                      setSelected(vault)
                      go('vault')
                    }}
                  >
                    <div className="demo-between">
                      <img src={vault.logo} alt="" />
                      <span>{vault.chain}</span>
                    </div>
                    <h3>{vault.name}</h3>
                    <p>{vault.protocol}</p>
                    <DemoChart compact />
                    <div className="demo-between">
                      <div>
                        <small>TVL</small>
                        <strong>{vault.tvl}</strong>
                      </div>
                      <div className="demo-align-right">
                        <small>Demo APR</small>
                        <strong className="demo-positive">{vault.apr}%</strong>
                      </div>
                    </div>
                  </button>
                ))}
                {!filtered.length && (
                  <p className="demo-empty">
                    No vaults match your filters.
                    <button
                      type="button"
                      onClick={() => {
                        setQuery('')
                        setProtocol('All')
                      }}
                    >
                      Clear filters
                    </button>
                  </p>
                )}
              </div>
            </>
          ) : null}

          {screen === 'vault' ? (
            <>
              {header('Vault details')}
              <section className="demo-surface demo-vault-detail">
                <div className="demo-vault-identity">
                  <img src={selected.logo} alt="" />
                  <div>
                    <h3>{selected.name}</h3>
                    <p>
                      {selected.protocol} / {selected.chain}
                    </p>
                  </div>
                </div>
                <div className="demo-between demo-detail-rate">
                  <div>
                    <small>Demo APR</small>
                    <strong>{selected.apr}%</strong>
                  </div>
                  <div className="demo-align-right">
                    <small>TVL</small>
                    <b>{selected.tvl}</b>
                  </div>
                </div>
                <DemoChart />
                <div className="demo-split-actions">
                  <DemoButton
                    onClick={() => {
                      setAmount('250')
                      go('invest')
                    }}
                  >
                    Invest
                    <ArrowUpRight size={16} />
                  </DemoButton>
                  <DemoButton secondary onClick={() => go('home')}>
                    Your position
                  </DemoButton>
                </div>
              </section>
              <h3 className="demo-heading-small">About this vault</h3>
              <p className="demo-muted">{selected.description}</p>
              <dl className="demo-details">
                <div>
                  <dt>Underlying asset</dt>
                  <dd>{selected.asset}</dd>
                </div>
                <div>
                  <dt>Network</dt>
                  <dd>{selected.chain}</dd>
                </div>
                <div>
                  <dt>Protocol</dt>
                  <dd>{selected.protocol}</dd>
                </div>
              </dl>
              <div className="demo-note">
                <ShieldCheck size={18} />
                <p>
                  Review rates, fees and risks before investing. Values shown
                  here are illustrative.
                </p>
              </div>
            </>
          ) : null}

          {screen === 'invest' ? (
            <>
              {header('Invest')}
              <p className="demo-muted demo-intro">
                {selected.name} / {selected.protocol}
              </p>
              <form onSubmit={review}>
                <div className="demo-surface demo-padding">
                  {amountInput()}
                  <div className="demo-amount-options">
                    {['100', '250', '500'].map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setAmount(value)}
                      >
                        ${value}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        setAmount((wallet.available / 100).toFixed(2))
                      }
                    >
                      Max
                    </button>
                  </div>
                </div>
                <div className="demo-note">
                  <LockKeyhole size={18} />
                  <p>
                    Your investment starts from a confidential balance. This
                    preview simulates the flow.
                  </p>
                </div>
                {error && (
                  <p className="demo-error" role="alert">
                    {error}
                  </p>
                )}
                <DemoButton type="submit">
                  Review investment
                  <ArrowRight size={17} />
                </DemoButton>
              </form>
            </>
          ) : null}

          {screen === 'review' || screen === 'swap-review' ? (
            <>
              {header(
                screen === 'review' ? 'Review investment' : 'Review swap'
              )}
              <div className="demo-review-icon">
                <ShieldCheck size={35} />
              </div>
              <div className="demo-review-amount">
                {demoMoney(parseDemoAmount(amount) ?? 0)}
              </div>
              <p className="demo-review-subtitle">
                {screen === 'review'
                  ? selected.name
                  : `${mode === 'buy' ? 'Buy' : 'Sell'} ${token}`}
              </p>
              <dl className="demo-details demo-surface demo-padding">
                <div>
                  <dt>Pay with</dt>
                  <dd>
                    {screen === 'review' || mode === 'buy' ? 'USDC' : token}
                  </dd>
                </div>
                <div>
                  <dt>Network</dt>
                  <dd>
                    {screen === 'review' ? selected.chain : 'Robinhood Chain'}
                  </dd>
                </div>
                <div>
                  <dt>Approval</dt>
                  <dd>Your passkey</dd>
                </div>
                <div>
                  <dt>Network fee</dt>
                  <dd>Simulated</dd>
                </div>
              </dl>
              <div className="demo-note">
                <Fingerprint size={21} />
                <p>
                  In the app, your device asks for a passkey. Here you can
                  approve a sample transaction.
                </p>
              </div>
              {error && (
                <p className="demo-error" role="alert">
                  {error}
                </p>
              )}
              <DemoButton
                onClick={() =>
                  screen === 'review'
                    ? transact('invest', selected.name)
                    : mode === 'buy'
                      ? transact('swap', `Buy ${token}`)
                      : sell()
                }
              >
                <Fingerprint size={19} />
                Confirm demo {screen === 'review' ? 'investment' : 'swap'}
              </DemoButton>
            </>
          ) : null}

          {screen === 'complete' ? (
            <div className="demo-complete">
              <div className="demo-review-icon">
                <CheckCheck size={40} />
              </div>
              <h2>All set.</h2>
              <p>{wallet.activity[0]?.name ?? 'Demo transaction'} completed.</p>
              <strong>{demoMoney(wallet.activity[0]?.cents ?? 0)}</strong>
              <p className="demo-muted">
                This was a demo. No real funds moved.
              </p>
              <DemoButton onClick={() => go('home')}>
                Back to portfolio
                <ArrowRight size={18} />
              </DemoButton>
              <button
                className="demo-text-button"
                type="button"
                onClick={() => go('activity')}
              >
                View activity
              </button>
            </div>
          ) : null}

          {screen === 'swap' ? (
            <>
              {header('Swap')}
              <div className="demo-filters demo-swap-mode">
                {(['buy', 'sell'] as const).map((value) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={mode === value}
                    onClick={() => {
                      setMode(value)
                      setError('')
                    }}
                  >
                    {value === 'buy' ? 'Buy' : 'Sell'}
                  </button>
                ))}
              </div>
              <form onSubmit={review}>
                <div className="demo-surface demo-padding">
                  {amountInput(mode === 'buy' ? 'You pay' : 'Value to sell')}
                  <div className="demo-swap-divider">
                    <ArrowDown size={17} />
                  </div>
                  <label className="demo-select-label">
                    <span>
                      {mode === 'buy' ? 'You receive' : 'Asset to sell'}
                    </span>
                    <select
                      aria-label="Demo swap token"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                    >
                      <option value="AAPL">AAPL / Apple</option>
                      <option value="NVDA">NVDA / NVIDIA</option>
                      <option value="TSLA">TSLA / Tesla</option>
                    </select>
                  </label>
                  <p className="demo-muted demo-swap-network">
                    Robinhood Chain
                  </p>
                </div>
                <div className="demo-note">
                  <ShieldCheck size={18} />
                  <p>
                    Tokenized stock preview. Prices and settlement are
                    simulated.
                  </p>
                </div>
                {error && (
                  <p className="demo-error" role="alert">
                    {error}
                  </p>
                )}
                <DemoButton type="submit">
                  Review swap
                  <ArrowRight size={17} />
                </DemoButton>
              </form>
            </>
          ) : null}

          {screen === 'receive' || screen === 'send' ? (
            <>
              {header(screen === 'receive' ? 'Receive USDC' : 'Send USDC')}
              <p className="demo-muted demo-intro">
                {screen === 'receive'
                  ? 'Add sample funds to explore the app.'
                  : 'Try sending sample USDC from your available balance.'}
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  transact(
                    screen === 'receive' ? 'receive' : 'send',
                    screen === 'receive' ? 'Receive USDC' : 'Send USDC'
                  )
                }}
              >
                <div className="demo-surface demo-padding">
                  {amountInput()}
                  {screen === 'send' && (
                    <label className="demo-select-label">
                      <span>Recipient</span>
                      <input
                        aria-label="Demo recipient"
                        value="Demo recipient"
                        readOnly
                      />
                    </label>
                  )}
                </div>
                <div className="demo-note">
                  <ShieldCheck size={18} />
                  <p>
                    {screen === 'receive'
                      ? 'Demo funds only. Do not send real assets to this preview.'
                      : 'No transfer is submitted to a network.'}
                  </p>
                </div>
                {error && (
                  <p className="demo-error" role="alert">
                    {error}
                  </p>
                )}
                <DemoButton type="submit">
                  {screen === 'receive' ? 'Add demo funds' : 'Send demo funds'}
                  <ArrowRight size={17} />
                </DemoButton>
              </form>
            </>
          ) : null}

          {screen === 'activity' ? (
            <>
              {header('Activity')}
              <p className="demo-muted demo-intro">
                Your demo transactions, in one place.
              </p>
              <div className="demo-surface">
                {wallet.activity.length ? (
                  wallet.activity.map((item, index) => (
                    <div key={index} className="demo-activity-row">
                      <div className="demo-activity-icon">
                        <Check size={18} />
                      </div>
                      <div>
                        <strong>{item.name}</strong>
                        <small>Completed in demo</small>
                      </div>
                      <strong>{demoMoney(item.cents)}</strong>
                    </div>
                  ))
                ) : (
                  <div className="demo-empty">
                    <CheckCheck size={28} />
                    <h3>Nothing here yet.</h3>
                    <p>Try an investment, swap or transfer.</p>
                    <button type="button" onClick={() => go('earn')}>
                      Explore vaults
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : null}

          {screen === 'settings' ? (
            <>
              {header('Settings')}
              <div className="demo-surface demo-profile">
                <span>G</span>
                <div>
                  <h3>Your Gizu wallet</h3>
                  <p>Demo account</p>
                </div>
              </div>
              <div className="demo-surface demo-settings">
                <div>
                  <Fingerprint size={19} />
                  <span>Passkey access</span>
                  <Check size={16} />
                </div>
                <label>
                  <Eye size={19} />
                  <span>Hide balances</span>
                  <input
                    type="checkbox"
                    checked={privateBalance}
                    onChange={(event) =>
                      setPrivateBalance(event.target.checked)
                    }
                    aria-label="Hide demo balances"
                  />
                </label>
                <div>
                  <ShieldCheck size={19} />
                  <span>Local demo session</span>
                  <Check size={16} />
                </div>
              </div>
              <div className="demo-note">
                <LockKeyhole size={18} />
                <p>
                  All sample balances and actions stay in this page. Reloading
                  resets the demo.
                </p>
              </div>
              <DemoButton
                secondary
                onClick={() => {
                  setWallet({ ...INITIAL_WALLET, activity: [] })
                  setPrivateBalance(false)
                  setMode('buy')
                  setAmount('250')
                  go('welcome')
                }}
              >
                <RotateCcw size={17} />
                Restart demo
              </DemoButton>
            </>
          ) : null}
        </div>
        {screen !== 'welcome' && (
          <nav className="demo-tabs" aria-label="Demo app navigation">
            {TABS.map(({ screen: destination, label, icon: Icon }) => (
              <button
                type="button"
                key={destination}
                aria-current={tab === destination ? 'page' : undefined}
                onClick={() => go(destination)}
              >
                <Icon size={19} strokeWidth={1.7} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        )}
        <div className="demo-home-indicator" aria-hidden="true" />
        <span className="sr-only" id={`${uid}-note`}>
          Interactive demonstration. All balances, rates and transactions are
          simulated.
        </span>
      </div>
    </div>
  )
}
