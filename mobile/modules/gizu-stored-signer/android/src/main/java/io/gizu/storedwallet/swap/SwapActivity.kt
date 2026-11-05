package io.gizu.storedwallet.swap

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.ScrollView
import io.gizu.storedwallet.NativeStyle
import io.gizu.storedwallet.PasskeyGate
import io.gizu.storedwallet.WalletRecoveryRuntime
import io.gizu.storedwallet.walletStore
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

internal object SwapHost {
  var token: String? = null
    private set

  var screen: SwapActivity? = null
  private var completion: CancellableContinuation<Map<String, Any?>>? = null
  private var closing: Job? = null
  var target: String? = null
  var amountAtoms: String? = null
  var gateway: String? = null
  var resume: Boolean = false
  var sell: Boolean = false
  var payout: Boolean = false
  var recovery: Boolean = false
  var holdingId: String? = null
  var sweepTo: String? = null

  suspend fun open(
    activity: Activity,
    gateway: String,
    target: String?,
    amountAtoms: String?,
    resume: Boolean,
    sell: Boolean = false,
    payout: Boolean = false,
    recovery: Boolean = false,
    holdingId: String? = null,
    sweepTo: String? = null,
  ): Map<String, Any?> {
    try {
      return suspendCancellableCoroutine { continuation ->
        check(completion == null)
        token = UUID.randomUUID().toString()
        this.gateway = gateway
        this.target = target
        this.amountAtoms = amountAtoms
        this.resume = resume
        this.sell = sell
        this.payout = payout
        this.recovery = recovery
        this.holdingId = holdingId
        this.sweepTo = sweepTo
        completion = continuation
        continuation.invokeOnCancellation { activity.runOnUiThread { close(null) } }
        try {
          activity.startActivity(
            Intent(activity, SwapActivity::class.java).putExtra("token", token)
          )
        } catch (_: Exception) {
          close(null)
        }
      }
    } finally {
      withContext(NonCancellable) { closing?.join() }
      closing = null
    }
  }

  fun fail(message: String) {
    val result = completion
    completion = null
    token = null
    val current = screen
    screen = null
    fun done() {
      if (result?.isActive == true) result.resumeWithException(IllegalStateException(message))
    }
    if (current == null) done()
    else {
      current.stopWork()
      current.finish()
      closing =
        CoroutineScope(Dispatchers.Main.immediate).launch {
          current.awaitWork()
          done()
        }
    }
  }

  fun close(view: Map<String, Any?>?) {
    val result = completion
    completion = null
    token = null
    val current = screen
    screen = null
    fun done() {
      if (result?.isActive == true) {
        if (view != null) result.resume(view) else result.cancel()
      }
    }
    if (current == null) done()
    else {
      current.stopWork()
      current.finish()
      closing =
        CoroutineScope(Dispatchers.Main.immediate).launch {
          current.awaitWork()
          done()
        }
    }
  }
}

/** Native review for the whole confidential swap. Signed bytes stay in the encrypted swap file. */
class SwapActivity : Activity() {
  private val job = SupervisorJob()
  private val scope = CoroutineScope(job + Dispatchers.Main.immediate)
  private lateinit var root: LinearLayout
  private var engine: SwapEngine? = null
  private var providerPending = false
  private var stopped = false

  internal fun stopWork() {
    stopped = true
    engine?.close()
    job.cancel()
  }

  internal suspend fun awaitWork() {
    job.join()
  }

  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    if (
      state != null || SwapHost.token == null || intent.getStringExtra("token") != SwapHost.token
    ) {
      finish()
      return
    }
    SwapHost.screen = this
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    // A buy runs for several minutes; a locked screen would pause it half way.
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    if (Build.VERSION.SDK_INT >= 31) window.setHideOverlayWindows(true)
    root =
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(NativeStyle.ink)
        setPadding(
          NativeStyle.dp(this@SwapActivity, 24),
          NativeStyle.dp(this@SwapActivity, 24),
          NativeStyle.dp(this@SwapActivity, 24),
          NativeStyle.dp(this@SwapActivity, 24),
        )
      }
    setContentView(root)
    show(
      "Preparing the swap",
      "Checking the funding wallet, quotes and limits. Nothing is signed yet.",
    )
    scope.launch {
      try {
        val gateway = checkNotNull(SwapHost.gateway)
        check(NativeRpcTransportAllowed(gateway))
        val wallet = walletStore(applicationContext)
        val record = withContext(Dispatchers.IO) { wallet.load() }
        try {
          check(record.verified)
          val saved = SwapStore(applicationContext, record)
          val active = SwapEngine(wallet, saved, gateway)
          engine = active
          if (SwapHost.resume) {
            active.restore()
            active.retry()
          } else if (SwapHost.sell) {
            active.startSell(record, SwapHost.holdingId, SwapHost.sweepTo)
          } else if (SwapHost.recovery) {
            active.startRecovery(record, checkNotNull(SwapHost.target))
          } else if (SwapHost.payout) {
            active.start(record, checkNotNull(SwapHost.target), null, "confidentialPayout")
          } else active.start(record, checkNotNull(SwapHost.target), SwapHost.amountAtoms)
        } finally {
          record.close()
        }
        present(checkNotNull(engine).advance(::progress))
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        android.util.Log.e("SwapActivity", "swap failed", error)
        SwapHost.fail(error.message ?: error.javaClass.simpleName)
      }
    }
  }

  private fun present(ui: SwapUi) {
    if (stopped) return
    when (ui) {
      is SwapUi.Review -> showReview(ui.text)
      is SwapUi.Unlock -> unlock()
      is SwapUi.Done -> SwapHost.close(ui.view)
    }
  }

  private fun approved() =
    runCatching { engine?.view()?.get("approved") == true }.getOrDefault(false)

  private fun progress(view: Map<String, Any?>) {
    if (stopped) return
    root.removeAllViews()
    root.addView(
      SwapScreens.progress(this, view, view["approved"] == true),
      LinearLayout.LayoutParams(-1, 0, 1f),
    )
    root.addView(
      NativeStyle.button(this, if (approved()) "Pause and go back" else "Cancel swap", false)
        .apply { setOnClickListener { cancelOrLeave() } },
      NativeStyle.fullWidth(this, 16),
    )
  }

  /**
   * After approval funds may be in flight, so leaving pauses the operation instead of cancelling
   * it.
   */
  private fun leave() {
    SwapHost.close(runCatching { engine?.view() }.getOrNull())
  }

  private fun cancelOrLeave() {
    if (approved()) leave() else cancel()
  }

  private fun show(title: String, message: String) {
    root.removeAllViews()
    root.addView(
      SwapScreens.preparing(this, title, message),
      LinearLayout.LayoutParams(-1, 0, 1f).apply {
        topMargin = NativeStyle.dp(this@SwapActivity, 64)
      },
    )
  }

  private fun showReview(text: String, error: String? = null) {
    root.removeAllViews()
    root.addView(NativeStyle.title(this, "Review swap", 22f))
    if (error != null)
      root.addView(
        NativeStyle.body(this, error, NativeStyle.danger).apply {
          background =
            NativeStyle.rounded(this@SwapActivity, 0x16FF9B9B, 16, NativeStyle.dangerBorder)
          setPadding(
            NativeStyle.dp(this@SwapActivity, 14),
            NativeStyle.dp(this@SwapActivity, 12),
            NativeStyle.dp(this@SwapActivity, 14),
            NativeStyle.dp(this@SwapActivity, 12),
          )
        },
        NativeStyle.fullWidth(this, 12),
      )
    val scroll = ScrollView(this).apply { isVerticalScrollBarEnabled = false }
    scroll.addView(SwapScreens.review(this, text))
    root.addView(
      scroll,
      LinearLayout.LayoutParams(-1, 0, 1f).apply {
        topMargin = NativeStyle.dp(this@SwapActivity, 16)
      },
    )
    // Approval stays locked until the whole review has been scrolled through; say so.
    val hint =
      NativeStyle.body(this, "Scroll to the end to approve", NativeStyle.disabledText).apply {
        textSize = 12f
        gravity = android.view.Gravity.CENTER
      }
    root.addView(hint, NativeStyle.fullWidth(this, 10))
    val approve =
      NativeStyle.button(
        this,
        if (engine?.hasFundingBatch == true) "Approve funding batch" else "Approve for 15 minutes",
        true,
      )
    approve.isEnabled = false
    approve.setOnClickListener {
      if (!approve.isEnabled || stopped) return@setOnClickListener
      approve.isEnabled = false
      authorize(text)
    }
    root.addView(approve, NativeStyle.fullWidth(this, 8))
    root.addView(
      NativeStyle.button(this, if (approved()) "Not now" else "Cancel", false).apply {
        setOnClickListener { cancelOrLeave() }
      },
      NativeStyle.fullWidth(this, 10),
    )
    fun sync() {
      val ready = !scroll.canScrollVertically(1) && !stopped
      approve.isEnabled = ready
      hint.visibility = if (ready) View.GONE else View.VISIBLE
    }
    scroll.viewTreeObserver.addOnScrollChangedListener { sync() }
    scroll.post { sync() }
  }

  private fun authorize(text: String) {
    scope.launch {
      try {
        val wallet = walletStore(applicationContext)
        val identity = withContext(Dispatchers.IO) { wallet.load().use { it.id to it.credential } }
        withContext(Dispatchers.IO) {
          WalletRecoveryRuntime.beforeFreshFunding(applicationContext, identity.first)
        }
        val digest = checkNotNull(engine).reviewDigest(text)
        providerPending = true
        try {
          PasskeyGate(this@SwapActivity)
            .authorize(
              identity.second,
              identity.first,
              "swap:v1:${engine?.view()?.get("operationId")}:$digest",
            )
          withTimeout(FOCUS_TIMEOUT_MS) { while (!hasWindowFocus()) delay(FOCUS_POLL_INTERVAL_MS) }
        } finally {
          providerPending = false
        }
        check(!stopped && hasWindowFocus())
        check(!(getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked)
        // Restored operations contain no signing key. Rehydrate it only after
        // the passkey assertion, then approve the exact review shown above.
        val record = withContext(Dispatchers.IO) { wallet.load() }
        try {
          check(!stopped && hasWindowFocus())
          check(!(getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked)
          check(record.id == identity.first)
          checkNotNull(engine).authorizeReviewed(record, text)
        } finally {
          record.close()
        }
        show(
          "Submitting the approved steps",
          "You can leave and resume; submitted steps are not signed again.",
        )
        present(checkNotNull(engine).advance(::progress))
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        android.util.Log.e("SwapActivity", "approval failed", error)
        if (!stopped) {
          if (engine?.hasFundingBatch == true) {
            try {
              val refreshed = checkNotNull(engine).advance(::progress)
              if (refreshed is SwapUi.Review)
                showReview(refreshed.text, error.message ?: error.javaClass.simpleName)
              else present(refreshed)
            } catch (refreshError: CancellationException) {
              throw refreshError
            } catch (refreshError: Exception) {
              SwapHost.fail(refreshError.message ?: refreshError.javaClass.simpleName)
            }
          } else showReview(text, error.message ?: error.javaClass.simpleName)
        }
      }
    }
  }

  private fun unlock() {
    root.removeAllViews()
    root.addView(SwapScreens.unlock(this), LinearLayout.LayoutParams(-1, 0, 1f))
    root.addView(
      NativeStyle.button(this, "Unlock", true).apply { setOnClickListener { unlockPasskey() } },
      NativeStyle.fullWidth(this, 16),
    )
    root.addView(
      NativeStyle.button(this, if (approved()) "Not now" else "Cancel", false).apply {
        setOnClickListener { cancelOrLeave() }
      },
      NativeStyle.fullWidth(this, 10),
    )
  }

  private fun unlockPasskey() {
    scope.launch {
      try {
        val wallet = walletStore(applicationContext)
        val identity = withContext(Dispatchers.IO) { wallet.load().use { it.id to it.credential } }
        providerPending = true
        try {
          PasskeyGate(this@SwapActivity)
            .authorize(
              identity.second,
              identity.first,
              "swap-unlock:v1:${engine?.view()?.get("operationId")}",
            )
          withTimeout(FOCUS_TIMEOUT_MS) { while (!hasWindowFocus()) delay(FOCUS_POLL_INTERVAL_MS) }
        } finally {
          providerPending = false
        }
        val record = withContext(Dispatchers.IO) { wallet.load() }
        try {
          engine?.unlock(record)
        } finally {
          record.close()
        }
        present(checkNotNull(engine).advance(::progress))
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        android.util.Log.e("SwapActivity", "unlock failed", error)
        if (!stopped) unlock()
      }
    }
  }

  private fun cancel() {
    try {
      engine?.cancel()
    } finally {
      SwapHost.close(engine?.view())
    }
  }

  override fun onPause() {
    super.onPause()
    if (!providerPending && !isFinishing) SwapHost.close(runCatching { engine?.view() }.getOrNull())
  }

  @Deprecated("Platform back")
  override fun onBackPressed() {
    cancelOrLeave()
  }

  override fun onDestroy() {
    stopWork()
    if (SwapHost.screen === this) SwapHost.close(null)
    super.onDestroy()
  }
}

private const val FOCUS_TIMEOUT_MS = 10_000L
private const val FOCUS_POLL_INTERVAL_MS = 50L

private fun NativeRpcTransportAllowed(url: String) =
  io.gizu.storedwallet.NativeRpcTransport.allowed(url)
