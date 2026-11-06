package io.gizu.storedwallet

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest

internal const val NATIVE_REVIEW_TIMEOUT_MS = 300_000L

internal class NativeCeremonyTimeout(val reviewExpired: Boolean) : CancellationException()

internal class NativeCeremonySession(private val workTimeoutMs: Long) {
  private data class Phase(val sequence: Long, val reviewing: Boolean)

  private val phase = MutableStateFlow(Phase(0, false))

  /** Network work and visible review each receive their own bounded window. */
  suspend fun <T> run(block: suspend () -> T): T = coroutineScope {
    val work = async(start = CoroutineStart.LAZY) { block() }
    val watchdog =
      launch(start = CoroutineStart.UNDISPATCHED) {
        phase.collectLatest { current ->
          delay(if (current.reviewing) NATIVE_REVIEW_TIMEOUT_MS else workTimeoutMs)
          work.cancel(NativeCeremonyTimeout(current.reviewing))
        }
      }
    try {
      work.await()
    } finally {
      watchdog.cancel()
    }
  }

  suspend fun <T> review(block: suspend () -> T): T {
    phase.value = Phase(phase.value.sequence + 1, true)
    try {
      return block()
    } finally {
      phase.value = Phase(phase.value.sequence + 1, false)
    }
  }
}
