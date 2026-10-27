export type SubSection = {
  title?: string
  body?: string
  rows?: { label: string; value?: string; toggle?: boolean }[]
}

export type SubPageContent = {
  kicker: string
  title: string
  sections: SubSection[]
  action?: string
}

export const subpages: Record<string, SubPageContent> = {
  'passkey-wallet': {
    kicker: 'security',
    title: 'Passkey wallet',
    sections: [
      {
        body: 'Your signing key is generated inside the device secure enclave and never leaves it. Gizu stores only the public half.',
      },
      {
        title: 'This device',
        rows: [
          { label: 'Created', value: '12 Sep 2026' },
          { label: 'Device', value: 'iPhone 17 Pro' },
          { label: 'Method', value: 'Face ID' },
          { label: 'Address', value: '0xA4f2 . . . 91c7' },
        ],
      },
      {
        title: 'Recovery',
        rows: [
          { label: 'Backup passkey', value: 'Not set' },
          { label: 'Guardian address', value: 'Not set' },
        ],
      },
    ],
    action: 'Add backup passkey',
  },
  'transaction-signing': {
    kicker: 'security',
    title: 'Transaction signing',
    sections: [
      { body: 'Choose what Gizu asks for before an order is broadcast.' },
      {
        title: 'Require biometrics',
        rows: [
          { label: 'Every order', toggle: true },
          { label: 'Above $10,000 only' },
          { label: 'Withdrawals only' },
        ],
      },
      {
        title: 'Limits',
        rows: [
          { label: 'Daily cap', value: '$250,000' },
          { label: 'Per order cap', value: '$100,000' },
          { label: 'Cooldown', value: '30 seconds' },
        ],
      },
    ],
  },
  currency: {
    kicker: 'preferences',
    title: 'Currency',
    sections: [
      {
        title: 'Display currency',
        rows: [
          { label: 'USD', value: 'Selected' },
          { label: 'EUR' },
          { label: 'GBP' },
          { label: 'TRY' },
        ],
      },
      { body: 'Vault units are always settled in USDC. This setting changes display only.' },
    ],
  },
  statements: {
    kicker: 'preferences',
    title: 'Statements',
    sections: [
      {
        title: 'Delivery',
        rows: [
          { label: 'Monthly', value: 'Selected' },
          { label: 'Quarterly' },
          { label: 'On request' },
        ],
      },
      {
        title: 'Archive',
        rows: [
          { label: 'August 2026', value: 'PDF' },
          { label: 'July 2026', value: 'PDF' },
          { label: 'June 2026', value: 'PDF' },
        ],
      },
    ],
    action: 'Request statement',
  },
  'contact-desk': {
    kicker: 'support',
    title: 'Contact desk',
    sections: [
      { body: 'Your relationship desk answers within one business hour, 24 hours on settlement days.' },
      {
        title: 'Channels',
        rows: [
          { label: 'Secure message', value: 'Open' },
          { label: 'Voice callback', value: 'Book' },
          { label: 'desk@gizu.capital' },
        ],
      },
      {
        title: 'Your desk',
        rows: [
          { label: 'Coverage', value: 'EMEA' },
          { label: 'Hours', value: '07:00 to 22:00 GMT' },
        ],
      },
    ],
    action: 'Start secure message',
  },
  terms: {
    kicker: 'support',
    title: 'Terms and disclosures',
    sections: [
      {
        body: 'Confidential vaults are offered to qualified members only. Capital is at risk, past performance does not indicate future results, and redemption windows may be suspended under stressed conditions.',
      },
      {
        title: 'Documents',
        rows: [
          { label: 'Member agreement', value: 'PDF' },
          { label: 'Risk disclosure', value: 'PDF' },
          { label: 'Privacy policy', value: 'PDF' },
          { label: 'Fee schedule', value: 'PDF' },
        ],
      },
    ],
  },
  activity: {
    kicker: 'history',
    title: 'Activity',
    sections: [
      {
        title: 'September',
        rows: [
          { label: 'Bought HLX', value: '$25,000.00' },
          { label: 'Sold OBS', value: '$8,400.00' },
          { label: 'Bought MRD', value: '$50,000.00' },
          { label: 'Deposit USDC', value: '$120,000.00' },
        ],
      },
      {
        title: 'August',
        rows: [
          { label: 'Bought VTX', value: '$64,000.00' },
          { label: 'Distribution OBS', value: '$2,145.60' },
          { label: 'Withdrawal USDC', value: '$30,000.00' },
        ],
      },
    ],
  },
}

export const notifications = [
  {
    id: 'n1',
    tag: 'fill',
    title: 'Order filled',
    body: '13,630.10 HLX bought at $1.8342',
    time: '14:02',
    unread: true,
  },
  {
    id: 'n2',
    tag: 'vault',
    title: 'Vertex Quant reopened',
    body: 'Allocation window closes in 48 hours',
    time: '11:20',
    unread: true,
  },
  {
    id: 'n3',
    tag: 'report',
    title: 'August statement ready',
    body: 'Net return 3.84 percent across three vaults',
    time: 'Yesterday',
    unread: false,
  },
  {
    id: 'n4',
    tag: 'security',
    title: 'Passkey used',
    body: 'Signed from iPhone 17 Pro, Istanbul',
    time: 'Yesterday',
    unread: false,
  },
  {
    id: 'n5',
    tag: 'vault',
    title: 'Obsidian Credit distribution',
    body: '$2,145.60 credited to your balance',
    time: '18 Sep',
    unread: false,
  },
]

/** Demo account identity, shown wherever the signed-in member appears. */
export const profile = {
  name: 'Cankat Polat',
  firstName: 'Cankat',
  initials: 'CP',
  address: '0xA4f2…91c7',
}

/** Greeting from the visitor's clock (Kurage greeting). */
export function greeting(hour = new Date().getHours()) {
  if (hour < 5) return 'Good night'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}
