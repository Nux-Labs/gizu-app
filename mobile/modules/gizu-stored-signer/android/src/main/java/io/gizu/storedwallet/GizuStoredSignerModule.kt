package io.gizu.storedwallet

import android.app.Activity
import android.app.Dialog
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.PowerManager
import android.view.Gravity
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import io.gizu.storedwallet.swap.SwapEngine
import io.gizu.storedwallet.swap.SwapHost
import io.gizu.storedwallet.swap.SwapStore
import java.security.SecureRandom
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.EarnReadAuthentication
import uniffi.gizu_stored_signer_core.deriveAccountAddressRange
import uniffi.gizu_stored_signer_core.deriveAccountAddresses
import uniffi.gizu_stored_signer_core.deriveEarnAddresses

/** Wallet access requires a verified native backup; exact transfer signing stays native. */
class GizuStoredSignerModule : Module() {
  companion object {
    private val ceremony = Mutex()
    private const val CEREMONY_TIMEOUT_MS = 120000L
    private const val FOCUS_TIMEOUT_MS = 10000L
    private const val FOCUS_POLL_INTERVAL_MS = 50L
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var task: Job? = null
  private var ceremonySession: NativeCeremonySession? = null
  private var dialog: Dialog? = null
  private var awaitingProvider = false
  private var foreground = true
  private val discoveryConsent = WalletDiscoveryConsent()
  private val privateUsdc = PrivateUsdcRead {
    observeDepositDepartures(checkNotNull(appContext.currentActivity ?: appContext.reactContext))
  }
  private var depositHost: EarnDepositHost? = null
  private var openWithdrawal: OpenWithdrawalApproval? = null
  private var depositPreparingId: String? = null
  private var departureContext: Context? = null
  private val depositLifecycle = EarnDepositLifecycle {
    discoveryConsent.clear()
    depositHost?.revoke("approvalExpired")
    task?.cancel()
  }
  private val departureReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        privateUsdc.onSystemEvent(intent?.action)
        depositLifecycle.onSystemEvent(intent?.action, intent?.getStringExtra("reason"))
      }
    }

  private fun observeDepositDepartures(context: Context) {
    if (departureContext != null) return
    val app = context.applicationContext
    val filter =
      IntentFilter().apply {
        addAction(Intent.ACTION_SCREEN_OFF)
        addAction(Intent.ACTION_CLOSE_SYSTEM_DIALOGS)
      }
    ContextCompat.registerReceiver(
      app,
      departureReceiver,
      filter,
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    departureContext = app
  }

  private fun releaseUnsignedDeposit(context: Context, journal: EarnDepositJournal, id: String) {
    journal.cancelUnsignedReview(id) { batch ->
      walletStore(context).load().use { record ->
        val saved = journal.get(id)
        check(
          saved.getString("walletId") == record.id &&
            saved.getString("generation") == record.journalId
        )
        if (!batch.startsWith("private_"))
          fundingReservations(context, record).cancelBatchUnsigned(batch)
      }
    }
  }

  private suspend fun depositReconciliationReadAuth(
    activity: Activity,
    store: WalletStore,
    wallet: String,
    generation: String,
    cycle: Int,
  ): EarnReadAuthentication {
    requireForeground(activity)
    fun checkPermission(record: WalletRecord) {
      check(
        record.id == wallet &&
          record.journalId == generation &&
          record.earnChain == 4663 &&
          record.earnCycleIndex == cycle
      )
      requirePrivateReadPermission(activity, record)
    }
    store.load().use { checkPermission(it) }
    val salt = ConfidentialBalance().salt()
    val random = ByteArray(7).also { SecureRandom().nextBytes(it) }
    val started = System.currentTimeMillis()
    currentCoroutineContext().ensureActive()
    requireForeground(activity)
    return store.load().use { record ->
      checkPermission(record)
      cycleReadAuth(record, salt, random, started.toULong(), System.currentTimeMillis().toULong())
    }
  }

  private fun eligible(activity: Activity?) =
    WalletBuildPolicy.isAvailable(Build.VERSION.SDK_INT, activity != null)

  private fun requireForeground(activity: Activity) {
    check(activity.hasWindowFocus())
    requireVisible(activity)
  }

  /**
   * Gizu is in front and the phone is unlocked. Read-only work needs only this: pulling down the
   * notification shade or a system dialog takes window focus without leaving Gizu, and leaving
   * Gizu already cancels the running read. Approvals keep the focus check in [requireForeground].
   */
  private fun requireVisible(activity: Activity) {
    check(foreground && !activity.isFinishing && !activity.isDestroyed)
    check(
      !(activity.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked
    )
  }

  private suspend fun confirmCreation(activity: Activity) =
    confirm(
      activity,
      "Create Gizu wallet",
      "Create a passkey and a new wallet stored encrypted on this phone. A verified backup is required before this wallet can be used.",
    )

  private suspend fun confirm(
    activity: Activity,
    title: String,
    message: String,
    fullReview: Boolean = false,
  ) {
    if (fullReview)
      withContext(Dispatchers.IO) {
        val walletId = walletStore(activity).load().use { it.id }
        WalletRecoveryRuntime.beforeFreshFunding(activity, walletId)
      }
    val session = ceremonySession
    if (fullReview && session != null)
      session.review { showConfirmation(activity, title, message, fullReview) }
    else showConfirmation(activity, title, message, fullReview)
  }

  private suspend fun showConfirmation(
    activity: Activity,
    title: String,
    message: String,
    fullReview: Boolean,
  ) {
    suspendCancellableCoroutine<Unit> { continuation ->
      val alert = Dialog(activity)
      alert.requestWindowFeature(Window.FEATURE_NO_TITLE)
      // Back and Cancel remain explicit dismissal paths. A stray outside tap
      // must not discard a financial review while the user is reading it.
      alert.setCancelable(true)
      alert.setCanceledOnTouchOutside(!fullReview)
      alert.setOnCancelListener { continuation.cancel() }
      alert.setContentView(
        confirmationView(
          activity,
          title = title,
          message = message,
          fullReview = fullReview,
          onContinue = {
            if (continuation.isActive) continuation.resume(Unit)
            alert.dismiss()
          },
          onCancel = {
            continuation.cancel()
            alert.dismiss()
          },
        )
      )
      dialog = alert
      alert.window?.apply {
        addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (fullReview) addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= 31) setHideOverlayWindows(true)
        setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
        setGravity(Gravity.CENTER)
        setDimAmount(0.72f)
      }
      alert.show()
      continuation.invokeOnCancellation { scope.launch { alert.dismiss() } }
    }
  }

  private fun confirmationView(
    activity: Activity,
    title: String,
    message: String,
    fullReview: Boolean,
    onContinue: () -> Unit,
    onCancel: () -> Unit,
  ): View {
    fun dp(value: Int) = NativeStyle.dp(activity, value)
    val card =
      LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        background = NativeStyle.rounded(activity, NativeStyle.surface, 24, NativeStyle.glassBorder)
        setPadding(dp(24), dp(24), dp(24), dp(20))
        filterTouchesWhenObscured = true
        addView(NativeStyle.title(activity, title, 22f))
        if (fullReview)
          addView(
            NativeStyle.body(
              activity,
              "You have 5 minutes to review. Continue opens secure approval.",
            ),
            NativeStyle.fullWidth(activity, 10),
          )
        if (fullReview)
          addView(
            ScrollView(activity).apply {
              filterTouchesWhenObscured = true
              addView(NativeStyle.body(activity, message))
            },
            LinearLayout.LayoutParams(WindowManager.LayoutParams.MATCH_PARENT, dp(300)).apply {
              topMargin = dp(10)
            },
          )
        else addView(NativeStyle.body(activity, message), NativeStyle.fullWidth(activity, 10))
        addView(
          NativeStyle.button(activity, "Continue", primary = true).apply {
            setOnClickListener { onContinue() }
          },
          NativeStyle.fullWidth(activity, 24),
        )
        addView(
          NativeStyle.button(activity, "Cancel", primary = false).apply {
            setOnClickListener { onCancel() }
          },
          NativeStyle.fullWidth(activity, 10),
        )
      }
    return FrameLayout(activity).apply {
      setPadding(dp(20), dp(20), dp(20), dp(20))
      addView(card)
    }
  }

  private fun runCeremony(
    promise: Promise,
    wait: Boolean = false,
    timeoutMs: Long = CEREMONY_TIMEOUT_MS,
    /** Read-only work runs while Gizu is in front even without window focus. */
    readOnly: Boolean = false,
    block: suspend (Activity, WalletStore) -> Any?,
  ) {
    scope.launch {
      val activity = appContext.currentActivity
      if (!eligible(activity)) {
        promise.reject(
          "UNAVAILABLE",
          "Wallet access requires Android 9+ and an active Gizu screen.",
          null,
        )
        return@launch
      }
      if (wait) ceremony.lock()
      if (!wait && !ceremony.tryLock()) {
        promise.reject("BUSY", "A native wallet operation is already in progress.", null)
        return@launch
      }
      task = coroutineContext[Job]
      val session = NativeCeremonySession(timeoutMs)
      ceremonySession = session
      try {
        WalletRecoveryRuntime.initialize(activity!!.applicationContext)
        if (readOnly) requireVisible(activity) else requireForeground(activity)
        check(depositHost?.busy != true) {
          "A native deposit is running. Check its progress or stop its remaining approval first."
        }
        val result = session.run { block(activity, walletStore(activity.applicationContext)) }
        currentCoroutineContext().ensureActive()
        if (readOnly) requireVisible(activity) else requireForeground(activity)
        promise.resolve(result)
      } catch (error: CancellationException) {
        val (code, location) = depositFailureDiagnostic(error)
        android.util.Log.w("GizuWallet", "$code at $location")
        promise.reject("CANCELLED", nativeWalletFailureMessage(error), null)
      } catch (error: EarnGatewayFailure) {
        val (code, location) = depositFailureDiagnostic(error)
        android.util.Log.w("GizuWallet", "$code at $location")
        promise.reject(error.code, error.message ?: "Earn provider request is unavailable.", null)
      } catch (error: WalletExists) {
        promise.reject("WALLET_EXISTS", error.message, null)
      } catch (error: Exception) {
        // Record code locations only: exception messages may contain provider
        // payloads, account addresses or other private operation data.
        val (code, location) = depositFailureDiagnostic(error)
        android.util.Log.w("GizuWallet", "$code at $location")
        promise.reject(
          when {
            error is RpcFailure && error.code == RpcFailureCode.INSUFFICIENT_FUNDS ->
              "INSUFFICIENT_FUNDS"
            error is EarnRpcRejection -> "EARN_RPC_UNAVAILABLE"
            else -> "WALLET_FAILED"
          },
          nativeWalletFailureMessage(error),
          null,
        )
      } finally {
        dialog?.dismiss()
        dialog = null
        awaitingProvider = false
        task = null
        ceremonySession = null
        ceremony.unlock()
      }
    }
  }

  private suspend fun <T> withProviderUi(activity: Activity, action: suspend () -> T): T {
    withTimeout(FOCUS_TIMEOUT_MS) {
      while (foreground && !activity.hasWindowFocus()) delay(FOCUS_POLL_INTERVAL_MS)
    }
    requireForeground(activity)
    awaitingProvider = true
    try {
      val result = action()
      // System credential UI may temporarily take focus. A locked/background app cannot
      // consume results.
      withTimeout(FOCUS_TIMEOUT_MS) {
        while (!foreground || !activity.hasWindowFocus()) {
          delay(FOCUS_POLL_INTERVAL_MS)
        }
      }
      requireForeground(activity)
      return result
    } finally {
      awaitingProvider = false
    }
  }

  override fun definition() = ModuleDefinition {
    Name("GizuStoredSigner")
    OnCreate { appContext.reactContext?.let { WalletRecoveryRuntime.initialize(it) } }
    AsyncFunction("getWalletRecoveryStatus") { walletId: String, promise: Promise ->
      scope.launch {
        try {
          val context = checkNotNull(appContext.reactContext)
          promise.resolve(
            withContext(Dispatchers.IO) { WalletRecoveryRuntime.engine(context).status(walletId) }
          )
        } catch (_: Exception) {
          promise.reject("RECOVERY_UNAVAILABLE", "Native recovery status is unavailable.", null)
        }
      }
    }
    AsyncFunction("cancelWalletDiscovery") { walletId: String, promise: Promise ->
      discoveryConsent.clear()
      scope.launch {
        try {
          val context = checkNotNull(appContext.reactContext)
          promise.resolve(
            withContext(Dispatchers.IO) { WalletRecoveryRuntime.engine(context).cancel(walletId) }
          )
        } catch (_: Exception) {
          promise.reject("RECOVERY_UNAVAILABLE", "Native recovery status is unavailable.", null)
        }
      }
    }
    AsyncFunction("syncWalletRecovery") { walletId: String, promise: Promise ->
      runCeremony(promise, timeoutMs = 300000L) { activity, _ ->
        withContext(Dispatchers.IO) { WalletRecoveryRuntime.engine(activity).sync(walletId) }
      }
    }
    AsyncFunction("restoreWalletRecovery") { walletId: String, promise: Promise ->
      runCeremony(promise, timeoutMs = 300000L) { activity, _ ->
        confirm(
          activity,
          "Restore wallet recovery metadata",
          "Fetch encrypted recovery metadata and preserve signed history. Recovered activity remains blocked until verified reconciliation. No transaction will be submitted.",
        )
        withContext(Dispatchers.IO) { WalletRecoveryRuntime.engine(activity).restore(walletId) }
      }
    }
    AsyncFunction("discoverWallets") { walletId: String, throughCycle: Int, promise: Promise ->
      runCeremony(promise, timeoutMs = 300000L) { activity, store ->
        require(throughCycle in 0..1_000_000)
        val generation =
          store.load().use {
            check(it.id == walletId && it.verified)
            it.journalId
          }
        observeDepositDepartures(activity)
        if (
          !discoveryConsent.permits(walletId, generation, throughCycle, System.currentTimeMillis())
        ) {
          confirm(
            activity,
            "Discover wallet activity",
            "Read supported balances through cycle $throughCycle inclusive. This bound does not prove no further wallets exist. Discovery grants no spending authority.",
          )
          withTimeout(FOCUS_TIMEOUT_MS) {
            while (foreground && !activity.hasWindowFocus()) delay(FOCUS_POLL_INTERVAL_MS)
          }
          requireForeground(activity)
          discoveryConsent.approve(walletId, generation, throughCycle, System.currentTimeMillis())
        }
        withContext(Dispatchers.IO) {
          WalletRecoveryRuntime.engine(activity).discover(walletId, throughCycle)
        }
      }
    }
    AsyncFunction("getCapabilities") { promise: Promise ->
      promise.resolve(
        mapOf(
          "contractVersion" to 1,
          "confidentialWithdrawals" to eligible(appContext.currentActivity),
          "confidentialSaleProceeds" to eligible(appContext.currentActivity),
          "available" to eligible(appContext.currentActivity),
          "walletStorage" to eligible(appContext.currentActivity),
          "backup" to eligible(appContext.currentActivity),
          "walletRecovery" to eligible(appContext.currentActivity),
          "walletDiscovery" to eligible(appContext.currentActivity),
          "transfers" to eligible(appContext.currentActivity),
          "swaps" to eligible(appContext.currentActivity),
          "earnWallets" to eligible(appContext.currentActivity),
          "earnVaultExecution" to eligible(appContext.currentActivity),
          "earnSponsoredExecution" to eligible(appContext.currentActivity),
          "earnPrivatePayoutExecution" to eligible(appContext.currentActivity),
          "earnEthereumLiquidityExecution" to eligible(appContext.currentActivity),
          "earnDepositJourney" to eligible(appContext.currentActivity),
          "earnDepositDistribution" to eligible(appContext.currentActivity),
          "earnDepositPrivateFunding" to eligible(appContext.currentActivity),
          "earnBalanceDeltaSettlement" to eligible(appContext.currentActivity),
        )
      )
    }
    AsyncFunction("getWalletState") { promise: Promise ->
      runCeremony(promise) { _, store -> withContext(Dispatchers.IO) { publicState(store) } }
    }
    AsyncFunction("readEarnDepositFundingBalance") { request: Map<String, Any?>, promise: Promise ->
      runCeremony(promise, timeoutMs = 180000L) { activity, store ->
        check(request.keys == setOf("walletId"))
        val wallet = request["walletId"] as? String ?: error("Missing wallet")
        ensurePrivateReadPermission(activity, store, wallet)
        store.load().use { record ->
          check(record.id == wallet && record.verified)
          withContext(Dispatchers.IO) {
            assertCashoutInactive(activity, record)
            val portfolio = io.gizu.storedwallet.swap.MainnetPortfolio(activity)
            portfolio.invalidate(record)
            val public = portfolio.read(record, emptyList(), includeOwned = false)
            check(public["balanceComplete"] == true && public["stale"] == false) {
              "Public balance is still syncing"
            }
            val candidates = privateDepositCandidates(activity, record)
            val limit = kotlinx.coroutines.sync.Semaphore(4)
            val observations = coroutineScope {
              candidates
                .map { source ->
                  async {
                    limit.acquire()
                    try {
                      currentCoroutineContext().ensureActive()
                      source to
                        readPrivateDepositBalance(activity, record, source) {
                          requirePrivateReadPermission(activity, record)
                        }
                    } finally {
                      limit.release()
                    }
                  }
                }
                .awaitAll()
            }
            var private = java.math.BigInteger.ZERO
            for ((_, b) in observations) {
              val available = depositAtoms(b.getValue("available").toString())
              if (available >= PRIVATE_DEPOSIT_MINIMUM) private += available
            }
            check(
              observations.all {
                System.currentTimeMillis() -
                  (it.second.getValue("timestampMs") as Number).toLong() <= 60000
              }
            ) {
              "Private balance checks expired; retry before preparing this deposit"
            }
            val ledger = fundingReservations(activity, record)
            val publicAtoms =
              (public["accounts"] as List<*>).fold(java.math.BigInteger.ZERO) { sum, raw ->
                val account = raw as Map<*, *>
                val address = account["address"] as String
                val balance = depositAtoms(account["balanceAtoms"] as String)
                sum +
                  if (ledger.hasUnsettledSigned(address)) java.math.BigInteger.ZERO
                  else
                    maxOf(
                      java.math.BigInteger.ZERO,
                      balance - depositAtoms(ledger.reservedAtoms(address)),
                    )
              }
            mapOf(
              "publicAtoms" to publicAtoms.toString(),
              "privateAtoms" to private.toString(),
              "totalAtoms" to (private + publicAtoms).toString(),
              "complete" to true,
              "checkedAtMs" to System.currentTimeMillis(),
            )
          }
        }
      }
    }
    AsyncFunction("prepareEarnDeposit") {
      walletId: String,
      profile: String,
      budgetAtoms: String,
      draftId: String?,
      promise: Promise ->
      runCeremony(promise, timeoutMs = 180000L) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it, deposit = true) }
        check(profile == "robinhood-usdg") {
          "Guided native deposits currently support Robinhood USDG only"
        }
        depositAtoms(budgetAtoms, true)
        ensurePrivateReadPermission(activity, store, walletId)
        var id =
          store.load().use { record ->
            check(record.id == walletId && record.verified && !record.earnRecoveryRequired)
            store.prepareEarnDepositCycle(record, 4663, draftId, budgetAtoms)
          }
        withContext(Dispatchers.IO) { WalletRecoveryRuntime.beforeFreshFunding(activity, walletId) }
        // Recover a crash after the invested journal commit but before its allocation marker
        // commit.
        if (draftId == null)
          for (attempt in 0 until 256) {
            val old =
              store.load().use {
                earnDepositJournal(activity, it).all().singleOrNull { row ->
                  row.getString("journeyId") == id
                }
              }
            if (old?.getString("phase") != "invested") break
            store.load().use { store.completeEarnDepositCycle(it, id) }
            id = store.load().use { store.prepareEarnDepositCycle(it, 4663, null, budgetAtoms) }
          }
        store.load().use { record ->
          val journal = earnDepositJournal(activity, record)
          val existing = journal.all().singleOrNull { it.getString("journeyId") == id }
          if (existing != null && existing.getJSONObject("children").length() > 0)
            return@use journal.publicSnapshot(id)
          depositPreparingId = id
          try {
            nativeDepositPreparer(activity, record, journal) {
                requirePrivateReadPermission(activity, record)
              }
              .prepare(record, 4663, budgetAtoms, id)
          } finally {
            depositPreparingId = null
          }
          journal.publicSnapshot(id)
        }
      }
    }
    AsyncFunction("discardEarnDepositDraft") { walletId: String, draftId: String, promise: Promise
      ->
      runCeremony(promise) { activity, store ->
        store.load().use { record ->
          check(record.id == walletId && record.verified && !record.earnRecoveryRequired)
          val context = activity.applicationContext
          val journal = earnDepositJournal(context, record)
          val row = journal.get(draftId)
          check(
            row.getJSONObject("children").length() == 0 && row.getString("phase") != "invested"
          ) {
            "A started deposit must be reconciled before it can be changed"
          }
          val cycle =
            org.json.JSONArray(record.earnCycles).objects().single {
              it.optString("depositJourneyId") == draftId
            }
          check(cycle.has("distribution"))
          if (cycle.optBoolean("depositAbandoned")) return@use
          journal.cancelUnsignedReview(draftId) { batch ->
            if (!batch.startsWith("private_"))
              fundingReservations(context, record).cancelBatchUnsigned(batch)
          }
          journal.pause(draftId, "cancelled")
          store.selectEarnCycle(cycle.getInt("cycleIndex"))
          store.load().use { selected ->
            store.completeEarnDepositCycle(selected, draftId, abandoned = true)
          }
        }
        true
      }
    }
    AsyncFunction("confirmEarnDeposit") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      // Wait for a read-only status reconciliation instead of rejecting the user's action.
      runCeremony(promise, wait = true) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it, deposit = true) }
        val host = makeDepositHost(activity, store, walletId, id)
        depositHost = host
        host.confirm(id, revision, false)
      }
    }
    AsyncFunction("resumeEarnDeposit") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      // Wait for a read-only status reconciliation instead of rejecting the user's action.
      runCeremony(promise, wait = true) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it, deposit = true) }
        ensurePrivateReadPermission(activity, store, walletId)
        val row =
          store.load().use { record ->
            check(record.id == walletId && record.verified && !record.earnRecoveryRequired)
            earnDepositJournal(activity, record).recoverMissingReview(id).also {
              check(it.has("review")) { "Prepare a fresh deposit review before continuing." }
            }
          }
        store.selectEarnCycle(row.getInt("cycleIndex"))
        val fresh =
          store.load().use { record ->
            val journal = earnDepositJournal(activity, record)
            nativeDepositRemaining(
                activity,
                store,
                record,
                journal,
                foreground = { requireForeground(activity) },
                readAuthority = { requirePrivateReadPermission(activity, record) },
                readAuth = {
                  depositReconciliationReadAuth(
                    activity,
                    store,
                    record.id,
                    record.journalId,
                    record.earnCycleIndex,
                  )
                },
              )
              .refresh(record, id, revision)
          }
        val host = makeDepositHost(activity, store, walletId, id)
        depositHost = host
        host.confirm(id, fresh.getInt("revision"), true)
      }
    }
    AsyncFunction("findEarnDeposit") { walletId: String, profile: String, promise: Promise ->
      scope.launch {
        try {
          val activity = checkNotNull(appContext.currentActivity)
          requireForeground(activity)
          val snapshot =
            walletStore(activity).load().use { record ->
              check(record.id == walletId)
              earnDepositJournal(activity, record).pendingSnapshot(record, profile)
            }
          promise.resolve(snapshot)
        } catch (_: Exception) {
          promise.reject(
            "DEPOSIT_STATUS_UNAVAILABLE",
            "Saved deposit progress could not be checked. Retry before starting another deposit.",
            null,
          )
        }
      }
    }
    AsyncFunction("getEarnDepositStatus") { walletId: String, id: String, promise: Promise ->
      scope.launch {
        try {
          val activity = checkNotNull(appContext.currentActivity)
          requireForeground(activity)
          val store = walletStore(activity)
          val journal =
            store.load().use { record ->
              check(record.id == walletId && record.verified && !record.earnRecoveryRequired)
              earnDepositJournal(activity, record)
            }
          val lookupId =
            if (id == "current-deposit")
              store
                .load()
                .use { activeDepositDrafts(it, journal.all()) }
                .maxByOrNull { it.getInt("cycleIndex") }
                ?.getString("journeyId") ?: error("No saved deposit draft")
            else if (id.startsWith("intent:"))
              journal
                .all()
                .single { it.getString("intentId") == id.removePrefix("intent:") }
                .getString("journeyId")
            else id
          if (depositHost?.busy == true) promise.resolve(depositHost!!.status(lookupId))
          else {
            val row = journal.recoverMissingReview(lookupId)
            if (
              row.has("review") &&
                row.getString("phase") !in setOf("preparing", "review", "invested") &&
                ceremony.tryLock()
            ) {
              try {
                val matching =
                  store.load().use {
                    it.earnCycleIndex == row.getInt("cycleIndex") && it.earnChain == 4663
                  }
                if (matching)
                  depositCoordinator(activity, store, journal, row.getInt("cycleIndex"))
                    .reconcile(lookupId)
              } finally {
                ceremony.unlock()
              }
            }
            promise.resolve(journal.publicSnapshot(lookupId))
          }
        } catch (_: Exception) {
          promise.reject(
            "DEPOSIT_STATUS_UNAVAILABLE",
            "Saved deposit progress is unavailable. Reopen the wallet before retrying.",
            null,
          )
        }
      }
    }
    AsyncFunction("cancelEarnDeposit") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      scope.launch {
        try {
          val context = checkNotNull(appContext.reactContext)
          val journal =
            walletStore(context).load().use { record ->
              check(record.id == walletId && record.verified)
              earnDepositJournal(context, record)
            }
          check(revision in 1..journal.get(id).getInt("revision"))
          if (depositPreparingId == id) task?.cancel()
          if (depositHost?.busy == true) depositHost!!.cancel(id, revision)
          else journal.pause(id, "cancelled")
          releaseUnsignedDeposit(context, journal, id)
          promise.resolve(journal.publicSnapshot(id))
        } catch (_: Exception) {
          promise.reject(
            "DEPOSIT_CANCEL_UNAVAILABLE",
            "Check saved deposit progress. Cancellation cannot undo submitted funds.",
            null,
          )
        }
      }
    }
    AsyncFunction("createWallet") { promise: Promise ->
      runCeremony(promise) { activity, store -> createWallet(activity, store) }
    }
    AsyncFunction("openWallet") { promise: Promise ->
      runCeremony(promise) { activity, store ->
        val state = withContext(Dispatchers.IO) { store.state() }
        if (state["status"] == "absent" || state["status"] == "recoveryRequired") state
        else {
          val identity = withContext(Dispatchers.IO) { store.load().use { it.id to it.credential } }
          withProviderUi(activity) {
            PasskeyGate(activity).authorize(identity.second, identity.first)
          }
          currentCoroutineContext().ensureActive()
          val opened =
            withContext(Dispatchers.IO) {
              store.load().use {
                check(it.id == identity.first)
                it.journalId to project(it)
              }
            }
          requireForeground(activity)
          check(deviceUnlocked()) { "Unlock your device to read private balances" }
          privateUsdc.grant(identity.first, opened.first)
          opened.second
        }
      }
    }
    AsyncFunction("backupWallet") { promise: Promise ->
      runCeremony(promise) { activity, store ->
        check(
          withContext(Dispatchers.IO) {
            store.state()["status"] in listOf("backupRequired", "ready")
          }
        )
        withProviderUi(activity) { BackupHost.open(activity, false) }
        withContext(Dispatchers.IO) { publicState(store) }
      }
    }
    AsyncFunction("getEarnIntent") { walletId: String, promise: Promise ->
      runCeremony(promise) { _, store ->
        withContext(Dispatchers.IO) {
          store.load().use { record ->
            check(record.id == walletId && record.verified)
            earnPublic(record)
          }
        }
      }
    }
    AsyncFunction("listEarnInvestmentPositions") { walletId: String, promise: Promise ->
      runCeremony(promise) { activity, store ->
        withContext(Dispatchers.IO) {
          store.load().use { record -> readEarnInvestmentPositions(activity, record, walletId) }
        }
      }
    }
    AsyncFunction("listEarnIntents") { walletId: String, promise: Promise ->
      runCeremony(promise) { _, store ->
        store.load().use { record ->
          check(record.id == walletId && record.verified)
          val rows = org.json.JSONArray(record.earnCycles)
          if (rows.length() == 0)
            if (record.earnChain == 0) emptyList<Map<String, Any>>() else listOf(earnPublic(record))
          else
            (0 until rows.length()).map { i ->
              recordForCycle(record, rows.getJSONObject(i)).use { earnPublic(it) }
            }
        }
      }
    }
    AsyncFunction("selectEarnIntent") { walletId: String, intentId: String, promise: Promise ->
      runCeremony(promise) { _, store ->
        val index =
          store.load().use { record ->
            check(record.id == walletId && record.verified)
            val rows = org.json.JSONArray(record.earnCycles)
            (0 until rows.length())
              .map(rows::getJSONObject)
              .single { it.getString("intentId") == intentId }
              .getInt("cycleIndex")
          }
        store.selectEarnCycle(index)
        store.load().use { earnPublic(it) }
      }
    }
    AsyncFunction("selectEarnInvestmentSlot") {
      walletId: String,
      intentId: String,
      slot: Int,
      promise: Promise ->
      runCeremony(promise) { _, store ->
        val index =
          store.load().use { record ->
            check(record.id == walletId && record.verified)
            org.json
              .JSONArray(record.earnCycles)
              .objects()
              .single { it.getString("intentId") == intentId }
              .getInt("cycleIndex")
          }
        store.selectEarnInvestmentSlot(index, slot)
        store.load().use { earnPublic(it) }
      }
    }
    AsyncFunction("prepareNewEarnDistributionIntent") {
      walletId: String,
      profile: String,
      budgetAtoms: String,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        val chain =
          when (profile) {
            "ethereum-usdc" -> 1
            "robinhood-usdg" -> 4663
            else -> error("Unsupported earn profile")
          }
        depositAtoms(budgetAtoms, true)
        val credential =
          store.load().use { record ->
            check(record.id == walletId && record.verified && !record.earnRecoveryRequired)
            record.credential
          }
        confirm(
          activity,
          "Prepare investment wallets",
          "Create one to five investment wallets for this deposit. Every wallet invests in the same vault. Wallet count and weights are saved before quotes and preserved on retry. No funds move.",
        )
        withProviderUi(activity) {
          PasskeyGate(activity).authorize(credential, walletId, "earn-distribution:$profile")
        }
        currentCoroutineContext().ensureActive()
        store.load().use { store.allocateEarnCycle(it, chain, budgetAtoms) }
        store.load().use { earnPublic(it) }
      }
    }
    AsyncFunction("prepareNewEarnIntent") { walletId: String, profile: String, promise: Promise ->
      runCeremony(promise) { activity, store ->
        val chain =
          when (profile) {
            "ethereum-usdc" -> 1
            "robinhood-usdg" -> 4663
            else -> error("Unsupported earn profile")
          }
        val credential =
          store.load().use { record ->
            check(record.id == walletId && record.verified && !record.earnRecoveryRequired)
            record.credential
          }
        confirm(
          activity,
          "Prepare a new investment",
          "Create fresh holding and investment wallets using your existing private USDC balance. Previous investments remain available for withdrawal and recovery. No funds move.",
        )
        withProviderUi(activity) {
          PasskeyGate(activity).authorize(credential, walletId, "earn-new-cycle:$profile")
        }
        currentCoroutineContext().ensureActive()
        store.load().use { store.allocateEarnCycle(it, chain) }
        store.load().use { earnPublic(it) }
      }
    }
    AsyncFunction("planPublicFunding") { walletId: String, budgetAtoms: String, promise: Promise ->
      runCeremony(promise, timeoutMs = 180_000L) { activity, store ->
        store.load().use { record ->
          check(record.id == walletId && record.verified && !record.earnRecoveryRequired)
          NativeFundingPlanner(activity.applicationContext, record).plan(budgetAtoms)
        }
      }
    }
    AsyncFunction("prepareEarnSourceQuoteForAccount") {
      walletId: String,
      sourceIndex: Int,
      amountAtoms: String,
      operationId: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        val identity =
          store.load().use { record ->
            requireSponsoredWallet(record, walletId)
            Triple(
              record.earnChain,
              publicAccountAddress(record, sourceIndex),
              cycleConfidential(record),
            )
          }
        val quotes = store.load().use { earnQuoteJournal(activity, it) }
        NativeEarnQuoteGateway(quotes = quotes)
          .create(
            identity.first,
            operationId,
            revision,
            identity.second,
            identity.third,
            amountAtoms,
            false,
          )
      }
    }
    AsyncFunction("prepareEarnIntent") { walletId: String, profile: String, promise: Promise ->
      runCeremony(promise) { activity, store ->
        val chain =
          when (profile) {
            "ethereum-usdc" -> 1
            "robinhood-usdg" -> 4663
            else -> error("Unsupported earn profile")
          }
        val identity =
          withContext(Dispatchers.IO) {
            store.load().use {
              check(it.id == walletId && it.verified)
              check(it.earnChain == 0 || it.earnChain == chain || it.earnRecoveryRequired)
              Triple(it.credential, it.journalId, it.earnRecoveryRequired)
            }
          }
        val network = if (chain == 1) "Ethereum mainnet USDC" else "Robinhood mainnet USDG"
        confirm(
          activity,
          if (identity.third) "Recover earn wallets" else "Prepare two earn wallets",
          "Source: eligible funded Monad mainnet USDC accounts. Destination: $network. Wallet 1 holds 10%; wallet 2 invests 90% after fees. Both are covered by your verified backup. This creates no transfer or investment. " +
            if (identity.third) "Recovered wallets require activity reconciliation before funding."
            else "Confirm your passkey to prepare this intent.",
        )
        withProviderUi(activity) {
          PasskeyGate(activity).authorize(identity.first, walletId, "earn-wallets:v1:$profile")
        }
        currentCoroutineContext().ensureActive()
        withContext(Dispatchers.IO) {
          store.load().use {
            check(it.id == walletId && it.journalId == identity.second && it.verified)
            check(deriveEarnAddresses(it.entropy, chain.toULong()).size == 2)
            currentCoroutineContext().ensureActive()
            store.bindEarnChain(it, chain)
            store.load().use { committed -> earnPublic(committed) }
          }
        }
      }
    }
    AsyncFunction("readEarnBalance") { walletId: String, promise: Promise ->
      runCeremony(promise) { activity, store ->
        val identity =
          withContext(Dispatchers.IO) {
            store.load().use { record ->
              check(record.id == walletId && record.verified && record.earnChain in listOf(1, 4663))
              Triple(record.credential, record.journalId, record.earnChain)
            }
          }
        ensurePrivateReadPermission(activity, store, walletId)
        val api = ConfidentialBalance()
        val salt = api.salt()
        currentCoroutineContext().ensureActive()
        val random = ByteArray(7).also { SecureRandom().nextBytes(it) }
        val started = System.currentTimeMillis()
        val signed =
          withContext(Dispatchers.IO) {
            store.load().use { record ->
              check(
                record.id == walletId &&
                  record.journalId == identity.second &&
                  record.earnChain == identity.third &&
                  record.verified
              )
              requirePrivateReadPermission(activity, record)
              cycleConfidential(record) to
                cycleReadAuth(
                  record,
                  salt,
                  random,
                  started.toULong(),
                  System.currentTimeMillis().toULong(),
                )
            }
          }
        val result = api.read(signed.second, signed.first)
        currentCoroutineContext().ensureActive()
        withContext(Dispatchers.IO) {
          store.load().use {
            check(
              it.id == walletId && it.journalId == identity.second && it.earnChain == identity.third
            )
            val cache = io.gizu.storedwallet.portfolio.NativeOwnedConfidentialPortfolio(activity)
            cache.snapshot(it)
            cache.recordValidated(
              io.gizu.storedwallet.portfolio.NativeConfidentialTarget(
                it.id,
                it.journalId,
                signed.first.lowercase(),
                "earn",
                it.earnChain,
                it.earnCycleIndex,
              ),
              result,
            )
          }
        }
        result
      }
    }
    AsyncFunction("prepareEarnSourceQuote") {
      walletId: String,
      amountAtoms: String,
      operationId: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        val quotes =
          store.load().use { record ->
            requireSponsoredWallet(record, walletId)
            earnQuoteJournal(activity, record)
          }
        val identity =
          store.load().use { record ->
            requireSponsoredWallet(record, walletId)
            Triple(
              record.earnChain,
              deriveAccountAddresses(record.entropy)[0],
              cycleConfidential(record),
            )
          }
        val quote =
          NativeEarnQuoteGateway(quotes = quotes)
            .create(
              identity.first,
              operationId,
              revision,
              identity.second,
              identity.third,
              amountAtoms,
              false,
            )
        store.load().use { record ->
          requireSponsoredWallet(record, walletId)
          check(record.journalId == quotes.generation)
        }
        quote
      }
    }
    AsyncFunction("prepareEarnReturnQuote") {
      walletId: String,
      amountAtoms: String,
      operationId: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        val quotes =
          store.load().use { record ->
            requireSponsoredWallet(record, walletId)
            earnQuoteJournal(activity, record)
          }
        val identity =
          store.load().use { record ->
            requireSponsoredWallet(record, walletId)
            check(record.earnChain == 4663)
            cycleInvestmentAddress(record) to sharedConfidential(record)
          }
        val quote =
          NativeEarnQuoteGateway(quotes = quotes)
            .create(4663, operationId, revision, identity.first, identity.second, amountAtoms, true)
        store.load().use { record ->
          requireSponsoredWallet(record, walletId)
          check(record.journalId == quotes.generation)
        }
        quote
      }
    }
    AsyncFunction("registerEarnFundingPlans") {
      walletId: String,
      requests: List<Map<String, Any?>>,
      promise: Promise ->
      runCeremony(promise, timeoutMs = 180_000L) { activity, store ->
        check(requests.size in 1..128)
        val journal =
          store.load().use {
            requireSponsoredWallet(it, walletId)
            earnSponsoredJournal(activity, it)
          }
        val ledger = store.load().use { fundingReservations(activity, it) }
        val batchIds =
          requests
            .map { r ->
              check(r["walletId"] == walletId)
              val p = JSONObject(r["proposal"] as? Map<*, *> ?: error("Missing proposal"))
              check(
                p.getString("kind") == "sourceFunding" &&
                  p.getInt("chainId") == 143 &&
                  p.getInt("fundingBatchSize") == requests.size
              )
              p.getString("fundingBatchId")
            }
            .distinct()
        check(batchIds.size == 1)
        val ids = mutableSetOf<String>()
        val rows =
          EarnSponsoredEngine(
              store,
              journal,
              EarnSponsoredChainRpc(143),
              EarnSponsoredBundlerRpc(143),
              privateCreditRows = { address ->
                store.load().use { earnPrivateCreditRowsForSigning(activity, it, address) }
              },
              reservations = ledger,
            )
            .use { engine ->
              requests.map { r ->
                engine.create(r).also { check(ids.add(it.getString("operationId"))) }
              }
            }
        val batch = ledger.batch(batchIds.single())
        val legs = batch.getJSONArray("legs")
        check(
          legs.length() == rows.size &&
            (0 until legs.length())
              .map { legs.getJSONObject(it).getString("operationId") }
              .toSet() == ids
        )
        ledger.commitBatch(batchIds.single())
        rows.map { journal.public(it) }
      }
    }
    AsyncFunction("executeEarnFundingBatch") { walletId: String, batchId: String, promise: Promise
      ->
      runCeremony(promise, timeoutMs = 300_000L) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it) }
        approveEarnFundingBatch(activity, store, walletId, batchId)
      }
    }
    AsyncFunction("executeEarnSponsored") { request: Map<String, Any?>, promise: Promise ->
      runCeremony(promise) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it) }
        val walletId = request["walletId"] as? String ?: error("Missing wallet")
        val journal =
          store.load().use { record ->
            requireSponsoredWallet(record, walletId)
            earnSponsoredJournal(activity, record)
          }
        val chain =
          ((request["proposal"] as? Map<*, *>)?.get("chainId") as? Number)?.toInt()
            ?: error("Missing chain")
        EarnSponsoredEngine(
            store,
            journal,
            EarnSponsoredChainRpc(chain),
            EarnSponsoredBundlerRpc(chain),
            privateCreditRows = { address ->
              store.load().use { earnPrivateCreditRowsForSigning(activity, it, address) }
            },
            reservations = store.load().use { fundingReservations(activity, it) },
          )
          .use { engine ->
            val operation = engine.create(request)
            approveEarnSponsored(
              activity,
              store,
              engine,
              operation.getString("operationId"),
              operation.getInt("revision"),
            )
          }
      }
    }
    AsyncFunction("listEarnSponsoredOperations") { walletId: String, promise: Promise ->
      runCeremony(promise) { activity, store ->
        listSponsoredOperations(activity, store, walletId) { record, rows ->
          currentCycleRows(record, rows)
        }
      }
    }
    AsyncFunction("listEarnCycleOperations") {
      walletId: String,
      cycleIndex: Int,
      investmentSlot: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        check(cycleIndex >= 0 && investmentSlot >= -1 && investmentSlot <= 4)
        listSponsoredOperations(activity, store, walletId) { _, rows ->
          sponsoredRowsForPortion(rows, cycleIndex, investmentSlot)
        }
      }
    }
    AsyncFunction("resumeEarnSponsoredOperation") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it) }
        val journal =
          store.load().use { record ->
            requireSponsoredWallet(record, walletId)
            earnSponsoredJournal(activity, record)
          }
        val chain = journal.get(id).getJSONObject("proposal").getInt("chainId")
        EarnSponsoredEngine(
            store,
            journal,
            EarnSponsoredChainRpc(chain),
            EarnSponsoredBundlerRpc(chain),
            privateCreditRows = { address ->
              store.load().use { earnPrivateCreditRowsForSigning(activity, it, address) }
            },
            reservations = store.load().use { fundingReservations(activity, it) },
          )
          .use { engine -> approveEarnSponsored(activity, store, engine, id, revision) }
      }
    }
    AsyncFunction("continueEarnWithdrawal") { request: Map<String, Any?>, promise: Promise ->
      runCeremony(promise) { activity, store ->
        val walletId = request["walletId"] as? String ?: error("Missing wallet")
        val approval = checkNotNull(openWithdrawal) { "Withdrawal approval expired" }
        check(approval.walletId == walletId) { "Withdrawal approval expired" }
        val journal =
          store.load().use { record ->
            requireSponsoredWallet(record, walletId)
            check(record.journalId == approval.generation) { "Withdrawal approval expired" }
            earnSponsoredJournal(activity, record)
          }
        val proposal = JSONObject(request["proposal"] as? Map<*, *> ?: error("Missing proposal"))
        assertWithdrawalReturnAuthorized(
          approval,
          walletId,
          journal.generation,
          journal.get(approval.redeemId),
          proposal,
          System.currentTimeMillis(),
        )
        val chain = proposal.getInt("chainId")
        check(chain == 4663)
        EarnSponsoredEngine(
            store,
            journal,
            EarnSponsoredChainRpc(chain),
            EarnSponsoredBundlerRpc(chain),
            privateCreditRows = { address ->
              store.load().use { earnPrivateCreditRowsForSigning(activity, it, address) }
            },
            reservations = store.load().use { fundingReservations(activity, it) },
          )
          .use { engine ->
            val created = engine.create(request)
            val id = created.getString("operationId")
            try {
              assertWithdrawalReturnAuthorized(
                approval,
                walletId,
                journal.generation,
                journal.get(approval.redeemId),
                created.getJSONObject("proposal"),
                System.currentTimeMillis(),
              )
              var current = created.getInt("revision")
              var signed = false
              repeat(2) {
                val review = engine.prepare(id, current)
                try {
                  engine.execute(review) {
                    requireForeground(activity)
                    store.load().use { record ->
                      requireSponsoredWallet(record, walletId)
                      check(record.journalId == approval.generation)
                      assertWithdrawalReturnAuthorized(
                        approval,
                        walletId,
                        record.journalId,
                        journal.get(approval.redeemId),
                        journal.get(id).getJSONObject("proposal"),
                        System.currentTimeMillis(),
                      )
                    }
                  }
                } catch (failure: Exception) {
                  if (
                    failure is CancellationException || !journal.get(id).has("signedUserOperation")
                  )
                    throw failure
                  signed = true
                  return@use journal.public(journal.get(id))
                }
                signed = journal.get(id).has("signedUserOperation")
                current = journal.get(id).getInt("revision")
                if (review.kind != "delegation") return@use journal.public(journal.get(id))
              }
              check(signed)
              journal.public(journal.get(id))
            } finally {
              if (journal.get(id).has("signedUserOperation")) openWithdrawal = null
              else if (!journal.get(id).sponsoredSpendSaved())
                runCatching { journal.cancel(id, journal.get(id).getInt("revision")) }
            }
          }
      }
    }
    AsyncFunction("cancelEarnSponsoredOperation") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        val journal =
          store.load().use { record ->
            requireSponsoredWallet(record, walletId)
            earnSponsoredJournal(activity, record)
          }
        val operation = journal.get(id)
        val p = operation.getJSONObject("proposal")
        store.load().use { record ->
          requireActiveEarnCycle(record, p)
          fundingReservations(activity, record).assertCancellationAllowed(id)
        }
        if (p.has("fundingBatchId"))
          check(
            journal.all().none { row ->
              row.getJSONObject("proposal").optString("fundingBatchId") ==
                p.getString("fundingBatchId") && row.sponsoredSpendSaved()
            }
          ) {
            "Resume the remaining funding source; this investment has started"
          }
        val cancelled = journal.cancel(id, revision)
        store.load().use { fundingReservations(activity, it).cancelUnsigned(id) }
        journal.public(cancelled)
      }
    }
    AsyncFunction("readEarnSponsoredSettlement") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise, timeoutMs = 180_000L) { activity, store ->
        val journal =
          store.load().use { record ->
            requireSponsoredWallet(record, walletId)
            earnSponsoredJournal(activity, record)
          }
        check(journal.get(id).getInt("revision") == revision)
        val chain = journal.get(id).getJSONObject("proposal").getInt("chainId")
        reconcileEarnSponsoredOperations(
          journal,
          EarnSponsoredChainRpc(chain),
          EarnSponsoredBundlerRpc(chain),
          chainFilter = chain,
          operationIds = setOf(id),
        )
        val operation = journal.get(id)
        val expected = sponsoredSettlementExpected(operation)
        android.util.Log.i("GizuSettlement", sponsoredSettlementReadFacts(operation))
        val identity =
          store.load().use { record ->
            requireSponsoredWallet(record, walletId)
            check(record.journalId == journal.generation)
            requireActiveEarnCycle(record, operation.getJSONObject("proposal"))
            requirePrivateReadPermission(activity, record)
            record.earnChain
          }
        val salt = ConfidentialBalance().salt()
        val random = ByteArray(7).also { SecureRandom().nextBytes(it) }
        val started = System.currentTimeMillis()
        val auth =
          store.load().use { record ->
            requireSponsoredWallet(record, walletId)
            check(record.journalId == journal.generation && record.earnChain == identity)
            requirePrivateReadPermission(activity, record)
            requireEarnConfidentialAccount(record, expected.getString("confidentialAccount"))
            cycleReadAuth(
              record,
              salt,
              random,
              started.toULong(),
              System.currentTimeMillis().toULong(),
              expected.getString("confidentialAccount"),
            )
          }
        val proof = readNativeSponsoredSettlement(auth, expected, operation)
        currentCoroutineContext().ensureActive()
        requireForeground(activity)
        store.load().use { record ->
          requireSponsoredWallet(record, walletId)
          check(record.journalId == journal.generation && record.earnChain == identity)
          requireActiveEarnCycle(record, operation.getJSONObject("proposal"))
          requirePrivateReadPermission(activity, record)
          requireEarnConfidentialAccount(record, expected.getString("confidentialAccount"))
        }
        store.load().use { record ->
          invalidateEarnPrivateCreditCaches(activity, record, operation, proof)
        }
        val committed =
          journal.update(id, operation.getInt("revision")) {
            saveSponsoredSettlement(it, proof, walletId, journal.generation)
          }
        store.load().use { record -> fundingReservations(activity, record).complete(id) }
        journal.public(committed)
      }
    }
    AsyncFunction("executeEarnWithdrawal") {
      walletId: String,
      returnOperationId: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { _, _ ->
        error(
          "New public payouts are created only through Withdraw from Gizu. Resume saved legacy withdrawals from their recovery controls."
        )
      }
    }
    AsyncFunction("listEarnWithdrawalOperations") { walletId: String, promise: Promise ->
      runCeremony(promise) { activity, store ->
        store.load().use { record ->
          requireSponsoredWallet(record, walletId)
          val journal = earnWithdrawalJournal(activity, record)
          currentCycleRows(record, journal.all()).map { journal.public(it) }
        }
      }
    }
    AsyncFunction("resumeEarnWithdrawalOperation") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it) }
        withdrawalEngine(activity, store, walletId).use {
          approveEarnWithdrawal(activity, store, it, id, revision)
        }
      }
    }
    AsyncFunction("cancelEarnWithdrawalOperation") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        store.load().use { record ->
          requireSponsoredWallet(record, walletId)
          val journal = earnWithdrawalJournal(activity, record)
          requireActiveEarnCycle(record, journal.get(id).getJSONObject("proposal"))
          journal.public(journal.cancelUnsigned(id, revision))
        }
      }
    }
    AsyncFunction("readEarnWithdrawalSettlement") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        withdrawalEngine(activity, store, walletId).use { engine ->
          engine.journal.public(engine.reconcile(id, revision))
        }
      }
    }
    AsyncFunction("executeEarnPrivatePayout") { request: Map<String, Any?>, promise: Promise ->
      runCeremony(promise) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it) }
        val walletId = request["walletId"] as? String ?: error("Missing wallet")
        payoutEngine(activity, store, walletId).use { engine ->
          val op = engine.create(request)
          approveEarnPayout(
            activity,
            store,
            engine,
            op.getString("operationId"),
            op.getInt("revision"),
          )
        }
      }
    }
    AsyncFunction("listEarnPrivatePayoutOperations") { walletId: String, promise: Promise ->
      runCeremony(promise) { activity, store ->
        val journal =
          store.load().use { record ->
            requireSponsoredWallet(record, walletId)
            earnPayoutJournal(activity, record)
          }
        store.load().use { record ->
          currentCycleRows(record, journal.all())
            .filter { it.getJSONObject("proposal").getString("kind") != "privateEarnPayout" }
            .map { journal.public(it) }
        }
      }
    }
    AsyncFunction("resumeEarnPrivatePayoutOperation") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it) }
        payoutEngine(activity, store, walletId).use { engine ->
          var op = engine.journal.get(id)
          check(op.getJSONObject("proposal").getString("kind") != "privateEarnPayout") {
            "Resume this payout from its saved deposit"
          }
          check(op.getInt("revision") == revision)
          if (op.has("signedData")) op = engine.reconcile(id, revision)
          if (
            !op.has("signedData") &&
              !op.optBoolean("signingAuthorizationPending", false) &&
              op.getString("status") in setOf("planned", "cancelled") ||
              op.getString("status") == "submissionUnknown" &&
                op.getJSONObject("proposal").getLong("deadlineMs") > System.currentTimeMillis()
          )
            approveEarnPayout(activity, store, engine, id, op.getInt("revision"))
          else engine.journal.public(op)
        }
      }
    }
    AsyncFunction("cancelEarnPrivatePayoutOperation") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        val journal =
          store.load().use { record ->
            requireSponsoredWallet(record, walletId)
            earnPayoutJournal(activity, record)
          }
        check(journal.get(id).getJSONObject("proposal").getString("kind") != "privateEarnPayout") {
          "Cancel this payout from its saved deposit"
        }
        journal.public(journal.cancelUnsigned(id, revision))
      }
    }
    AsyncFunction("readEarnPrivatePayoutSettlement") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        payoutEngine(activity, store, walletId).use { engine ->
          check(
            engine.journal.get(id).getJSONObject("proposal").getString("kind") !=
              "privateEarnPayout"
          ) {
            "Check this payout from its saved deposit"
          }
          engine.journal.public(engine.reconcile(id, revision))
        }
      }
    }
    AsyncFunction("prepareEarnFusionQuote") { request: Map<String, Any?>, promise: Promise ->
      runCeremony(promise) { _, store ->
        check(
          request.keys ==
            setOf(
              "walletId",
              "operationId",
              "revision",
              "inputAtoms",
              "resolverGasPriceWei",
              "minimumEthWei",
              "maximumResolverOverheadWei",
              "fundingMode",
            )
        )
        val walletId = request["walletId"] as? String ?: error("Missing wallet")
        val identity =
          store.load().use { record ->
            requireEarnExecutionWallet(record, walletId)
            Triple(record.journalId, cycleInvestmentAddress(record), cycleConfidential(record))
          }
        val body = JSONObject(request)
        body.remove("walletId")
        val mode = body.getString("fundingMode")
        check(mode in setOf("permit", "allowance"))
        body.remove("fundingMode")
        body
          .put("owner", identity.second)
          .put("confidentialAccount", identity.third)
          .put("executionRequested", false)
        val gateway = NativeFusionGateway()
        val quote = gateway.quote(body)
        check(
          quote.binding.operationId == body.getString("operationId") &&
            quote.binding.revision == body.getLong("revision").toULong() &&
            quote.binding.owner.equals(identity.second, true) &&
            quote.binding.confidentialAccount.equals(identity.third, true)
        )
        check(
          quote.binding.inputAtoms == body.getString("inputAtoms") &&
            quote.binding.minimumEthWei.toBigInteger() >=
              body.getString("minimumEthWei").toBigInteger()
        )
        store.load().use { record ->
          requireEarnExecutionWallet(record, walletId)
          check(record.journalId == identity.first)
        }
        gateway.public(quote)
      }
    }
    AsyncFunction("prepareEarnEthereumReturnQuote") {
      walletId: String,
      amountAtoms: String,
      operationId: String,
      revision: Int,
      returnAsset: String,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        val quotes =
          store.load().use { record ->
            requireEarnExecutionWallet(record, walletId)
            earnQuoteJournal(activity, record)
          }
        val identity =
          store.load().use { record ->
            requireEarnExecutionWallet(record, walletId)
            Triple(record.journalId, cycleInvestmentAddress(record), sharedConfidential(record))
          }
        val quote =
          NativeEarnQuoteGateway(quotes = quotes)
            .create(
              1,
              operationId,
              revision,
              identity.second,
              identity.third,
              amountAtoms,
              true,
              returnAsset,
            )
        store.load().use { record ->
          requireEarnExecutionWallet(record, walletId)
          check(record.journalId == identity.first)
        }
        quote
      }
    }
    AsyncFunction("executeEarnEthereumLiquidity") { request: Map<String, Any?>, promise: Promise ->
      runCeremony(promise) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it) }
        val walletId = request["walletId"] as? String ?: error("Missing wallet")
        val journal =
          store.load().use { record ->
            requireEarnExecutionWallet(record, walletId)
            check(
              !currentCycleRows(record, earnVaultJournal(activity, record).all()).any {
                it.earnBlocked()
              }
            )
            earnLiquidityJournal(activity, record)
          }
        EarnLiquidityEngine(
            store,
            journal,
            EthereumEarnRpc(),
            privateCreditRows = { address ->
              store.load().use { earnPrivateCreditRowsForSigning(activity, it, address) }
            },
          )
          .use { engine ->
            val operation = engine.create(request)
            approveEarnLiquidity(
              activity,
              store,
              engine,
              operation.getString("operationId"),
              operation.getInt("revision"),
            )
          }
      }
    }
    AsyncFunction("listEarnEthereumLiquidityOperations") { walletId: String, promise: Promise ->
      runCeremony(promise) { activity, store ->
        val journal =
          store.load().use { record ->
            requireEarnExecutionWallet(record, walletId)
            earnLiquidityJournal(activity, record)
          }
        reconcileEarnLiquidityOperations(journal, EthereumEarnRpc(), NativeFusionGateway())
        store.load().use { record ->
          currentCycleRows(record, journal.all()).map { journal.public(it) }
        }
      }
    }
    AsyncFunction("resumeEarnEthereumLiquidityOperation") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it) }
        val journal =
          store.load().use { record ->
            requireEarnExecutionWallet(record, walletId)
            check(
              !currentCycleRows(record, earnVaultJournal(activity, record).all()).any {
                it.earnBlocked()
              }
            )
            earnLiquidityJournal(activity, record)
          }
        EarnLiquidityEngine(
            store,
            journal,
            EthereumEarnRpc(),
            privateCreditRows = { address ->
              store.load().use { earnPrivateCreditRowsForSigning(activity, it, address) }
            },
          )
          .use { engine -> approveEarnLiquidity(activity, store, engine, id, revision) }
      }
    }
    AsyncFunction("cancelEarnEthereumLiquidityOperation") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        val journal =
          store.load().use { record ->
            requireEarnExecutionWallet(record, walletId)
            earnLiquidityJournal(activity, record)
          }
        journal.public(journal.cancel(id, revision))
      }
    }
    AsyncFunction("cancelPendingEarnEthereumLiquidityOperation") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        val journal =
          store.load().use { record ->
            requireEarnExecutionWallet(record, walletId)
            check(
              !currentCycleRows(record, earnVaultJournal(activity, record).all()).any {
                it.earnBlocked()
              }
            )
            earnLiquidityJournal(activity, record)
          }
        EarnLiquidityCancellationEngine(store, journal, EthereumEarnRpc()).use { engine ->
          approveEarnLiquidityCancellation(activity, store, engine, id, revision)
        }
      }
    }
    AsyncFunction("readEarnEthereumLiquiditySettlement") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise, timeoutMs = 180_000L) { activity, store ->
        val journal =
          store.load().use { record ->
            requireEarnExecutionWallet(record, walletId)
            earnLiquidityJournal(activity, record)
          }
        check(journal.get(id).getInt("revision") == revision)
        reconcileEarnLiquidityOperations(journal, EthereumEarnRpc(), NativeFusionGateway())
        val operation = journal.get(id)
        val expected = sponsoredSettlementExpected(operation)
        val credential =
          store.load().use { record ->
            requireEarnExecutionWallet(record, walletId)
            check(record.journalId == journal.generation)
            requireActiveEarnCycle(record, operation.getJSONObject("proposal"))
            requireEarnConfidentialAccount(record, expected.getString("confidentialAccount"))
            record.credential
          }
        confirm(
          activity,
          "Review returned asset settlement",
          "Verify this return using its saved balance snapshot and authenticated private balance.\nOperation $id\nOrigin transaction ${expected.getString("transactionHash")}\nDeposit ${expected.getString("depositAddress")}\nMinimum private credit ${expected.getString("minimumCreditAtoms")} atoms",
          fullReview = true,
        )
        withProviderUi(activity) {
          PasskeyGate(activity)
            .authorize(
              credential,
              walletId,
              "earn-liquidity-settlement:v1:$id:${operation.getInt("revision")}:${operation.getString("transactionHash")}",
            )
        }
        val salt = ConfidentialBalance().salt()
        val random = ByteArray(7).also { SecureRandom().nextBytes(it) }
        val started = System.currentTimeMillis()
        val auth =
          store.load().use { record ->
            requireEarnExecutionWallet(record, walletId)
            check(record.journalId == journal.generation)
            requireActiveEarnCycle(record, operation.getJSONObject("proposal"))
            requireEarnConfidentialAccount(record, expected.getString("confidentialAccount"))
            cycleReadAuth(
              record,
              salt,
              random,
              started.toULong(),
              System.currentTimeMillis().toULong(),
              expected.getString("confidentialAccount"),
            )
          }
        val proof = readNativeSponsoredSettlement(auth, expected, operation)
        currentCoroutineContext().ensureActive()
        requireForeground(activity)
        store.load().use { record ->
          requireEarnExecutionWallet(record, walletId)
          check(record.journalId == journal.generation)
          requireActiveEarnCycle(record, operation.getJSONObject("proposal"))
          requireEarnConfidentialAccount(record, expected.getString("confidentialAccount"))
        }
        store.load().use { record ->
          invalidateEarnPrivateCreditCaches(activity, record, operation, proof)
        }
        journal.public(
          journal.update(id, operation.getInt("revision")) {
            saveSponsoredSettlement(it, proof, walletId, journal.generation)
          }
        )
      }
    }
    AsyncFunction("executeEarnVault") { request: Map<String, Any?>, promise: Promise ->
      runCeremony(promise) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it) }
        val walletId = request["walletId"] as? String ?: error("Missing wallet")
        val journal =
          store.load().use { record ->
            requireEarnExecutionWallet(record, walletId)
            check(
              !currentCycleRows(record, earnLiquidityJournal(activity, record).all()).any {
                it.liquidityBlocked()
              }
            )
            earnVaultJournal(activity, record)
          }
        EarnVaultEngine(store, journal, EthereumEarnRpc()).use { engine ->
          val operation = engine.create(request)
          approveEarnVault(
            activity,
            store,
            engine,
            operation.getString("operationId"),
            operation.getInt("revision"),
          )
        }
      }
    }
    AsyncFunction("listEarnVaultOperations") { walletId: String, promise: Promise ->
      runCeremony(promise) { activity, store ->
        val journal =
          store.load().use { record ->
            requireEarnExecutionWallet(record, walletId)
            earnVaultJournal(activity, record)
          }
        reconcileEarnVaultOperations(journal, EthereumEarnRpc())
        store.load().use { record ->
          currentCycleRows(record, journal.all()).map { journal.public(it) }
        }
      }
    }
    AsyncFunction("resumeEarnVaultOperation") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it) }
        val journal =
          store.load().use { record ->
            requireEarnExecutionWallet(record, walletId)
            check(
              !currentCycleRows(record, earnLiquidityJournal(activity, record).all()).any {
                it.liquidityBlocked()
              }
            )
            earnVaultJournal(activity, record)
          }
        EarnVaultEngine(store, journal, EthereumEarnRpc()).use { engine ->
          approveEarnVault(activity, store, engine, id, revision)
        }
      }
    }
    AsyncFunction("cancelEarnVaultOperation") {
      walletId: String,
      id: String,
      revision: Int,
      promise: Promise ->
      runCeremony(promise) { activity, store ->
        val journal =
          store.load().use { record ->
            requireEarnExecutionWallet(record, walletId)
            earnVaultJournal(activity, record)
          }
        journal.public(journal.update(id, revision) { it.put("cancelled", true) })
      }
    }
    AsyncFunction("restoreWallet") { promise: Promise ->
      runCeremony(promise) { activity, store ->
        if (
          withContext(Dispatchers.IO) {
            store.state()["status"] !in listOf("absent", "recoveryRequired")
          }
        )
          throw WalletExists()
        withProviderUi(activity) { BackupHost.open(activity, true) }
        withContext(Dispatchers.IO) { publicState(store) }
      }
    }
    AsyncFunction("executeOperation") { proposal: Map<String, Any?>, promise: Promise ->
      runCeremony(promise) { activity, store ->
        val journal = store.load().use { operationJournal(activity, it) }
        reconcileOperations(journal, MonadRpc())
        val operation = store.load().use { createOperation(journal, it, proposal) }
        withProviderUi(activity) {
          TransferHost.open(
            activity,
            operation.getString("operationId"),
            operation.getInt("revision"),
          )
        }
        journal.public(journal.get(operation.getString("operationId")))
      }
    }
    AsyncFunction("listOperations") { promise: Promise ->
      runCeremony(promise) { activity, store ->
        val journal = store.load().use { operationJournal(activity, it) }
        reconcileOperations(journal, MonadRpc())
        journal.all().map { journal.public(it) }
      }
    }
    AsyncFunction("getOperationStatus") { id: String, promise: Promise ->
      runCeremony(promise) { activity, store ->
        val journal = store.load().use { operationJournal(activity, it) }
        reconcileOperations(journal, MonadRpc())
        journal.public(journal.get(id))
      }
    }
    AsyncFunction("resumeOperation") { id: String, revision: Int, promise: Promise ->
      runCeremony(promise) { activity, store ->
        val journal = store.load().use { operationJournal(activity, it) }
        check(journal.get(id).getInt("revision") == revision)
        withProviderUi(activity) { TransferHost.open(activity, id, revision) }
        journal.public(journal.get(id))
      }
    }
    AsyncFunction("cancelOperation") { id: String, promise: Promise ->
      scope.launch {
        if (TransferHost.id == id) task?.cancel()
        runCeremony(promise, wait = true) { activity, store ->
          val journal = store.load().use { operationJournal(activity, it) }
          journal.public(journal.cancel(id))
        }
      }
    }
    AsyncFunction("getSwapDeposit") { promise: Promise ->
      runCeremony(promise, readOnly = true) { _, store ->
        withContext(Dispatchers.IO) {
          store.load().use { record ->
            check(record.verified)
            mapOf("fundingAddress" to deriveAccountAddressRange(record.entropy, 1u, 1u).single())
          }
        }
      }
    }
    AsyncFunction("startSwap") {
      target: String,
      amountAtoms: String,
      gateway: String,
      promise: Promise ->
      runCeremony(promise, timeoutMs = 900_000L) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it) }
        withProviderUi(activity) {
          SwapHost.open(activity, gateway, target, amountAtoms.ifBlank { null }, false)
        }
      }
    }
    AsyncFunction("startPayout") { target: String, gateway: String, promise: Promise ->
      runCeremony(promise, timeoutMs = 900_000L) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it) }
        withProviderUi(activity) {
          SwapHost.open(activity, gateway, target, null, false, payout = true)
        }
      }
    }
    AsyncFunction("startRecovery") { target: String, gateway: String, promise: Promise ->
      runCeremony(promise, timeoutMs = 900_000L) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it) }
        withProviderUi(activity) {
          SwapHost.open(activity, gateway, target, null, false, recovery = true)
        }
      }
    }
    AsyncFunction("getConfidentialWithdrawal") { walletId: String, promise: Promise ->
      runCeremony(promise) { activity, store ->
        withContext(Dispatchers.IO) {
          store.load().use { record ->
            check(record.id == walletId && record.verified)
            val journal = confidentialWithdrawalJournal(activity, record)
            journal.active()?.let { journal.public(it) }
          }
        }
      }
    }
    AsyncFunction("prepareConfidentialWithdrawal") { request: Map<String, Any?>, promise: Promise ->
      runCeremony(promise, timeoutMs = 900_000L) { activity, store ->
        check(request.keys == setOf("walletId", "amountAtoms"))
        val wallet = request["walletId"] as? String ?: error("Missing wallet")
        ensurePrivateReadPermission(activity, store, wallet)
        withContext(Dispatchers.IO) {
          cashoutEngine(activity, store, wallet)
            .prepare(request["amountAtoms"] as? String ?: error("Missing exact amount"))
        }
      }
    }
    AsyncFunction("executeConfidentialWithdrawal") { request: Map<String, Any?>, promise: Promise ->
      runCeremony(promise, timeoutMs = 900_000L) { activity, store ->
        check(request.keys == setOf("walletId", "operationId", "revision"))
        val wallet = request["walletId"] as? String ?: error("Missing wallet")
        ensurePrivateReadPermission(activity, store, wallet)
        val revision = request["revision"] as? Number ?: error("Missing revision")
        check(revision.toDouble() == revision.toInt().toDouble() && revision.toInt() > 0)
        runCashout(
          activity,
          store,
          wallet,
          request["operationId"] as? String ?: error("Missing operation"),
          revision.toInt(),
        )
      }
    }
    AsyncFunction("resumeConfidentialWithdrawal") { request: Map<String, Any?>, promise: Promise ->
      runCeremony(promise, timeoutMs = 900_000L) { activity, store ->
        check(request.keys == setOf("walletId", "operationId"))
        val wallet = request["walletId"] as? String ?: error("Missing wallet")
        val id = request["operationId"] as? String ?: error("Missing operation")
        ensurePrivateReadPermission(activity, store, wallet)
        val revision =
          store.load().use { record ->
            confidentialWithdrawalJournal(activity, record).get(id).getInt("revision")
          }
        runCashout(activity, store, wallet, id, revision)
      }
    }
    AsyncFunction("cancelConfidentialWithdrawal") { request: Map<String, Any?>, promise: Promise ->
      runCeremony(promise) { activity, store ->
        check(request.keys == setOf("walletId", "operationId"))
        store.load().use { record ->
          check(record.verified && record.id == request["walletId"])
          val journal = confidentialWithdrawalJournal(activity, record)
          val id = request["operationId"] as? String ?: error("Missing operation")
          journal.cancel(id)
          journal.public(journal.get(id))
        }
      }
    }
    AsyncFunction("getCachedMainnetPortfolio") { promise: Promise ->
      runCeremony(promise, readOnly = true) { activity, store ->
        withContext(Dispatchers.IO) {
          store.load().use { record ->
            check(record.verified)
            val saved = SwapStore(activity.applicationContext, record)
            val snapshot =
              io.gizu.storedwallet.swap
                .MainnetPortfolio(activity.applicationContext)
                .read(record, saved.portfolio.history(), cachedOnly = true)
            val confidential =
              io.gizu.storedwallet.portfolio
                .NativeOwnedConfidentialPortfolio(activity)
                .snapshot(record)
            privateUsdc.onDeviceState(interactive = deviceUnlocked(), locked = false)
            val authorized = privateUsdc.allows(record.id, record.journalId)
            snapshot +
              confidential +
              mapOf(
                "confidentialReadState" to
                  if (!authorized) "locked"
                  else if (confidential["confidentialComplete"] == true) "ready" else "partial",
                "ownedAssets" to
                  ((snapshot["ownedAssets"] as? List<*> ?: emptyList<Any>()) +
                    (confidential["ownedAssets"] as List<*>)),
              )
          }
        }
      }
    }
    AsyncFunction("getMainnetPortfolio") { promise: Promise ->
      runCeremony(promise, timeoutMs = 180_000L, readOnly = true) { activity, store ->
        withContext(Dispatchers.IO) {
          store.load().use { record ->
            check(record.verified)
            val saved = SwapStore(activity.applicationContext, record)
            saved.load()?.let { root ->
              val op =
                uniffi.gizu_stored_signer_core.SwapOperation.restore(
                  root.getString("state"),
                  "https://api.gizu.io",
                )
              try {
                saved.portfolio.remember(root.getString("state"), op.publicStatus())
              } finally {
                op.close()
              }
            }
            coroutineScope {
              val public = async {
                io.gizu.storedwallet.swap
                  .MainnetPortfolio(activity.applicationContext)
                  .read(record, saved.portfolio.history(), forceRefresh = true)
              }
              val private = async {
                try {
                  val cache =
                    io.gizu.storedwallet.portfolio.NativeOwnedConfidentialPortfolio(activity)
                  privateUsdc.onDeviceState(interactive = deviceUnlocked(), locked = false)
                  val authorized = privateUsdc.allows(record.id, record.journalId)
                  val api = ConfidentialBalance()
                  cache.refresh(record, authorized, { api.salt() }) { target, salt ->
                    currentCoroutineContext().ensureActive()
                    requirePrivateReadPermission(activity, record)
                    val started = System.currentTimeMillis()
                    val random = ByteArray(7).also { SecureRandom().nextBytes(it) }
                    val auth =
                      if (target.kind == "swap")
                        uniffi.gizu_stored_signer_core.authenticateSwapRead(
                          record.entropy,
                          salt,
                          random,
                          started.toULong(),
                          System.currentTimeMillis().toULong(),
                        )
                      else
                        uniffi.gizu_stored_signer_core.authenticateEarnCycleRead(
                          record.entropy,
                          target.profileChainId.toULong(),
                          target.cycleIndex.toUInt(),
                          salt,
                          random,
                          started.toULong(),
                          System.currentTimeMillis().toULong(),
                        )
                    api.read(auth, target.address)
                  }
                } catch (cancelled: CancellationException) {
                  throw cancelled
                } catch (_: Exception) {
                  mapOf(
                    "ownedAssets" to emptyList<Any>(),
                    "confidentialComplete" to false,
                    "confidentialStale" to true,
                    "confidentialSyncPending" to true,
                    "confidentialReadRequired" to true,
                    "confidentialCheckedAt" to 0L,
                    "confidentialReadState" to "unavailable",
                  )
                }
              }
              val snapshot = public.await()
              val confidential = private.await()
              val assets =
                (snapshot["ownedAssets"] as? List<*> ?: emptyList<Any>()) +
                  (confidential["ownedAssets"] as List<*>)
              snapshot + confidential + mapOf("ownedAssets" to assets)
            }
          }
        }
      }
    }
    AsyncFunction("getSwapHoldings") { target: String, promise: Promise ->
      runCeremony(promise, timeoutMs = 180_000L, readOnly = true) { activity, store ->
        withContext(Dispatchers.IO) {
          store.load().use { record ->
            check(record.verified)
            val saved = SwapStore(activity.applicationContext, record)
            saved.load()?.let { root ->
              val previous =
                uniffi.gizu_stored_signer_core.SwapOperation.restore(
                  root.getString("state"),
                  "https://api.gizu.io",
                )
              try {
                saved.portfolio.remember(root.getString("state"), previous.publicStatus())
              } finally {
                previous.close()
              }
            }
            val targets =
              saved.portfolio.targets() +
                listOfNotNull(target.lowercase().takeIf { it.isNotBlank() })
            val snapshot =
              withTimeoutOrNull(8_000L) {
                io.gizu.storedwallet.swap.SwapHoldings().read(record, targets)
              } ?: throw io.gizu.storedwallet.portfolio.PortfolioReadTimeout()
            if (target.isNotBlank()) saved.portfolio.watch(target)
            snapshot
          }
        }
      }
    }
    AsyncFunction("sellSwapHolding") { holdingId: String, gateway: String, promise: Promise ->
      runCeremony(promise, timeoutMs = 900_000L) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it) }
        withProviderUi(activity) {
          SwapHost.open(activity, gateway, null, null, false, sell = true, holdingId = holdingId)
        }
      }
    }
    AsyncFunction("startSell") { gateway: String, promise: Promise ->
      runCeremony(promise, timeoutMs = 900_000L) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it) }
        withProviderUi(activity) { SwapHost.open(activity, gateway, null, null, false, true) }
      }
    }
    AsyncFunction("resumeSwap") { gateway: String, promise: Promise ->
      runCeremony(promise, timeoutMs = 900_000L) { activity, store ->
        store.load().use { assertCashoutInactive(activity, it) }
        withProviderUi(activity) { SwapHost.open(activity, gateway, null, null, true) }
      }
    }
    AsyncFunction("getSwapStatus") { gateway: String, promise: Promise ->
      runCeremony(promise, readOnly = true) { activity, store ->
        withContext(Dispatchers.IO) {
          store.load().use { record ->
            val saved = SwapStore(activity.applicationContext, record)
            if (saved.load() == null) return@use mapOf("phase" to "NONE")
            SwapEngine(store, saved, gateway).use { engine ->
              engine.restore()
              engine.view()
            }
          }
        }
      }
    }
    AsyncFunction("cancelSwap") { gateway: String, promise: Promise ->
      scope.launch {
        if (SwapHost.token != null) task?.cancel()
        runCeremony(promise, wait = true) { activity, store ->
          withContext(Dispatchers.IO) {
            store.load().use { record ->
              SwapEngine(store, SwapStore(activity.applicationContext, record), gateway).use {
                engine ->
                engine.restore()
                engine.cancel()
                engine.view()
              }
            }
          }
        }
      }
    }
    Function("lock") {
      privateUsdc.clear()
      cancelWalletWork()
    }
    Function("cancelWalletOperation") { cancelWalletWork() }
    OnActivityEntersForeground {
      privateUsdc.onDeviceState(interactive = deviceUnlocked(), locked = false)
      foreground = true
    }
    OnUserLeavesActivity { depositLifecycle.onUserLeave(awaitingProvider) }
    OnActivityEntersBackground {
      foreground = false
      discoveryConsent.clear()
      val systemContext = departureContext ?: appContext.reactContext
      val interactive =
        (systemContext?.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.isInteractive ==
          true
      val locked =
        (systemContext?.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)
          ?.isKeyguardLocked != false
      privateUsdc.onDeviceState(interactive, locked)
      depositLifecycle.onBackground(awaitingProvider, interactive, locked)
      depositHost?.onBackground(awaitingProvider)
      if (!awaitingProvider) {
        openWithdrawal = null
        task?.cancel()
      }
    }
    OnDestroy {
      privateUsdc.clear()
      discoveryConsent.clear()
      departureContext?.let { context ->
        runCatching { context.unregisterReceiver(departureReceiver) }
      }
      departureContext = null
      depositHost?.close()
      openWithdrawal = null
      task?.cancel()
      dialog?.dismiss()
      scope.cancel()
    }
  }

  private fun depositCoordinator(
    activity: Activity,
    store: WalletStore,
    journal: EarnDepositJournal,
    cycle: Int,
  ): EarnDepositCoordinator {
    val identity =
      store.load().use {
        check(it.earnCycleIndex == cycle)
        it.id to it.journalId
      }
    return EarnDepositCoordinator(
      journal,
      EarnDepositEngineAdapter(
        activity,
        store,
        identity.first,
        identity.second,
        cycle,
        { requireForeground(activity) },
      ),
      reportFailure = { code, location ->
        android.util.Log.w("GizuEarnDeposit", "execution stopped: code=$code location=$location")
      },
    )
  }

  private fun makeDepositHost(
    activity: Activity,
    store: WalletStore,
    walletId: String,
    id: String,
  ): EarnDepositHost {
    observeDepositDepartures(activity)
    val journal =
      store.load().use { record ->
        requireSponsoredWallet(record, walletId)
        val saved = earnDepositJournal(activity, record)
        check(saved.get(id).getInt("cycleIndex") == record.earnCycleIndex)
        saved
      }
    val cycle = journal.get(id).getInt("cycleIndex")
    return EarnDepositHost(
      scope,
      journal,
      { store.load() },
      { depositCoordinator(activity, store, journal, cycle) },
      { record, grant, remaining ->
        requireDepositCapacity(
          grant.review,
          earnSponsoredJournal(activity, record).all(),
          earnPayoutJournal(activity, record).all(),
          earnPayoutJournal(activity, record).storageBytes(),
          if (grant.review.has("distribution"))
            earnPayoutJournal(activity, record).groupGrowthBytes(record.earnCycleIndex)
          else 0L,
        )
        confirm(
          activity,
          if (remaining) "Review remaining deposit approval" else "Confirm confidential deposit",
          depositReviewText(grant, remaining),
          fullReview = true,
        )
        withProviderUi(activity) {
          PasskeyGate(activity)
            .authorize(
              record.credential,
              walletId,
              "earn-deposit:v1:$id:${journal.get(id).getInt("revision")}:${grant.digest}",
            )
        }
      },
      { requireForeground(activity) },
      releaseUnsigned = { journeyId ->
        releaseUnsignedDeposit(activity.applicationContext, journal, journeyId)
      },
      reportFailure = { code, location ->
        android.util.Log.w("GizuEarnDeposit", "approval job stopped: code=$code location=$location")
      },
    )
  }

  private fun depositReviewText(grant: EarnDepositApproval, remaining: Boolean): String {
    val review = grant.review
    val distribution = review.optJSONObject("distribution")
    val sources = review.getJSONArray("sources").objects()
    val deposit = review.getJSONObject("deposit")
    fun usd(atoms: String) =
      java.math
        .BigDecimal(depositAtoms(atoms))
        .movePointLeft(6)
        .stripTrailingZeros()
        .toPlainString()
    val hold =
      sources.fold(java.math.BigInteger.ZERO) { n, s ->
        n +
          if (distribution == null)
            depositAtoms(s.getJSONObject("hold").getString("minimumOutputAtoms"))
          else java.math.BigInteger.ZERO
      }
    val sourceFees =
      sources.fold(java.math.BigInteger.ZERO) { n, s ->
        n + depositAtoms(s.getString("maximumFeeAtoms"))
      }
    return buildString {
      if (remaining)
        append(
          "Approve only the remaining work under these saved limits. Historical estimates are not fresh quotes; every exact operation is checked again.\n\n"
        )
      append("Total source budget: ${usd(review.getString("sourceBudgetAtoms"))} USDC\n")
      val privateBudget =
        sources
          .filter { it.optString("kind") == "private" }
          .fold(java.math.BigInteger.ZERO) { n, source ->
            n + depositAtoms(source.getString("budgetAtoms"))
          }
      append(
        "Private USDC: ${usd(privateBudget.toString())}; public USDC: ${usd((depositAtoms(review.getString("sourceBudgetAtoms")) - privateBudget).toString())}\n"
      )
      append("Public source gas limit: ${usd(sourceFees.toString())} USDC\n")
      if (distribution == null)
        append("Holding wallet receives at least ${usd(hold.toString())} USDG\n")
      else {
        val weights = distributionWeights(distribution)
        append("Investment wallets: ${weights.size}; all allocated funds invest.\n")
        for (wallet in review.getJSONArray("deposits").objects()) {
          val slot = wallet.getInt("slot")
          append("\nInvestment wallet ${slot + 1}: ${wallet.getString("recipient")}\n")
          append(
            "Source share: ${java.math.BigDecimal(weights[slot]).movePointLeft(2).stripTrailingZeros().toPlainString()}%\n"
          )
          append(
            "Minimum investment: ${usd(wallet.getString("minimumAssetsAtoms"))} USDG; minimum share units: ${wallet.getString("minimumSharesAtoms")}\n"
          )
          append(
            "Maximum gas: ${usd(wallet.getString("maximumFeeAtoms"))} USDG; retained withdrawal reserve: ${usd(wallet.getString("withdrawalReserveAtoms"))} USDG\n"
          )
        }
      }
      append("Vault deposit: at least ${usd(deposit.getString("minimumAssetsAtoms"))} USDG\n")
      append("Minimum share units: ${deposit.getString("minimumSharesAtoms")}\n")
      append("Vault gas limit: ${usd(deposit.getString("maximumFeeAtoms"))} USDG\n")
      append(
        "Liquid withdrawal reserve: ${usd(deposit.getString("withdrawalReserveAtoms"))} USDG. This is retained, not paid now.\n\n"
      )
      append(
        if (distribution == null)
          "Funding becomes confidential USDC. Each source retains its own funding and independent 10/90 payouts. Only wallet 2 deposits into Steakhouse USDG on Robinhood. This approval never withdraws or returns funds.\n\n"
        else
          "Existing private USDC funds this deposit first; public USDC covers the remainder and becomes confidential USDC. The saved distribution applies to these exact private budgets and verified new credit. Each selected wallet receives its own payout and deposits into Steakhouse USDG on Robinhood, retaining its own withdrawal reserve. This approval never withdraws or returns funds.\n\n"
      )
      append(
        "Valid for up to 15 minutes in the foreground. Leaving, locking or closing revokes further signing. Submitted transactions remain saved.\n\n"
      )
      append(
        "EIP-7702 may persistently delegate selected source and investment wallets to $EARN_IMPLEMENTATION. Token approvals and sponsorship use $EARN_PAYMASTER and $EARN_ENTRY_POINT. Canceling this journey does not revoke a saved delegation signature.\n\n"
      )
      append(
        "Read-only confidential authentication for this cycle is included. Its identity is visible to the confidential provider: ${review.getString("confidentialAccount")}\n"
      )
      for (source in sources) append(
        "\n${if (source.optString("kind") == "private") "Private USDC source" else "Public source ${source.getInt("accountIndex")}"}: ${source.getString("address")}\nMaximum budget ${usd(source.getString("budgetAtoms"))} USDC; retained margin ${usd(source.getString("retainedAtoms"))} USDC\n"
      )
      if (distribution == null)
        append(
          "\nWallet 1: ${review.getJSONArray("destinations").getString(0)}\nWallet 2: ${review.getJSONArray("destinations").getString(1)}\n"
        )
      append("\nVault: $HOOD_EARN_VAULT\n")
    }
  }

  /** Applies to staged batch, individual and resumed source execution before new authority. */
  private fun requireEarnFundingCapacity(
    activity: Activity,
    record: WalletRecord,
    child: JSONObject,
  ) {
    if (
      savedCycleDistribution(record) == null ||
        child.sponsoredSpendSaved() ||
        child.getJSONObject("proposal").getString("kind") != "sourceFunding"
    )
      return
    requireDistributionFundingCapacity(
      record,
      child,
      earnSponsoredJournal(activity, record).all(),
      earnPayoutJournal(activity, record).all(),
      if (record.earnChain == 1) earnVaultJournal(activity, record).all() else emptyList(),
      if (record.earnChain == 1) earnLiquidityJournal(activity, record).all() else emptyList(),
      earnPayoutJournal(activity, record).storageBytes(),
      if (record.earnChain == 4663)
        earnPayoutJournal(activity, record).groupGrowthBytes(record.earnCycleIndex)
      else 0L,
    )
  }

  private suspend fun approveEarnFundingBatch(
    activity: Activity,
    store: WalletStore,
    walletId: String,
    batchId: String,
  ): List<Map<String, Any>> {
    val journal =
      store.load().use { record ->
        requireSponsoredWallet(record, walletId)
        earnSponsoredJournal(activity, record)
      }
    val ledger = store.load().use { record -> fundingReservations(activity, record) }
    val batch = ledger.batch(batchId)
    check(batch.getString("feature") == "earn" && batch.optBoolean("registrationComplete"))
    val legs = batch.getJSONArray("legs")
    val ids = (0 until legs.length()).map { legs.getJSONObject(it).getString("operationId") }
    check(ids.distinct().size == ids.size)
    reconcileEarnSponsoredOperations(
      journal,
      EarnSponsoredChainRpc(143),
      EarnSponsoredBundlerRpc(143),
      chainFilter = 143,
      operationIds = ids.toSet(),
    )
    val engines = mutableListOf<Pair<EarnSponsoredEngine, SponsoredReview>>()
    var grant: EarnFundingBatchApproval? = null
    try {
      for (id in ids) {
        val row = journal.get(id)
        if (row.getString("status") in terminalSteps) {
          ledger.complete(id)
          continue
        }
        if (row.has("signedUserOperation") && row.getString("status") != "signed") continue
        check(!row.optBoolean("cancelled")) { "This funding batch was discarded" }
        val engine =
          EarnSponsoredEngine(
            store,
            journal,
            EarnSponsoredChainRpc(143),
            EarnSponsoredBundlerRpc(143),
            privateCreditRows = { address ->
              store.load().use { earnPrivateCreditRowsForSigning(activity, it, address) }
            },
            reservations = ledger,
          )
        try {
          engines.add(engine to engine.prepare(id, row.getInt("revision")))
        } catch (error: Exception) {
          engine.close()
          throw error
        }
      }
      if (engines.isEmpty()) return ids.map { journal.public(journal.get(it)) }
      val rows = ids.map(journal::get)
      val credential =
        store.load().use { record ->
          requireSponsoredWallet(record, walletId)
          check(record.journalId == journal.generation)
          rows.forEach { requireEarnFundingCapacity(activity, record, it) }
          grant =
            EarnFundingBatchApproval.createManifest(
              rows,
              walletId,
              record.journalId,
              record.earnCycleIndex,
              batchId,
              record.roleRegistry,
              ledger.batch(batchId),
            )
          record.credential
        }
      val total =
        rows.fold(java.math.BigInteger.ZERO) { sum, row ->
          sum + row.getJSONObject("proposal").getString("budgetAtoms").toBigInteger()
        }
      val terms =
        rows.joinToString("\n\n") { row ->
          val p = row.getJSONObject("proposal")
          "Source ${p.optInt("sourceAccountIndex",0)} · ${p.getString("expectedFrom")}\nTransfer ${java.math.BigDecimal(p.getString("amountAtoms").toBigInteger(),6).toPlainString()} USDC\nMaximum gas charge ${java.math.BigDecimal(p.getString("maximumTokenFeeAtoms").toBigInteger(),6).toPlainString()} USDC · retained reserve 0.01 USDC\nPrivate recipient ${p.getString("confidentialAccount")}\nRoute ${p.getString("quoteId")}"
        }
      confirm(
        activity,
        "Review all USDC funding sources",
        "Total budget ${java.math.BigDecimal(total,6).toPlainString()} USDC, including each source's gas cap and reserve.\n\n$terms\n\nOne passkey approves only these funding sources, their displayed amount and fee limits, and any required persistent EIP-7702 delegations. Each transaction is journaled separately. Withdrawal requires its own approval. Changed terms stop this batch.\n\n" +
          engines.joinToString("\n\n") { it.second.text },
        fullReview = true,
      )
      val approval = checkNotNull(grant)
      withProviderUi(activity) {
        PasskeyGate(activity)
          .authorize(credential, walletId, "earn-funding-batch:v1:$batchId:${approval.digest}")
      }
      currentCoroutineContext().ensureActive()
      requireForeground(activity)
      approval.approveAfterPasskey(System.currentTimeMillis())
      for ((engine, firstReview) in engines) {
        var review = firstReview
        for (pass in 0..1) {
          val authorize = {
            requireForeground(activity)
            store.load().use { record ->
              requireEarnFundingCapacity(activity, record, journal.get(review.id))
              approval.assertAuthorized(record, journal.get(review.id), System.currentTimeMillis())
              ledger.assertActive(review.id)
            }
          }
          authorize()
          engine.execute(review, authorize)
          if (review.kind == "delegation") {
            val row = journal.get(review.id)
            review = engine.prepare(review.id, row.getInt("revision"))
            authorize()
          } else break
        }
      }
      return ids.map { journal.public(journal.get(it)) }
    } catch (failure: Exception) {
      if (failure is CancellationException) throw failure
      if (ids.any { journal.get(it).sponsoredSpendSaved() })
        return ids.map { journal.public(journal.get(it)) }
      throw failure
    } finally {
      grant?.invalidate()
      engines.forEach { it.first.close() }
    }
  }

  private fun withdrawalEngine(
    activity: Activity,
    store: WalletStore,
    walletId: String,
  ): EarnWithdrawalEngine {
    val journal =
      store.load().use { record ->
        requireSponsoredWallet(record, walletId)
        earnWithdrawalJournal(activity, record)
      }
    return EarnWithdrawalEngine(
      store,
      journal,
      EarnSponsoredChainRpc(143),
      sourceReader = { id, requestedRevision ->
        store.load().use { record ->
          requireSponsoredWallet(record, walletId)
          check(record.journalId == journal.generation)
          if (record.earnChain == 4663) {
            val source = earnSponsoredJournal(activity, record)
            val row = source.get(id)
            check(
              row.getInt("revision") == requestedRevision &&
                row.getJSONObject("proposal").getString("kind") == "hoodTokenReturn"
            )
            requireActiveEarnCycle(record, row.getJSONObject("proposal"))
            reconcileEarnSponsoredOperations(
              source,
              EarnSponsoredChainRpc(4663),
              EarnSponsoredBundlerRpc(4663),
              chainFilter = 4663,
              operationIds = setOf(id),
            )
            source.get(id)
          } else {
            val source = earnLiquidityJournal(activity, record)
            val row = source.get(id)
            check(
              row.getInt("revision") == requestedRevision &&
                row.getJSONObject("proposal").getString("kind") in setOf("returnUsdc", "returnEth")
            )
            requireActiveEarnCycle(record, row.getJSONObject("proposal"))
            reconcileEarnLiquidityOperations(source, EthereumEarnRpc(), NativeFusionGateway())
            source.get(id)
          }
        }
      },
      readAuth = { payoutReadAuth(activity, store, journal.walletId, journal.generation) },
    )
  }

  private fun cancelWalletWork() {
    openWithdrawal = null
    depositHost?.revoke("approvalExpired")
    scope.launch { task?.cancel() }
  }

  private fun deviceUnlocked(): Boolean {
    val context = departureContext ?: appContext.reactContext ?: return false
    val interactive =
      (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.isInteractive == true
    val locked =
      (context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)?.isKeyguardLocked !=
        false
    return interactive && !locked
  }

  private fun requirePrivateReadPermission(activity: Activity, record: WalletRecord) {
    requireForeground(activity)
    privateUsdc.onDeviceState(interactive = deviceUnlocked(), locked = false)
    requireDepositReadPermission(record, privateUsdc)
  }

  private suspend fun ensurePrivateReadPermission(
    activity: Activity,
    store: WalletStore,
    wallet: String,
  ) {
    val identity =
      store.load().use { record ->
        check(record.id == wallet && record.verified)
        record.credential to record.journalId
      }
    requireForeground(activity)
    privateUsdc.onDeviceState(interactive = deviceUnlocked(), locked = false)
    if (privateUsdc.allows(wallet, identity.second)) return
    confirm(
      activity,
      "Unlock private balance",
      "Allow private balance reads for this wallet until you lock the screen or wallet, sign out, or restart Gizu. Switching apps keeps this read-only access. This approval cannot move funds.",
    )
    withProviderUi(activity) {
      PasskeyGate(activity)
        .authorize(identity.first, wallet, "private-balance-read:v1:${identity.second}")
    }
    currentCoroutineContext().ensureActive()
    requireForeground(activity)
    store.load().use { record ->
      check(record.id == wallet && record.journalId == identity.second && record.verified)
    }
    check(deviceUnlocked()) { "Unlock your device to read private balances" }
    privateUsdc.grant(wallet, identity.second)
  }

  private fun cashoutEngine(
    activity: Activity,
    store: WalletStore,
    wallet: String,
  ): ConfidentialWithdrawalEngine {
    val generation =
      store.load().use { record ->
        check(record.id == wallet && record.verified)
        record.journalId
      }
    fun authority() {
      requireForeground(activity)
      privateUsdc.onDeviceState(interactive = deviceUnlocked(), locked = false)
      check(privateUsdc.allows(wallet, generation)) { "Unlock your private balance" }
      store.load().use { record ->
        check(record.id == wallet && record.journalId == generation && record.verified)
      }
    }
    suspend fun auth(source: JSONObject, freshSalt: ByteArray? = null): EarnReadAuthentication {
      authority()
      val salt = freshSalt ?: ConfidentialBalance().salt()
      val random = ByteArray(7).also { SecureRandom().nextBytes(it) }
      val started = System.currentTimeMillis()
      authority()
      return store.load().use { record ->
        if (source.getString("kind") == "swap")
          uniffi.gizu_stored_signer_core.authenticateSwapRead(
            record.entropy,
            salt,
            random,
            started.toULong(),
            System.currentTimeMillis().toULong(),
          )
        else
          uniffi.gizu_stored_signer_core.authenticateEarnCycleRead(
            record.entropy,
            source.getLong("profileChainId").toULong(),
            source.getInt("cycleIndex").toUInt(),
            salt,
            random,
            started.toULong(),
            System.currentTimeMillis().toULong(),
          )
      }
    }
    val gateway =
      NativeCashoutGateway(
        auth = { source ->
          val signed = auth(source)
          JSONObject()
            .put("standard", "erc191")
            .put("payload", signed.payload)
            .put("signature", signed.signature)
        },
        authBatch = { sources ->
          cashoutReadAuthentications(
            sources,
            {
              authority()
              ConfidentialBalance().salt()
            },
            { source, salt ->
              val signed = auth(source, salt)
              JSONObject()
                .put("standard", "erc191")
                .put("payload", signed.payload)
                .put("signature", signed.signature)
            },
          )
        },
      )
    val journal = store.load().use { confidentialWithdrawalJournal(activity, it) }
    return ConfidentialWithdrawalEngine(
      store,
      journal,
      gateway,
      { source ->
        ConfidentialBalance().read(auth(source), source.getString("address")).also { balance ->
          store.load().use { record ->
            io.gizu.storedwallet.portfolio
              .NativeOwnedConfidentialPortfolio(activity)
              .recordSourceObservation(record, source, balance)
          }
        }
      },
      ::authority,
      { record ->
        io.gizu.storedwallet.portfolio
          .NativeOwnedConfidentialPortfolio(activity)
          .ownedTargets(record)
      },
      { record -> assertCashoutCanStart(activity, record) },
      { record, addresses ->
        io.gizu.storedwallet.swap.MainnetPortfolio(activity).invalidate(record)
        io.gizu.storedwallet.portfolio
          .NativeOwnedConfidentialPortfolio(activity)
          .invalidateSources(record, addresses)
      },
    )
  }

  private suspend fun runCashout(
    activity: Activity,
    store: WalletStore,
    wallet: String,
    id: String,
    revision: Int,
  ): Map<String, Any> =
    withContext(Dispatchers.IO) {
      cashoutEngine(activity, store, wallet).execute(id, revision) { review, hash ->
        withContext(Dispatchers.Main.immediate) {
          val credential =
            store.load().use { record ->
              check(record.id == wallet && record.verified)
              record.credential
            }
          confirm(activity, "Withdraw from Gizu", review, fullReview = true)
          withProviderUi(activity) {
            PasskeyGate(activity).authorize(credential, wallet, "cashout:v1:$id:$revision:$hash")
          }
          currentCoroutineContext().ensureActive()
          requireForeground(activity)
        }
      }
    }

  private suspend fun approveEarnWithdrawal(
    activity: Activity,
    store: WalletStore,
    engine: EarnWithdrawalEngine,
    id: String,
    revision: Int,
  ): Map<String, Any> {
    val review = engine.prepare(id, revision)
    val credential =
      store.load().use { record ->
        requireSponsoredWallet(record, engine.journal.walletId)
        check(record.journalId == engine.journal.generation)
        requireActiveEarnCycle(record, engine.journal.get(id).getJSONObject("proposal"))
        record.credential
      }
    confirm(
      activity,
      if (review.retry) "Review saved withdrawal retry"
      else "Review withdrawal to your new receiving address",
      review.text,
      fullReview = true,
    )
    withProviderUi(activity) {
      PasskeyGate(activity)
        .authorize(
          credential,
          engine.journal.walletId,
          "earn-withdrawal:v1:$id:${review.revision}:${review.hash}",
        )
    }
    currentCoroutineContext().ensureActive()
    try {
      engine.execute(review) {
        requireForeground(activity)
        store.load().use { record ->
          requireSponsoredWallet(record, engine.journal.walletId)
          check(record.journalId == engine.journal.generation)
          requireActiveEarnCycle(record, engine.journal.get(id).getJSONObject("proposal"))
        }
      }
    } catch (failure: Exception) {
      if (failure is CancellationException || !engine.journal.get(id).has("signedData"))
        throw failure
    }
    return engine.journal.public(engine.journal.get(id))
  }

  private fun payoutEngine(
    activity: Activity,
    store: WalletStore,
    walletId: String,
  ): EarnPayoutEngine {
    val journal =
      store.load().use { record ->
        requireSponsoredWallet(record, walletId)
        earnPayoutJournal(activity, record)
      }
    val profile =
      store.load().use { record ->
        requireSponsoredWallet(record, walletId)
        check(record.journalId == journal.generation)
        record.earnChain
      }
    return EarnPayoutEngine(
      store,
      journal,
      if (profile == 1) EthereumEarnRpc() else EarnSponsoredChainRpc(4663),
      groupedDelivery = { row ->
        store.load().use { record ->
          isGuidedEarnPayout(row, earnDepositJournal(activity, record).all())
        }
      },
      sourceReader = { id, requestedRevision ->
        val source =
          store.load().use { record ->
            requireSponsoredWallet(record, walletId)
            check(record.journalId == journal.generation)
            earnSponsoredJournal(activity, record)
          }
        check(source.get(id).getInt("revision") == requestedRevision)
        check(source.get(id).getJSONObject("proposal").getString("kind") == "sourceFunding")
        reconcileEarnSponsoredOperations(
          source,
          EarnSponsoredChainRpc(143),
          EarnSponsoredBundlerRpc(143),
          chainFilter = 143,
          operationIds = setOf(id),
        )
        currentCoroutineContext().ensureActive()
        requireForeground(activity)
        source.get(id)
      },
      sourceBatchReader = { id ->
        val source =
          store.load().use { record ->
            requireSponsoredWallet(record, walletId)
            check(record.journalId == journal.generation)
            earnSponsoredJournal(activity, record)
          }
        val p = source.get(id).getJSONObject("proposal")
        if (!p.has("fundingBatchId")) listOf(source.get(id))
        else {
          val batch =
            store.load().use { record ->
              check(record.journalId == journal.generation)
              val batch = fundingReservations(activity, record).batch(p.getString("fundingBatchId"))
              check(
                batch.getString("feature") == "earn" &&
                  batch.getInt("cycleIndex") == record.earnCycleIndex
              )
              batch
            }
          check(batch.optBoolean("registrationComplete"))
          val legs = batch.getJSONArray("legs")
          val ids =
            (0 until legs.length()).map { legs.getJSONObject(it).getString("operationId") }.toSet()
          check(legs.length() == ids.size && ids.size == p.getInt("fundingBatchSize"))
          reconcileEarnSponsoredOperations(
            source,
            EarnSponsoredChainRpc(143),
            EarnSponsoredBundlerRpc(143),
            chainFilter = 143,
            operationIds = ids,
          )
          ids.map(source::get)
        }
      },
      readAuth = { payoutReadAuth(activity, store, journal) },
    )
  }

  private suspend fun payoutReadAuth(
    activity: Activity,
    store: WalletStore,
    journal: EarnPayoutJournal,
  ): EarnReadAuthentication = payoutReadAuth(activity, store, journal.walletId, journal.generation)

  private suspend fun payoutReadAuth(
    activity: Activity,
    store: WalletStore,
    walletId: String,
    generation: String,
  ): EarnReadAuthentication {
    val identity =
      store.load().use { record ->
        requireSponsoredWallet(record, walletId)
        check(record.journalId == generation)
        record.credential to record.earnChain
      }
    ensurePrivateReadPermission(activity, store, walletId)
    val random = ByteArray(7).also { SecureRandom().nextBytes(it) }
    val started = System.currentTimeMillis()
    val salt = ConfidentialBalance().salt()
    return store.load().use { record ->
      requireSponsoredWallet(record, walletId)
      check(record.journalId == generation && record.earnChain == identity.second)
      requirePrivateReadPermission(activity, record)
      if (cycleConfidential(record).equals(sharedConfidential(record), true))
        requireNoPendingSharedCredit(activity, record)
      cycleReadAuth(record, salt, random, started.toULong(), System.currentTimeMillis().toULong())
    }
  }

  private suspend fun approveEarnPayout(
    activity: Activity,
    store: WalletStore,
    engine: EarnPayoutEngine,
    id: String,
    revision: Int,
  ): Map<String, Any> {
    val review = engine.prepare(id, revision)
    val credential =
      store.load().use { record ->
        requireSponsoredWallet(record, engine.journal.walletId)
        check(record.journalId == engine.journal.generation)
        record.credential
      }
    val leg = engine.journal.get(id).getString("leg")
    confirm(
      activity,
      if (review.retry) "Review exact saved payout retry" else "Review private $leg allocation",
      review.text,
      fullReview = true,
    )
    withProviderUi(activity) {
      PasskeyGate(activity)
        .authorize(
          credential,
          engine.journal.walletId,
          "earn-payout:v1:$id:$leg:${review.revision}:${review.hash}",
        )
    }
    currentCoroutineContext().ensureActive()
    try {
      engine.execute(review) {
        requireForeground(activity)
        store.load().use { record ->
          requireSponsoredWallet(record, engine.journal.walletId)
          check(record.journalId == engine.journal.generation)
        }
      }
    } catch (failure: Exception) {
      if (failure is CancellationException || !engine.journal.get(id).has("signedData"))
        throw failure
      // The exact signature is already durable; only the public locked child leaves native.
    }
    return engine.journal.public(engine.journal.get(id))
  }

  private suspend fun approveEarnLiquidityCancellation(
    activity: Activity,
    store: WalletStore,
    engine: EarnLiquidityCancellationEngine,
    id: String,
    revision: Int,
  ): Map<String, Any> {
    val review =
      engine.prepare(id, revision) ?: return engine.journal.public(engine.journal.get(id))
    val credential =
      store.load().use { record ->
        requireEarnExecutionWallet(record, engine.journal.walletId)
        check(
          record.journalId == engine.journal.generation &&
            !currentCycleRows(record, earnVaultJournal(activity, record).all()).any {
              it.earnBlocked()
            }
        )
        record.credential
      }
    confirm(
      activity,
      if (review.retry) "Review saved nonce cancellation retry"
      else "Review same-nonce cancellation",
      review.text,
      fullReview = true,
    )
    withProviderUi(activity) {
      PasskeyGate(activity)
        .authorize(
          credential,
          engine.journal.walletId,
          "earn-liquidity-cancel:v1:$id:${review.revision}:${review.retry}:${review.hash}",
        )
    }
    currentCoroutineContext().ensureActive()
    try {
      engine.execute(review) {
        requireForeground(activity)
        store.load().use { record ->
          requireEarnExecutionWallet(record, engine.journal.walletId)
          check(
            record.journalId == engine.journal.generation &&
              !currentCycleRows(record, earnVaultJournal(activity, record).all()).any {
                it.earnBlocked()
              }
          )
        }
      }
    } catch (failure: Exception) {
      if (
        failure is CancellationException ||
          engine.journal.get(id).liquidityCancellationAttempts().isEmpty()
      )
        throw failure
      // Preserve every signed attempt and return its public locked state when submission is
      // uncertain.
    }
    return engine.journal.public(engine.journal.get(id))
  }

  private suspend fun approveEarnLiquidity(
    activity: Activity,
    store: WalletStore,
    engine: EarnLiquidityEngine,
    id: String,
    revision: Int,
  ): Map<String, Any> {
    var current = revision
    repeat(2) {
      val review = engine.prepare(id, current)
      val credential =
        store.load().use { record ->
          requireEarnExecutionWallet(record, engine.journal.walletId)
          check(
            record.journalId == engine.journal.generation &&
              !currentCycleRows(record, earnVaultJournal(activity, record).all()).any {
                it.earnBlocked()
              }
          )
          record.credential
        }
      confirm(
        activity,
        if (review.kind == "fusionUsdcPermit") "Review exact USDC permit"
        else "Review Ethereum liquidity operation",
        review.text,
        fullReview = true,
      )
      withProviderUi(activity) {
        PasskeyGate(activity)
          .authorize(
            credential,
            engine.journal.walletId,
            "earn-liquidity:v1:$id:${review.revision}:${review.kind}:${review.hash}",
          )
      }
      currentCoroutineContext().ensureActive()
      try {
        engine.execute(review) {
          requireForeground(activity)
          store.load().use { record ->
            requireEarnExecutionWallet(record, engine.journal.walletId)
            check(
              record.journalId == engine.journal.generation &&
                !currentCycleRows(record, earnVaultJournal(activity, record).all()).any {
                  it.earnBlocked()
                }
            )
          }
        }
      } catch (failure: Exception) {
        val saved = engine.journal.get(id)
        if (failure is CancellationException || !saved.has("raw") && !saved.has("signedOrder"))
          throw failure
        return engine.journal.public(saved)
      }
      current = engine.journal.get(id).getInt("revision")
      if (review.kind != "fusionUsdcPermit") return engine.journal.public(engine.journal.get(id))
    }
    return engine.journal.public(engine.journal.get(id))
  }

  private suspend fun approveEarnSponsored(
    activity: Activity,
    store: WalletStore,
    engine: EarnSponsoredEngine,
    id: String,
    revision: Int,
  ): Map<String, Any> {
    var current = revision
    var prompted = false
    val singleApproval =
      engine.journal.get(id).getJSONObject("proposal").getString("kind") == "hoodRedeemAll"
    repeat(2) {
      val review = engine.prepare(id, current)
      val credential =
        store.load().use { record ->
          requireSponsoredWallet(record, engine.journal.walletId)
          check(record.journalId == engine.journal.generation)
          requireEarnFundingCapacity(activity, record, engine.journal.get(id))
          record.credential
        }
      if (!prompted || !singleApproval) {
        confirm(
          activity,
          if (review.kind == "delegation") "Review persistent wallet delegation"
          else if (singleApproval) "Review withdrawal to private USDC"
          else "Review sponsored earn operation",
          if (singleApproval)
            review.text +
              "\n\nThis approval also returns the received USDG to your private USDC balance after the vault receipt."
          else review.text,
          fullReview = true,
        )
        withProviderUi(activity) {
          PasskeyGate(activity)
            .authorize(
              credential,
              engine.journal.walletId,
              "earn-sponsored:v1:$id:${review.revision}:${review.kind}:${review.hash}",
            )
        }
        prompted = true
      }
      currentCoroutineContext().ensureActive()
      try {
        engine.execute(review) {
          requireForeground(activity)
          store.load().use { record ->
            requireSponsoredWallet(record, engine.journal.walletId)
            check(record.journalId == engine.journal.generation)
            requireEarnFundingCapacity(activity, record, engine.journal.get(id))
          }
        }
      } catch (failure: Exception) {
        if (failure is CancellationException || !engine.journal.get(id).has("signedUserOperation"))
          throw failure
        if (singleApproval && review.kind != "delegation") rememberWithdrawalApproval(engine, id)
        return engine.journal.public(engine.journal.get(id))
      }
      current = engine.journal.get(id).getInt("revision")
      if (review.kind != "delegation") {
        if (singleApproval) rememberWithdrawalApproval(engine, id)
        return engine.journal.public(engine.journal.get(id))
      }
    }
    return engine.journal.public(engine.journal.get(id))
  }

  private fun rememberWithdrawalApproval(engine: EarnSponsoredEngine, id: String) {
    if (!engine.journal.get(id).has("signedUserOperation")) return
    openWithdrawal =
      OpenWithdrawalApproval(
        engine.journal.walletId,
        engine.journal.generation,
        id,
        System.currentTimeMillis(),
      )
  }

  private suspend fun approveEarnVault(
    activity: Activity,
    store: WalletStore,
    engine: EarnVaultEngine,
    id: String,
    revision: Int,
  ): Map<String, Any> {
    val review = engine.prepare(id, revision)
    val identity =
      store.load().use { record ->
        requireEarnExecutionWallet(record, engine.journal.walletId)
        check(record.journalId == engine.journal.generation)
        record.credential
      }
    confirm(
      activity,
      if (engine.journal.get(id).getJSONObject("proposal").getString("kind") == "vaultDeposit")
        "Review vault investment"
      else "Review full vault withdrawal",
      review.text,
      fullReview = true,
    )
    withProviderUi(activity) {
      PasskeyGate(activity)
        .authorize(
          identity,
          engine.journal.walletId,
          "earn-vault:v1:$id:${review.revision}:${review.hash}",
        )
    }
    currentCoroutineContext().ensureActive()
    try {
      engine.execute(review) {
        requireForeground(activity)
        store.load().use { record ->
          requireEarnExecutionWallet(record, engine.journal.walletId)
          check(
            record.journalId == engine.journal.generation &&
              !currentCycleRows(record, earnLiquidityJournal(activity, record).all()).any {
                it.liquidityBlocked()
              }
          )
        }
      }
    } catch (failure: Exception) {
      if (
        failure is CancellationException ||
          !engine.journal.get(id).steps().any {
            it.has("raw") && it.getString("status") !in terminalSteps
          }
      )
        throw failure
      // A signed transaction with uncertain network outcome returns its public locked state.
    }
    return engine.journal.public(engine.journal.get(id))
  }

  private suspend fun createWallet(activity: Activity, store: WalletStore): Map<String, Any> {
    check(withContext(Dispatchers.IO) { !store.exists() })
    confirmCreation(activity)
    val credential = withProviderUi(activity) { PasskeyGate(activity).register() }
    currentCoroutineContext().ensureActive()
    // No entropy is generated or held during the system credential ceremony.
    return withContext(Dispatchers.IO) {
      val entropy = ByteArray(32).also { SecureRandom().nextBytes(it) }
      try {
        WalletRecord(UUID.randomUUID().toString(), credential, entropy).use { record ->
          // Verify the native core is available before persisting; addresses
          // remain hidden until backup.
          check(deriveAccountAddresses(entropy).size == 16)
          currentCoroutineContext().ensureActive()
          store.create(record)
          record.publicState()
        }
      } finally {
        entropy.fill(0)
      }
    }
  }

  private fun publicState(store: WalletStore): Map<String, Any> {
    val state = store.state()
    return if (state["status"] == "ready") store.load().use { project(it) } else state
  }

  private fun earnPublic(record: WalletRecord): Map<String, Any> {
    check(record.verified)
    if (record.earnChain == 0)
      return mapOf("status" to if (record.earnRecoveryRequired) "recoveryRequired" else "absent")
    val profile = if (record.earnChain == 1) "ethereum-usdc" else "robinhood-usdg"
    val addresses = cycleAddresses(record)
    val distribution = savedCycleDistribution(record)
    check(
      addresses.distinct().size == addresses.size && (distribution != null || addresses.size == 2)
    )
    return mapOf(
      "status" to if (record.earnRecoveryRequired) "recoveryRequired" else "prepared",
      "intentId" to
        if (record.earnCycleIndex == 0) "earn-v1:${record.id.lowercase()}:$profile"
        else "earn-v2:${record.id.lowercase()}:$profile:${record.earnCycleIndex}",
      "cycleIndex" to record.earnCycleIndex,
      "version" to if (record.earnCycleIndex == 0) "gizu-earn-v1" else "gizu-earn-v2",
      "walletId" to record.id,
      "profileId" to profile,
      "sourceAddress" to deriveAccountAddresses(record.entropy)[0],
      "sourceChainId" to 143,
      "confidentialAddress" to cycleConfidential(record),
      "returnConfidentialAddress" to sharedConfidential(record),
      "backupCovered" to true,
      "destinations" to
        addresses.mapIndexed { index, address ->
          mapOf(
            "role" to if (distribution != null || index != 0) "invest" else "hold",
            "address" to address,
            "chainId" to record.earnChain,
          ) + (if (distribution != null) mapOf("slot" to index) else emptyMap())
        },
    ) +
      (distribution?.let {
        mapOf(
          "distribution" to mapOf("version" to 1, "weightsBps" to distributionWeights(it)),
          "investmentSlot" to selectedInvestmentSlot(record)!!,
        ) +
          (savedEarnCycle(record)
            ?.optString("distributionBudgetAtoms")
            ?.takeIf { budget -> budget.isNotEmpty() }
            ?.let { budget -> mapOf("distributionBudgetAtoms" to budget) } ?: emptyMap())
      } ?: emptyMap())
  }

  private fun project(record: WalletRecord): Map<String, Any> =
    if (!record.verified) record.publicState()
    else
      record.publicState() +
        ("accounts" to
          deriveAccountAddresses(record.entropy).mapIndexed { index, address ->
            mapOf("accountIndex" to index, "address" to address, "chainId" to 10143)
          })
}

internal suspend fun listSponsoredOperations(
  activity: Context,
  store: WalletStore,
  walletId: String,
  select: (WalletRecord, List<JSONObject>) -> List<JSONObject>,
): List<Map<String, Any>> {
  val journal =
    store.load().use { record ->
      requireSponsoredWallet(record, walletId)
      earnSponsoredJournal(activity, record)
    }
  val active = store.load().use { record -> select(record, journal.all()) }
  val pending =
    active
      .filter { it.getString("status") !in terminalSteps }
      .map { it.getString("operationId") }
      .toSet()
  for (chain in
    active
      .map { it.getJSONObject("proposal").getInt("chainId") }
      .distinct()) reconcileEarnSponsoredOperations(
    journal,
    EarnSponsoredChainRpc(chain),
    EarnSponsoredBundlerRpc(chain),
    chainFilter = chain,
    operationIds = pending,
  )
  store.load().use { record ->
    val ledger = fundingReservations(activity, record)
    journal
      .all()
      .filter {
        it.getString("status") in setOf("finalized", "reverted") && it.has("transactionHash")
      }
      .forEach { ledger.complete(it.getString("operationId")) }
  }
  return store.load().use { record -> select(record, journal.all()).map { journal.public(it) } }
}
