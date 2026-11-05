import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requestInvitation } from '../src/earlyAccess.ts'

test('invitation requests send the email to the configured backend', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.example/v1/early-access')
    assert.equal(options?.method, 'POST')
    assert.deepEqual(JSON.parse(options?.body as string), { email: 'tester@example.com' })
    return Response.json({ status: 'registered' })
  }
  try { await requestInvitation({ email: 'tester@example.com' }, 'https://api.example/') }
  finally { globalThis.fetch = original }
})

test('failed or malformed responses cannot show signup success', async () => {
  const original = globalThis.fetch
  try {
    for (const response of [Response.json({ status: 'registered' }, { status: 503 }), Response.json({}), new Response('<html>Wrong host</html>')]) {
      globalThis.fetch = async () => response
      await assert.rejects(requestInvitation({ email: 'tester@example.com' }, 'https://api.example'))
    }
    globalThis.fetch = async () => { throw new TypeError('Network failed') }
    await assert.rejects(requestInvitation({ email: 'tester@example.com' }, 'https://api.example'), /reach the signup service/)
  } finally { globalThis.fetch = original }
})

test('a slow signup response can complete after the initial fifteen seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Put the platform deadline on the same controllable clock as the slow server.
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds)
    return controller.signal
  })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
      setTimeout(() => resolve(Response.json({ status: 'registered' })), 65_000)
    })
  })
  const signup = requestInvitation({ email: 'tester@example.com' }, 'https://api.example')
  t.mock.timers.tick(65_000)
  await signup
})

test('a stalled signup reports an unconfirmed timeout instead of blaming the connection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds)
    return controller.signal
  })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
    })
  })
  const signup = requestInvitation({ email: 'tester@example.com' }, 'https://api.example')
  const failure = assert.rejects(signup, /couldn’t confirm your signup in time/)
  t.mock.timers.tick(120_000)
  await failure
})
