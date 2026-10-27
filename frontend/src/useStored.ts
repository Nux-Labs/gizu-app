import { useState } from 'react'

/** A boolean UI preference kept in localStorage (per browser). Storage may be blocked; fall back to state. */
export default function useStored(key: string, initial: boolean) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : raw === '1'
    } catch {
      return initial
    }
  })
  const set = (next: boolean) => {
    setValue(next)
    try {
      localStorage.setItem(key, next ? '1' : '0')
    } catch {
      // ponytail: blocked storage only loses persistence, not the toggle
    }
  }
  return [value, set] as const
}
