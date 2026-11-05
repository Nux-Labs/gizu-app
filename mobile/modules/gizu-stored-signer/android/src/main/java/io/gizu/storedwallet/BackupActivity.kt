package io.gizu.storedwallet

import android.app.Activity
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import io.gizu.storedwallet.swap.SwapReconciler
import java.security.MessageDigest
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.*
import uniffi.gizu_stored_signer_core.deriveAccountAddresses

/** Native-only handoff. No file URI, encrypted file, PRF or entropy crosses Expo. */
internal object BackupHost {
  var token: String? = null
    private set

  private var completion: CancellableContinuation<Unit>? = null
  var screen: BackupActivity? = null
  private var closing: Job? = null

  suspend fun open(activity: Activity, restore: Boolean) {
    try {
      suspendCancellableCoroutine<Unit> { result ->
        check(completion == null)
        val id = UUID.randomUUID().toString()
        token = id
        completion = result
        result.invokeOnCancellation { activity.runOnUiThread { close(false) } }
        try {
          activity.startActivity(
            Intent(activity, BackupActivity::class.java)
              .putExtra("token", id)
              .putExtra("restore", restore)
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
    val current = screen
    screen = null
    fun complete() {
      if (result?.isActive == true) {
        if (success) result.resume(Unit) else result.cancel()
      }
    }
    if (current != null) {
      current.cancelWork()
      current.finish()
      closing =
        CoroutineScope(Dispatchers.Main.immediate).launch {
          current.awaitWork()
          complete()
        }
    } else complete()
  }
}

class BackupActivity : Activity() {
  private companion object {
    const val SAVE_BACKUP_REQUEST = 1
    const val OPEN_BACKUP_REQUEST = 2
    const val MAX_BACKUP_BYTES = 16 * 1024 * 1024
    const val FOCUS_TIMEOUT_MS = 10000L
    const val FOCUS_POLL_INTERVAL_MS = 50L
  }

  private val workJob = SupervisorJob()
  private val scope = CoroutineScope(workJob + Dispatchers.Main.immediate)

  internal fun cancelWork() {
    workJob.cancel()
  }

  internal suspend fun awaitWork() {
    workJob.join()
  }

  private var observingLock = false
  private val lockReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action == Intent.ACTION_SCREEN_OFF) BackupHost.close(false)
      }
    }
  private var external = false
  private var encrypted: ByteArray? = null
  private var saved = false
  private var busy = false
  private var restore = false
  private lateinit var message: TextView
  private lateinit var action: Button
  private lateinit var steps: LinearLayout
  private lateinit var status: LinearLayout
  private val store by lazy { walletStore(applicationContext) }

  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    if (
      state != null ||
        intent.getStringExtra("token") != BackupHost.token ||
        BackupHost.token == null
    ) {
      finish()
      return
    }
    BackupHost.screen = this
    val filter = IntentFilter(Intent.ACTION_SCREEN_OFF)
    if (Build.VERSION.SDK_INT >= 33)
      registerReceiver(lockReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    else {
      @Suppress("DEPRECATION") registerReceiver(lockReceiver, filter)
    }
    observingLock = true
    restore = intent.getBooleanExtra("restore", false)
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    if (Build.VERSION.SDK_INT >= 31) window.setHideOverlayWindows(true)
    window.decorView.setBackgroundColor(NativeStyle.ink)
    setContentView(buildLayout())
  }

  private fun dp(value: Int) = NativeStyle.dp(this, value)

  private val stepLabels
    get() =
      if (restore) listOf("Choose backup file", "Confirm original passkey", "Done")
      else listOf("Save file", "Reopen & confirm passkey", "Done")

  private fun buildLayout(): View {
    val content =
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        filterTouchesWhenObscured = true
      }
    content.addView(
      NativeStyle.title(
        this,
        if (restore) "Restore Gizu wallet" else "Back up your Gizu wallet",
        28f,
      )
    )
    content.addView(
      NativeStyle.body(
        this,
        if (restore)
          "Choose your encrypted backup, then confirm the original passkey. Recovery restores wallet accounts, not transaction history."
        else
          "Save the encrypted file, then reopen it to verify recovery. You will confirm your passkey twice.",
      ),
      NativeStyle.fullWidth(this, 10),
    )
    steps =
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = NativeStyle.card(this@BackupActivity)
        setPadding(dp(20), dp(8), dp(20), dp(8))
      }
    content.addView(steps, NativeStyle.fullWidth(this, 24))
    status =
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = NativeStyle.card(this@BackupActivity)
        setPadding(dp(20), dp(18), dp(20), dp(18))
      }
    message = NativeStyle.body(this, "", NativeStyle.primaryText)
    message.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    status.addView(message)
    content.addView(status, NativeStyle.fullWidth(this, 12))
    message.text =
      if (restore) "You need the encrypted backup file and the original passkey."
      else
        "You need BOTH this file and your original passkey to recover your wallet. Keep them available independently of this phone."
    renderSteps()

    action =
      NativeStyle.button(this, if (restore) "Choose backup" else "Save encrypted backup", true)
        .apply {
          setOnClickListener {
            if (!busy) {
              if (restore || saved) choose() else save()
            }
          }
        }
    val actions =
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        filterTouchesWhenObscured = true
        addView(action, NativeStyle.fullWidth(this@BackupActivity))
        addView(
          NativeStyle.button(this@BackupActivity, "Cancel", false).apply {
            setOnClickListener { BackupHost.close(false) }
          },
          NativeStyle.fullWidth(this@BackupActivity, 10),
        )
      }
    val scroll =
      ScrollView(this).apply {
        isFillViewport = true
        isVerticalScrollBarEnabled = false
        addView(content)
      }
    val root =
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(NativeStyle.ink)
        filterTouchesWhenObscured = true
        addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        addView(actions, NativeStyle.fullWidth(this@BackupActivity, 16))
      }
    val padding = dp(24)
    root.setOnApplyWindowInsetsListener { _, insets ->
      @Suppress("DEPRECATION")
      val top =
        if (Build.VERSION.SDK_INT >= 30)
          insets.getInsets(android.view.WindowInsets.Type.systemBars()).top
        else insets.systemWindowInsetTop
      @Suppress("DEPRECATION")
      val bottom =
        if (Build.VERSION.SDK_INT >= 30)
          insets.getInsets(android.view.WindowInsets.Type.systemBars()).bottom
        else insets.systemWindowInsetBottom
      root.setPadding(padding, padding + top, padding, dp(16) + bottom)
      insets
    }
    return root
  }

  /** Presentation only: reflects the existing `saved` flag, never drives the ceremony. */
  private fun renderSteps() {
    val current = if (!restore && saved) 1 else 0
    steps.removeAllViews()
    stepLabels.forEachIndexed { index, label ->
      val done = index < current
      val active = index == current
      val badge =
        TextView(this).apply {
          text = if (done) "✓" else "${index + 1}"
          textSize = 13f
          gravity = Gravity.CENTER
          typeface = NativeStyle.font(this@BackupActivity, true)
          setTextColor(
            when {
              active -> NativeStyle.ctaText
              done -> NativeStyle.neon
              else -> NativeStyle.secondary
            }
          )
          background =
            NativeStyle.rounded(
              this@BackupActivity,
              when {
                active -> NativeStyle.neon
                done -> NativeStyle.neonDeep
                else -> NativeStyle.glassSoft
              },
              14,
              if (active || done) null else NativeStyle.glassBorder,
            )
          importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
      val name =
        NativeStyle.body(
            this,
            label,
            if (active) NativeStyle.primaryText else NativeStyle.secondary,
          )
          .apply {
            typeface = NativeStyle.font(this@BackupActivity, active)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
          }
      val row =
        LinearLayout(this).apply {
          orientation = LinearLayout.HORIZONTAL
          gravity = Gravity.CENTER_VERTICAL
          minimumHeight = dp(48)
          contentDescription =
            "Step ${index + 1} of ${stepLabels.size}: $label" +
              when {
                done -> ", complete"
                active -> ", current"
                else -> ""
              }
          importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
          addView(badge, LinearLayout.LayoutParams(dp(28), dp(28)))
          addView(
            name,
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
              marginStart = dp(14)
            },
          )
        }
      steps.addView(row, NativeStyle.fullWidth(this))
    }
  }

  private fun showStatus(value: String, failed: Boolean) {
    message.text = value
    message.setTextColor(if (failed) NativeStyle.danger else NativeStyle.primaryText)
    status.background =
      NativeStyle.rounded(
        this,
        NativeStyle.glass,
        24,
        if (failed) NativeStyle.dangerBorder else NativeStyle.glassBorder,
      )
  }

  private fun unlocked() {
    check(!isFinishing && !isDestroyed)
    check(!(getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked)
  }

  private suspend fun authorizeRecoveryKey(credential: StoredPasskey): ByteArray {
    unlocked()
    external = true
    try {
      val bytes = PasskeyGate(this).recoveryPrf(credential)
      try {
        withTimeout(FOCUS_TIMEOUT_MS) { while (!hasWindowFocus()) delay(FOCUS_POLL_INTERVAL_MS) }
        unlocked()
        currentCoroutineContext().ensureActive()
        return bytes
      } catch (error: Throwable) {
        bytes.fill(0)
        throw error
      }
    } finally {
      external = false
    }
  }

  private fun work(block: suspend () -> Unit) {
    busy = true
    action.isEnabled = false
    scope.launch {
      try {
        unlocked()
        block()
      } catch (_: CancellationException) {
        BackupHost.close(false)
      } catch (_: Exception) {
        showStatus(
          "Backup could not be verified. Use the original passkey and an unchanged Gizu backup. Your current wallet has not been replaced. You can retry or cancel.",
          failed = true,
        )
      } finally {
        busy = false
        action.isEnabled = true
      }
    }
  }

  private fun save() = work {
    val credential = withContext(Dispatchers.IO) { store.load().use { it.credential } }
    val key = authorizeRecoveryKey(credential)
    try {
      encrypted =
        withContext(Dispatchers.IO) {
          store.load().use { record ->
            check(record.credential.credentialId.contentEquals(credential.credentialId))
            BackupCodec.encrypt(record, key)
          }
        }
    } finally {
      key.fill(0)
    }
    unlocked()
    external = true
    try {
      startActivityForResult(
        Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          type = "application/json"
          putExtra(Intent.EXTRA_TITLE, "gizu-wallet-backup.json")
        },
        SAVE_BACKUP_REQUEST,
      )
    } catch (error: Exception) {
      external = false
      throw error
    }
  }

  private fun choose() {
    external = true
    try {
      startActivityForResult(
        Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          type = "*/*"
        },
        OPEN_BACKUP_REQUEST,
      )
    } catch (_: Exception) {
      external = false
      BackupHost.close(false)
    }
  }

  @Deprecated("Platform document picker callback")
  override fun onActivityResult(request: Int, result: Int, data: Intent?) {
    super.onActivityResult(request, result, data)
    external = false
    if (result != RESULT_OK || data?.data == null) {
      BackupHost.close(false)
      return
    }
    val uri = data.data!!
    work {
      if (request == SAVE_BACKUP_REQUEST) {
        writeBackup(uri)
      } else if (request == OPEN_BACKUP_REQUEST) verify(uri)
      else error("Unexpected document result")
    }
  }

  private suspend fun writeBackup(uri: Uri) {
    withContext(Dispatchers.IO) {
      contentResolver.openOutputStream(uri, "wt")!!.use { it.write(checkNotNull(encrypted)) }
    }
    encrypted?.fill(0)
    encrypted = null
    saved = true
    showStatus(
      "Backup saved. Now reopen that file and confirm your original passkey so Gizu can verify all wallet accounts.",
      failed = false,
    )
    action.text = "Open saved backup to verify"
    renderSteps()
  }

  private suspend fun readBackup(uri: Uri): ByteArray {
    return withContext(Dispatchers.IO) {
      contentResolver.openInputStream(uri)!!.use { input ->
        val buffer = ByteArray(MAX_BACKUP_BYTES + 1)
        var count = 0
        while (count < buffer.size) {
          val read = input.read(buffer, count, buffer.size - count)
          if (read == -1) break
          check(read > 0)
          count += read
        }
        require(count in 1..MAX_BACKUP_BYTES)
        buffer.copyOf(count)
      }
    }
  }

  private suspend fun verifyCredentialMatchesWallet(credential: StoredPasskey) {
    if (restore)
      check(
        withContext(Dispatchers.IO) {
          store.state()["status"] in listOf("absent", "recoveryRequired")
        }
      )
    else
      withContext(Dispatchers.IO) {
        store.load().use {
          check(it.credential.credentialId.contentEquals(credential.credentialId))
          check(
            it.credential.publicKeyX.contentEquals(credential.publicKeyX) &&
              it.credential.publicKeyY.contentEquals(credential.publicKeyY)
          )
        }
      }
  }

  private suspend fun verify(uri: Uri) {
    check(restore || saved)
    val bytes = readBackup(uri)
    val credential = BackupCodec.credential(bytes)
    verifyCredentialMatchesWallet(credential)
    val key = authorizeRecoveryKey(credential)
    try {
      withContext(Dispatchers.IO) {
        BackupCodec.decrypt(bytes, key).use { restored ->
          val accounts = deriveAccountAddresses(restored.entropy)
          check(accounts.size == 16)
          val registry =
            if (!restore) restored.roleRegistry
            else
              try {
                SwapReconciler.covering(restored.entropy, restored.roleRegistry)
              } catch (_: Exception) {
                restored.roleRegistry
              }
          WalletRecord(
              restored.id,
              restored.credential,
              restored.entropy.copyOf(),
              roleRegistry = registry,
              earnChain = restored.earnChain,
              earnRecoveryRequired = restored.earnRecoveryRequired,
              earnCycleIndex = restored.earnCycleIndex,
              earnCycles = restored.earnCycles,
              discoveryHighWater = restored.discoveryHighWater,
              discoveryRecoveryRequired = restored.discoveryRecoveryRequired,
            )
            .use { recovered ->
              if (!restore)
                store.load().use { current ->
                  check(
                    current.id == restored.id &&
                      MessageDigest.isEqual(current.entropy, restored.entropy)
                  )
                  check(deriveAccountAddresses(current.entropy) == accounts)
                }
              currentCoroutineContext().ensureActive()
              if (restore) store.restore(recovered) else store.markVerified(restored)
            }
        }
      }
    } finally {
      key.fill(0)
      bytes.fill(0)
    }
    unlocked()
    BackupHost.close(true)
  }

  override fun onPause() {
    super.onPause()
    if (!external && !isFinishing) BackupHost.close(false)
  }

  @Deprecated("Platform back")
  override fun onBackPressed() {
    BackupHost.close(false)
  }

  override fun onDestroy() {
    if (observingLock) {
      unregisterReceiver(lockReceiver)
      observingLock = false
    }
    scope.cancel()
    encrypted?.fill(0)
    encrypted = null
    if (BackupHost.screen === this) BackupHost.close(false)
    super.onDestroy()
  }
}
