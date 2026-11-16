import test from 'node:test'
import assert from 'node:assert/strict'
import { applyDemoTransaction, INITIAL_WALLET, parseDemoAmount } from '../src/components/demo/demoModel.ts'

test('parses demo amounts as integer cents and rejects invalid/negative precision', () => {
  assert.equal(parseDemoAmount('250'), 25000)
  assert.equal(parseDemoAmount('0.01'), 1)
  assert.equal(parseDemoAmount(' 15.5 '), 1550)
  for (const value of ['0', '-1', '1.001', '1e3', 'NaN', '', '.', '10000000']) assert.equal(parseDemoAmount(value), null)
})
test('investing conserves portfolio value and records the demo action', () => {
  const initial = { ...INITIAL_WALLET, activity: [] }
  const next = applyDemoTransaction(initial, { kind: 'invest', cents: 25000, name: 'USDC Prime' })
  assert.equal(next.available, initial.available - 25000)
  assert.equal(next.invested, initial.invested + 25000)
  assert.equal(next.available + next.invested + next.stock, initial.available + initial.invested + initial.stock)
  assert.equal(next.activity[0].name, 'USDC Prime')
  assert.equal(initial.activity.length, 0)
})
test('receiving, sending and swapping update only the corresponding balances', () => {
  const funded = applyDemoTransaction(INITIAL_WALLET, { kind: 'receive', cents: 10000, name: 'Receive USDC' })
  const sent = applyDemoTransaction(funded, { kind: 'send', cents: 5000, name: 'Send USDC' })
  const swapped = applyDemoTransaction(sent, { kind: 'swap', cents: 20000, name: 'Buy AAPL' })
  assert.equal(swapped.available, INITIAL_WALLET.available + 10000 - 5000 - 20000)
  assert.equal(swapped.stock, INITIAL_WALLET.stock + 20000)
  assert.equal(swapped.invested, INITIAL_WALLET.invested)
  assert.equal(swapped.activity.length, 3)
})
test('cannot spend beyond available funds or accept fractional cents', () => {
  for (const cents of [INITIAL_WALLET.available + 1, 1.5, -1, 0, NaN]) assert.throws(() => applyDemoTransaction(INITIAL_WALLET, { kind: 'invest', cents, name: 'USDC Prime' }))
})
