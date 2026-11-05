package io.gizu.storedwallet

import android.app.Activity
import android.app.KeyguardManager
import android.content.*
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import java.security.MessageDigest
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.*

internal object TransferHost {
  var token: String? = null
    private set

  var id: String? = null
    private set

  var revision: Int = 0
    private set

  var screen: TransferActivity? = null
  private var completion: CancellableContinuation<Unit>? = null
  private var closing: Job? = null

  suspend fun open(activity: Activity, operationId: String, expectedRevision: Int) {
    try {
      suspendCancellableCoroutine<Unit> { continuation ->
        check(completion == null)
        token = UUID.randomUUID().toString()
        id = operationId
        revision = expectedRevision
        completion = continuation
        continuation.invokeOnCancellation { activity.runOnUiThread { close(false) } }
        try {
          activity.startActivity(
            Intent(activity, TransferActivity::class.java).putExtra("token", token)
          )
        } catch (_: Exception) {
          close(false)
        }
      }
    } finally {
      withContext(NonCancellable) { closing?.join() }
      closing = null
    }
  }

  fun close(success: Boolean) {
    val result = completion
    completion = null
    token = null
    id = null
    val current = screen
    screen = null
    fun done() {
      if (result?.isActive == true) {
        if (success) result.resume(Unit) else result.cancel()
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

/** Native-owned review and authorization; no React approval or raw-signature export. */
class TransferActivity : Activity() {
  private companion object {
    const val PREPARATION_TIMEOUT_MS = 30000L
    const val FOCUS_TIMEOUT_MS = 10000L
    const val FOCUS_POLL_INTERVAL_MS = 50L
  }

  private val job = SupervisorJob()
  private val scope = CoroutineScope(job + Dispatchers.Main.immediate)
  private var engine: TransferEngine? = null
  private var providerPending = false
  private var approved = false
  private var stopped = false
  private var observingLock = false
  private var operationId: String? = null
  private lateinit var root: LinearLayout
  private var progress: TextView? = null
  private val lockReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action == Intent.ACTION_SCREEN_OFF) TransferHost.close(false)
      }
    }
  // Mirrors src/theme/colors.json; presentation only, never supplied by JavaScript.
  private val ink = Color.parseColor("#050706")
  private val surface = Color.parseColor("#0b100d")
  private val accent = Color.parseColor("#31c47e")
  private val foregroundColor = Color.parseColor("#dfe8e3")
  private val muted = Color.parseColor("#a7b2ab")
  private val border = Color.parseColor("#1d2821")

  private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

  private fun rounded(color: Int) =
    GradientDrawable().apply {
      setColor(color)
      cornerRadius = dp(20).toFloat()
      setStroke(dp(1), border)
    }

  internal fun stopWork() {
    stopped = true
    engine?.close()
    job.cancel()
  }

  internal suspend fun awaitWork() {
    job.join()
  }

  private fun authorizedForeground() {
    check(!stopped && hasWindowFocus() && !isFinishing)
    check(!(getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked)
  }

  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    if (
      state != null ||
        TransferHost.token == null ||
        intent.getStringExtra("token") != TransferHost.token
    ) {
      finish()
      return
    }
    TransferHost.screen = this
    operationId = TransferHost.id
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    if (Build.VERSION.SDK_INT >= 31) window.setHideOverlayWindows(true)
    val filter = IntentFilter(Intent.ACTION_SCREEN_OFF)
    if (Build.VERSION.SDK_INT >= 33)
      registerReceiver(lockReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    else {
      @Suppress("DEPRECATION") registerReceiver(lockReceiver, filter)
    }
    observingLock = true
    root =
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(ink)
        setOnApplyWindowInsetsListener { view, insets ->
          @Suppress("DEPRECATION")
          view.setPadding(
            dp(24) + insets.systemWindowInsetLeft,
            dp(16) + insets.systemWindowInsetTop,
            dp(24) + insets.systemWindowInsetRight,
            dp(16) + insets.systemWindowInsetBottom,
          )
          insets
        }
      }
    setContentView(root)
    progress = text("Preparing exact transfers…")
    button("Cancel") { cancelRemaining() }
    prepareReview()
  }

  private fun prepareReview() {
    scope.launch {
      try {
        val store = walletStore(applicationContext)
        val journal = store.load().use { operationJournal(applicationContext, it) }
        val rpc = MonadRpc { phase -> progress?.text = "$phase…" }
        val active = TransferEngine(store, journal, rpc)
        engine = active
        val review =
          withTimeout(PREPARATION_TIMEOUT_MS) {
            active.prepare(checkNotNull(operationId), TransferHost.revision)
          }
        withTimeout(FOCUS_TIMEOUT_MS) { while (!hasWindowFocus()) delay(FOCUS_POLL_INTERVAL_MS) }
        authorizedForeground()
        showReview(review)
      } catch (_: CancellationException) {
        TransferHost.close(false)
      } catch (failure: Exception) {
        showFailure(failure)
      }
    }
  }

  private fun text(value: String, size: Float = 17f) =
    TextView(this).also {
      it.text = value
      it.textSize = size
      it.setTextColor(if (size >= 24f) foregroundColor else if (size == 13f) accent else muted)
      if (size >= 24f) it.typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      it.setPadding(0, dp(8), 0, dp(12))
      it.setLineSpacing(dp(3).toFloat(), 1f)
      root.addView(it)
    }

  private fun button(label: String, action: (Button) -> Unit) =
    Button(this).also { b ->
      val primary = label != "Cancel" && label != "Reject" && label != "Close"
      b.text = label
      b.isAllCaps = false
      b.textSize = 17f
      b.typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      b.minHeight = dp(56)
      b.setPadding(dp(16), dp(14), dp(16), dp(14))
      b.backgroundTintList = null
      b.background =
        StateListDrawable().apply {
          addState(intArrayOf(-android.R.attr.state_enabled), rounded(surface))
          addState(intArrayOf(android.R.attr.state_pressed), rounded(border))
          addState(intArrayOf(), rounded(if (primary) accent else surface))
        }
      b.setTextColor(
        ColorStateList(
          arrayOf(
            intArrayOf(-android.R.attr.state_enabled),
            intArrayOf(android.R.attr.state_pressed),
            intArrayOf(),
          ),
          intArrayOf(muted, foregroundColor, if (primary) ink else foregroundColor),
        )
      )
      b.filterTouchesWhenObscured = true
      b.setOnClickListener { action(b) }
      root.addView(b, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
    }

  private fun showReview(review: PreparedReview) {
    progress = null
    root.removeAllViews()
    text("MONAD TESTNET · NATIVE APPROVAL", 13f)
    text(if (review.retry) "Retry saved transfer" else "Confirm transfers", 28f)
    text("Review every detail. Approval and your passkey authorize only this operation.", 15f)
    val scroll =
      ScrollView(this).apply {
        background = rounded(surface)
        isFillViewport = true
      }
    scroll.addView(
      TextView(this).apply {
        text = review.text
        textSize = 16f
        setTextColor(foregroundColor)
        setPadding(dp(20), dp(20), dp(20), dp(20))
      }
    )
    root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
    val approve =
      button("Approve and unlock passkey") { b ->
        if (approved || stopped || !hasWindowFocus()) return@button
        approved = true
        b.isEnabled = false
        authorizeAndExecute(review)
      }
    approve.isEnabled = false
    fun enableWhenRead() {
      approve.isEnabled = !approved && !stopped && !scroll.canScrollVertically(1)
    }
    scroll.viewTreeObserver.addOnScrollChangedListener { enableWhenRead() }
    scroll.post { enableWhenRead() }
    button("Cancel") { cancelRemaining() }
  }

  private fun authorizeAndExecute(review: PreparedReview) {
    scope.launch {
      try {
        val store = walletStore(applicationContext)
        val identity =
          store.load().use {
            check(it.verified && it.id == engine!!.journal.walletId)
            it.id to it.credential
          }
        withContext(Dispatchers.IO) {
          WalletRecoveryRuntime.beforeFreshFunding(applicationContext, identity.first)
        }
        val digest =
          MessageDigest.getInstance("SHA-256").digest(review.text.toByteArray()).joinToString("") {
            "%02x".format(it)
          }
        providerPending = true
        try {
          PasskeyGate(this@TransferActivity)
            .authorize(
              identity.second,
              identity.first,
              "transfers:v1:${review.id}:${review.revision}:$digest",
            )
          withTimeout(FOCUS_TIMEOUT_MS) { while (!hasWindowFocus()) delay(FOCUS_POLL_INTERVAL_MS) }
        } finally {
          providerPending = false
        }
        authorizedForeground()
        progress =
          text("Executing approved transfers. Cancellation cannot undo submitted transfers.", 15f)
        engine!!.execute(review, ::authorizedForeground)
        TransferHost.close(true)
      } catch (_: CancellationException) {
        TransferHost.close(false)
      } catch (failure: Exception) {
        showFailure(failure)
      }
    }
  }

  private fun cancelRemaining() {
    try {
      operationId?.let { engine?.journal?.cancel(it) }
    } catch (_: Exception) {
      /* Stop authority even when cancellation cannot be persisted. */
    } finally {
      TransferHost.close(false)
    }
  }

  private fun showFailure(failure: Exception) {
    if (stopped) return
    engine?.close()
    progress = null
    root.removeAllViews()
    text("Transfer paused", 28f)
    text(
      if (failure is RpcFailure && failure.code == RpcFailureCode.INSUFFICIENT_FUNDS)
        "More testnet MON is needed for the amount and fees."
      else
        "Preparation or execution could not finish. No further transfers will be sent. Refresh Activity to reconcile before resuming. Saved signed transfers keep their original amounts, nonces and fees."
    )
    button("Close") { TransferHost.close(true) }
  }

  override fun onPause() {
    super.onPause()
    if (!providerPending && !isFinishing) TransferHost.close(false)
  }

  @Deprecated("Platform back")
  override fun onBackPressed() {
    cancelRemaining()
  }

  override fun onDestroy() {
    if (observingLock) {
      unregisterReceiver(lockReceiver)
      observingLock = false
    }
    stopWork()
    if (TransferHost.screen === this) TransferHost.close(false)
    super.onDestroy()
  }
}
