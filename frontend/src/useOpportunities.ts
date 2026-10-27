import { useEffect, useState } from 'react'
import {
  getOpportunity,
  listOpportunities,
  type OpportunityDetail,
  type OpportunityPage,
  type ProtocolSelection,
} from './opportunities'

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; page: OpportunityPage }
  | { kind: 'failed'; message: string; retry: () => void }

type DetailLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; opportunity: OpportunityDetail }
  | { kind: 'failed'; message: string }

export function useOpportunities(query: {
  protocol: ProtocolSelection
  search: string
  page: number
  items: number
  chainId: number
}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoad({ kind: 'loading' })
    listOpportunities(query, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) {
          return
        }
        setLoad({ kind: 'ready', page })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) {
          return
        }
        if (err instanceof DOMException && err.name === 'AbortError') {
          return
        }
        setLoad({
          kind: 'failed',
          message: 'Could not load vaults',
          retry: () => setAttempt((n) => n + 1),
        })
      })
    return () => controller.abort()
  }, [query.protocol, query.search, query.page, query.items, query.chainId, attempt])

  return load
}

export function useOpportunity(id: string) {
  const [load, setLoad] = useState<DetailLoad>({ kind: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    setLoad({ kind: 'loading' })
    getOpportunity(id)
      .then((opportunity) => {
        if (controller.signal.aborted) {
          return
        }
        setLoad({ kind: 'ready', opportunity })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) {
          return
        }
        if (err instanceof DOMException && err.name === 'AbortError') {
          return
        }
        setLoad({ kind: 'failed', message: 'Could not load vault' })
      })
    return () => controller.abort()
  }, [id])

  return load
}
