export type AccessPlatform = 'ios' | 'android'
export type AccessSource =
  'landing-hero' | 'landing-footer' | 'landing-ios' | 'landing-android'
export type AccessRequest = { platform?: AccessPlatform; source: AccessSource }
export type EarlyAccessInput = AccessRequest & {
  email: string
  consent: boolean
}
export type EarlyAccessConfig = { endpoint?: string }

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}
export function validEmail(email: string) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/** The Gizu API owns validation and persistence. */
export async function requestEarlyAccess(
  input: EarlyAccessInput,
  config: EarlyAccessConfig,
  signal?: AbortSignal,
  send: typeof fetch = fetch
): Promise<void> {
  const email = normalizeEmail(input.email)
  if (!validEmail(email)) throw new Error('Enter a valid email address.')
  if (!input.consent)
    throw new Error(
      'Please agree to receive your invitation and access updates.'
    )
  if (!config.endpoint?.trim())
    throw new Error(
      'The invitation list is not open yet. Please check back soon.'
    )
  const requestSignal = AbortSignal.any([
    AbortSignal.timeout(20_000),
    ...(signal ? [signal] : [])
  ])
  let response: Response
  try {
    response = await send(config.endpoint.trim(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        platform: input.platform,
        source: input.source,
        consent: true,
        consentVersion: '2026-11-17'
      }),
      signal: requestSignal
    })
  } catch {
    if (signal?.aborted)
      throw new DOMException('Request cancelled', 'AbortError')
    throw new Error(
      requestSignal.aborted
        ? 'We could not confirm your signup in time. Please try again.'
        : 'We could not reach the invitation service. Please try again.'
    )
  }
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? 'Too many attempts. Please wait a minute and try again.'
        : 'We could not save your email. Please try again.'
    )
  const result: unknown = await response.json().catch(() => null)
  if (
    !result ||
    typeof result !== 'object' ||
    !('status' in result) ||
    result.status !== 'registered'
  ) {
    throw new Error('We could not confirm your signup. Please try again.')
  }
}
