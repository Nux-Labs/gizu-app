type InvitationRequest = {
  email: string
  investmentRange?: string
  platforms?: string[]
  otherPlatform?: string
}

export async function requestInvitation(input: InvitationRequest, apiUrl: string): Promise<void> {
  // A hosted backend can take longer to respond while starting after an idle period.
  const signal = AbortSignal.timeout(90_000)
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/early-access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  }).catch(() => {
    throw new Error(signal.aborted
      ? 'We couldn’t confirm your signup in time. Please try again.'
      : 'We couldn’t reach the signup service. Please try again.')
  })
  if (!response.ok) {
    throw new Error(response.status === 429
      ? 'Too many attempts. Please wait a minute and try again.'
      : 'We couldn’t save your email. Please try again.')
  }
  const result: unknown = await response.json().catch(() => null)
  if (!result || typeof result !== 'object' || !('status' in result) || result.status !== 'registered') {
    throw new Error('We couldn’t confirm your signup. Please try again.')
  }
}
