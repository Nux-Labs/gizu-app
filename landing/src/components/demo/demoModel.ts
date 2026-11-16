export const DEMO_VAULTS = [
  {
    id: 'morpho',
    name: 'USDC Prime',
    protocol: 'Morpho',
    chain: 'Ethereum',
    asset: 'USDC',
    apr: '6.10',
    tvl: '$12.4M',
    logo: '/logos/morpho.png',
    description:
      'A USDC lending vault with a curated allocation across supported lending markets.'
  },
  {
    id: 'curvance',
    name: 'WMON Lending',
    protocol: 'Curvance',
    chain: 'Monad',
    asset: 'WMON',
    apr: '8.42',
    tvl: '$4.8M',
    logo: '/logos/curvance.png',
    description:
      'A Monad lending strategy. Review its underlying asset, curator and withdrawal terms.'
  },
  {
    id: 'aave',
    name: 'USDC Supply',
    protocol: 'Aave',
    chain: 'Ethereum',
    asset: 'USDC',
    apr: '4.75',
    tvl: '$31.0M',
    logo: '/logos/aave.png',
    description:
      'Supply USDC to a lending market. Variable rates and market liquidity affect withdrawals.'
  }
] as const
export type DemoScreen =
  | 'welcome'
  | 'home'
  | 'earn'
  | 'vault'
  | 'invest'
  | 'review'
  | 'complete'
  | 'swap'
  | 'swap-review'
  | 'settings'
  | 'receive'
  | 'send'
  | 'activity'
export type DemoTransaction = {
  kind: 'invest' | 'receive' | 'send' | 'swap'
  cents: number
  name: string
}
export type DemoWallet = {
  available: number
  invested: number
  stock: number
  activity: DemoTransaction[]
}
export const INITIAL_WALLET: DemoWallet = {
  available: 125050,
  invested: 764000,
  stock: 359475,
  activity: []
}
export const demoMoney = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    cents / 100
  )
export function parseDemoAmount(value: string): number | null {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!match) return null
  const amount =
    Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return amount > 0 ? amount : null
}
export function applyDemoTransaction(
  wallet: DemoWallet,
  transaction: DemoTransaction
): DemoWallet {
  if (!Number.isSafeInteger(transaction.cents) || transaction.cents <= 0)
    throw new Error(
      'Enter an amount greater than zero with up to two decimal places.'
    )
  if (transaction.kind !== 'receive' && transaction.cents > wallet.available)
    throw new Error('This amount exceeds your available demo balance.')
  return {
    available:
      wallet.available +
      (transaction.kind === 'receive' ? transaction.cents : -transaction.cents),
    invested:
      wallet.invested + (transaction.kind === 'invest' ? transaction.cents : 0),
    stock: wallet.stock + (transaction.kind === 'swap' ? transaction.cents : 0),
    activity: [transaction, ...wallet.activity]
  }
}
