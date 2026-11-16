import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEmail, requestEarlyAccess } from '../src/services/earlyAccess.ts'

const input = { email: '  HELLO@example.com  ', consent: true, platform: 'ios', source: 'landing-hero' }
const config = { endpoint: 'https://project.supabase.co/functions/v1/early-access', publishableKey: 'public-key' }

test('normalizes the email and sends only the agreed signup fields', async () => {
  let request
  await requestEarlyAccess(input, config, undefined, async (url, options) => {
    request = { url, ...options }
    return Response.json({ status: 'registered' }, { status: 201 })
  })
  assert.equal(normalizeEmail(input.email), 'hello@example.com')
  assert.equal(request.url, config.endpoint)
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.apikey, 'public-key')
  assert.deepEqual(JSON.parse(request.body), { email: 'hello@example.com', consent: true, platform: 'ios', source: 'landing-hero', consentVersion: '2026-11-16' })
})
test('rejects invalid email, absent consent and missing endpoint before networking', async () => {
  let called = false
  const send = async () => { called = true }
  for (const [payload, settings, message] of [
    [{ ...input, email: 'bad' }, config, /valid email/],
    [{ ...input, email: `${'a'.repeat(250)}@example.com` }, config, /valid email/],
    [{ ...input, consent: false }, config, /agree/],
    [input, {}, /not open yet/],
  ]) await assert.rejects(requestEarlyAccess(payload, settings, undefined, send), message)
  assert.equal(called, false)
})
test('does not report success for an unconfirmed or failed response', async () => {
  for (const [response, message] of [
    [Response.json({ ok: true }), /confirm/],
    [new Response('not-json'), /confirm/],
    [new Response('', { status: 429 }), /Too many/],
    [new Response('', { status: 500 }), /save your email/],
  ]) await assert.rejects(requestEarlyAccess(input, config, undefined, async () => response), message)
})
test('network failure stays retryable without exposing internals', async () => {
  await assert.rejects(requestEarlyAccess(input, config, undefined, async () => { throw new Error('internal details') }), /reach the invitation service/)
})
test('closing a pending request aborts it without a signup confirmation', async () => {
  const controller = new AbortController()
  const pending = requestEarlyAccess(input, config, controller.signal, async (_, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  }))
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
})
