package io.gizu.storedwallet.swap

import android.util.Log
import io.gizu.storedwallet.BuildConfig
import io.gizu.storedwallet.FundingReservations
import io.gizu.storedwallet.NativeFundingPlanner
import io.gizu.storedwallet.NativeRpcTransport
import io.gizu.storedwallet.RpcFailure
import io.gizu.storedwallet.WalletRecord
import io.gizu.storedwallet.WalletStore
import io.gizu.storedwallet.assertPrivateExecutionAvailable
import io.gizu.storedwallet.earnWithdrawalIndices
import io.gizu.storedwallet.fundingReservations
import io.gizu.storedwallet.portfolio.NativeOwnedConfidentialPortfolio
import io.gizu.storedwallet.portfolio.NativeOwnedPortfolio
import java.security.SecureRandom
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.SwapOperation
import uniffi.gizu_stored_signer_core.SwapStep
import uniffi.gizu_stored_signer_core.allocateSwapRecipients
import uniffi.gizu_stored_signer_core.allocateSwapRecipientsN
import uniffi.gizu_stored_signer_core.chooseBuyLegs
import uniffi.gizu_stored_signer_core.deriveAccountAddressRange

internal sealed class SwapUi {
  data class Review(val text: String) : SwapUi()

  data object Unlock : SwapUi()

  data class Done(val view: Map<String, Any?>) : SwapUi()
}

internal class SwapEngine(
  private val store: WalletStore,
  private val saved: SwapStore,
  private val gateway: String,
  private val transport: NativeRpcTransport = NativeRpcTransport(),
) : AutoCloseable {
  private var operation: SwapOperation? = null
  private var fundingAddress: String? = null
  private var batch: SwapFundingBatch? = null
  private var reservations: FundingReservations? = null
  private var approvalScope: SwapBatchApproval? = null
  private var displayedScope: SwapBatchApproval? = null
  private var displayedText: String? = null
  private var unlockedScopedOperation: String? = null
  private var lastInvalidatedPrivateCredit: String? = null
  private var lastInvalidatedPublicSaleProgress: String? = null

  private fun assertExecutionAvailable(record: WalletRecord) {
    check(record.verified && record.id == saved.walletId)
    assertPrivateExecutionAvailable(saved.context, record)
  }

  /** `confidentialPayout` buys from C's existing private balance and takes no amount. */
  suspend fun start(
    record: WalletRecord,
    target: String,
    amountAtoms: String?,
    kind: String = "confidentialSwap",
  ) {
    check(kind == "confidentialSwap" || (kind == "confidentialPayout" && amountAtoms == null))
    check(record.verified && record.id == saved.walletId)
    assertExecutionAvailable(record)
    check(operation == null)
    saved.load()?.let { existing ->
      val previous = SwapOperation.restore(existing.getString("state"), gateway)
      val phase = JSONObject(previous.publicStatus()).getString("phase")
      val existingBatch =
        existing.optJSONObject("fundingBatch")?.let { SwapFundingBatch.restore(it) }
      val pendingBatch =
        existingBatch != null &&
          !existingBatch.cancelled &&
          existingBatch.currentIndex + 1 < existingBatch.size
      if ((phase != "CANCELLED" && phase != "COMPLETE") || pendingBatch) {
        fundingAddress = existing.getString("fundingAddress")
        batch = existing.optJSONObject("fundingBatch")?.let { SwapFundingBatch.restore(it) }
        reservations = if (batch != null) fundingReservations(saved.context, record) else null
        operation = previous
        previous.retry()
        return
      }
      rememberPrevious(existing, previous)
      previous.close()
    }
    check(target.matches(Regex("0x[0-9a-fA-F]{40}")))
    if (kind == "confidentialSwap") {
      val budget =
        checkNotNull(amountAtoms) { "Choose an exact source budget before starting Swap." }
      check(budget.matches(Regex("[1-9][0-9]{0,19}")))
      val allocation = JSONObject(NativeFundingPlanner(saved.context, record).plan(budget, "swap"))
      reservations = fundingReservations(saved.context, record)
      try {
        // The wallet count and shares are drawn once for the whole swap and shared by every
        // funding child, so a restore or retry never rolls them again.
        val choice = if (RANDOM_LEGS) chooseBuyLegs(budget, randomBytes()) else null
        val reserved =
          if (choice != null) allocateSwapRecipientsN(record.roleRegistry, choice.count)
          else allocateSwapRecipients(record.roleRegistry)
        store.persistRegistry(record.id, reserved.registry)
        reservations = fundingReservations(saved.context, record)
        val children = JSONArray()
        val legs = allocation.getJSONArray("legs")
        for (index in 0 until legs.length()) {
          val leg = legs.getJSONObject(index)
          val plan =
            JSONObject()
              .put("kind", kind)
              .put("target", target)
              .put("sourceIndex", leg.getInt("sourceIndex"))
              .put("amountAtoms", leg.getString("budgetAtoms"))
              .put("recipientIndices", JSONArray(reserved.indices.map { it.toInt() }))
          if (choice != null) plan.put("weights", JSONArray(choice.weights.map { it.toInt() }))
          val child =
            SwapOperation.start(plan.toString(), record.entropy, gateway, now() + index.toULong())
          try {
            check(
              deriveAccountAddressRange(record.entropy, leg.getInt("sourceIndex").toUInt(), 1u)
                .single()
                .equals(leg.getString("address"), true)
            )
            checkNotNull(reservations)
              .bind(
                allocation.getString("fundingBatchId"),
                leg.getString("address"),
                child.operationId(),
                leg.getString("budgetAtoms"),
              )
            children.put(
              JSONObject()
                .put("sourceIndex", leg.getInt("sourceIndex"))
                .put("fundingAddress", leg.getString("address"))
                .put("operationId", child.operationId())
                .put("budgetAtoms", leg.getString("budgetAtoms"))
                .put("state", child.exportState())
                .put("status", child.publicStatus())
            )
            if (index == 0) {
              operation = child
              fundingAddress = leg.getString("address")
            }
          } finally {
            if (index != 0) child.close()
          }
        }
        batch = SwapFundingBatch.create(allocation, children)
        persist()
      } catch (error: Exception) {
        operation?.cancel()
        batch?.cancel()
        runCatching { if (operation != null) persist() }
        checkNotNull(reservations).cancelBatchUnsigned(allocation.getString("fundingBatchId"))
        throw error
      }
      return
    } else {
      val reserved = allocateSwapRecipients(record.roleRegistry)
      store.persistRegistry(record.id, reserved.registry)
      val plan =
        JSONObject()
          .put("kind", kind)
          .put("target", target)
          .put("recipientIndices", JSONArray(reserved.indices.map { it.toInt() }))
      fundingAddress = deriveAccountAddressRange(record.entropy, 1u, 1u).single()
      operation = SwapOperation.start(plan.toString(), record.entropy, gateway, now())
    }
    persist()
  }

  /** Temporary: finish Fusion buys for already allocated recipients that still hold USDG. */
  fun startRecovery(record: WalletRecord, target: String) {
    check(record.verified && record.id == saved.walletId)
    assertExecutionAvailable(record)
    check(operation == null)
    saved.load()?.let { existing ->
      val previous = SwapOperation.restore(existing.getString("state"), gateway)
      val phase = JSONObject(previous.publicStatus()).getString("phase")
      val existingBatch =
        existing.optJSONObject("fundingBatch")?.let { SwapFundingBatch.restore(it) }
      val pendingBatch =
        existingBatch != null &&
          !existingBatch.cancelled &&
          existingBatch.currentIndex + 1 < existingBatch.size
      if ((phase != "CANCELLED" && phase != "COMPLETE") || pendingBatch) {
        fundingAddress = existing.getString("fundingAddress")
        batch = existing.optJSONObject("fundingBatch")?.let { SwapFundingBatch.restore(it) }
        reservations = if (batch != null) fundingReservations(saved.context, record) else null
        operation = previous
        previous.retry()
        return
      }
      rememberPrevious(existing, previous)
      previous.close()
    }
    check(target.matches(Regex("0x[0-9a-fA-F]{40}")))
    // Scans indices the registry already handed out; nothing new is reserved.
    val scanTo = JSONObject(record.roleRegistry).getInt("nextRecipient")
    val plan =
      JSONObject()
        .put("kind", "confidentialRecovery")
        .put("target", target)
        .put("recipientIndices", JSONArray(listOf(3, 4, 5)))
        .put("scanTo", scanTo)
    fundingAddress = deriveAccountAddressRange(record.entropy, 1u, 1u).single()
    operation = SwapOperation.start(plan.toString(), record.entropy, gateway, now())
    persist()
  }

  /**
   * [sweepTo] switches the sale to the temporary debug sweep: each holder's proceeds are paid
   * straight to that public address, with no Aurora step. Debug builds only.
   */
  fun startSell(record: WalletRecord, holdingId: String? = null, sweepTo: String? = null) {
    if (sweepTo != null) {
      check(BuildConfig.DEBUG) { "The debug sweep is not available in this build." }
      check(holdingId != null && sweepTo.matches(Regex("0x[0-9a-fA-F]{40}")))
    }
    check(record.verified && record.id == saved.walletId)
    assertExecutionAvailable(record)
    check(operation == null)
    val existing = saved.load()
    if (existing != null) {
      val previous = SwapOperation.restore(existing.getString("state"), gateway)
      try {
        val phase = JSONObject(previous.publicStatus()).getString("phase")
        val pending = existing.optJSONObject("fundingBatch")?.let { SwapFundingBatch.restore(it) }
        check(
          (phase == "CANCELLED" || phase == "COMPLETE") &&
            (pending == null || pending.cancelled || pending.currentIndex + 1 == pending.size)
        ) {
          "An existing swap needs attention. Open Swap and resume it before selling holdings."
        }
        rememberPrevious(existing, previous)
      } finally {
        previous.close()
      }
    }
    val (target, holders) =
      if (holdingId != null) {
        val selected =
          SwapHoldings.selection(
            holdingId,
            JSONObject(record.roleRegistry).getInt("nextRecipient"),
            saved.portfolio.targets(),
            earnWithdrawalIndices(record),
          )
        selected.first to JSONArray(selected.second)
      } else {
        val state = JSONObject(checkNotNull(existing).getString("state"))
        val plan = state.getJSONObject("plan")
        check(plan.getString("kind") in listOf("confidentialSwap", "confidentialPayout"))
        val previous = SwapOperation.restore(existing.getString("state"), gateway)
        try {
          check(JSONObject(previous.publicStatus()).getString("phase") == "COMPLETE")
        } finally {
          previous.close()
        }
        plan.getString("target") to plan.getJSONArray("recipientIndices")
      }
    if (sweepTo != null) {
      // No return wallets are needed, so nothing is reserved; the holders are their own recipients.
      val sweep =
        JSONObject()
          .put("kind", "debugSweep")
          .put("target", target)
          .put("holderIndices", holders)
          .put("recipientIndices", holders)
          .put("destination", sweepTo)
      fundingAddress = deriveAccountAddressRange(record.entropy, 1u, 1u).single()
      operation = SwapOperation.start(sweep.toString(), record.entropy, gateway, now())
      persist()
      return
    }
    // New sales stop privately. The core uses existing holder indices only as
    // internal order slots; no public recipient roles or randomness are reserved.
    val next = confidentialSalePlan(target, holders)
    fundingAddress = deriveAccountAddressRange(record.entropy, 1u, 1u).single()
    operation = SwapOperation.start(next.toString(), record.entropy, gateway, now())
    persist()
  }

  fun restore() {
    val root = checkNotNull(saved.load())
    batch = root.optJSONObject("fundingBatch")?.let { SwapFundingBatch.restore(it) }
    if (batch != null)
      store.load().use { record -> reservations = fundingReservations(saved.context, record) }
    fundingAddress = root.getString("fundingAddress")
    operation = SwapOperation.restore(root.getString("state"), gateway)
  }

  /**
   * Drives the operation until it needs the user (review, unlock) or stops (finished, paused).
   * Waits for Aurora and 1inch happen here, so an open screen carries the swap to the end.
   */
  suspend fun advance(onProgress: (Map<String, Any?>) -> Unit = {}): SwapUi {
    while (true) {
      store.load().use { record -> assertExecutionAvailable(record) }
      var op = checkNotNull(operation)
      if (batch != null && !JSONObject(op.exportState()).isNull("approvedMs")) {
        if (!scopeAuthorized()) {
          dropScopeKeys()
          return batchReview(null, onProgress)
        }
        unlockWithinScope()
        op = checkNotNull(operation)
      }
      when (val step = op.nextStep(now())) {
        is SwapStep.Review -> {
          persist()
          if (batch != null) {
            dropScopeKeys()
            return batchReview(step.text, onProgress)
          }
          return SwapUi.Review(step.text)
        }
        is SwapStep.Unlock -> {
          persist()
          if (batch != null) {
            dropScopeKeys()
            return batchReview(null, onProgress)
          }
          return SwapUi.Unlock
        }
        is SwapStep.Finished -> {
          persist()
          val funding = batch
          if (funding != null && !funding.cancelled) {
            checkNotNull(reservations).complete(op.operationId())
            if (funding.advanceIfComplete()) {
              op.close()
              operation = SwapOperation.restore(funding.current.getString("state"), gateway)
              unlockedScopedOperation = null
              fundingAddress = funding.current.getString("fundingAddress")
              persist()
              onProgress(view())
              continue
            }
          }
          return SwapUi.Done(view())
        }
        is SwapStep.Paused -> {
          persist()
          return SwapUi.Done(view())
        }
        is SwapStep.Wait -> {
          persist()
          onProgress(view())
          kotlinx.coroutines.delay(step.millis.toLong())
        }
        is SwapStep.Request -> {
          check(NativeRpcTransport.allowed(step.url))
          persist()
          diagnostic("request_start", step.id)
          val started = android.os.SystemClock.elapsedRealtime()
          val (status, body) =
            try {
              transport.execute(step.method, step.url, step.body)
            } catch (_: RpcFailure) {
              0 to ""
            }
          diagnostic(
            "request_end",
            step.id,
            status,
            android.os.SystemClock.elapsedRealtime() - started,
          )
          try {
            // A response may itself sign a payout or order. Clear the native key first
            // if this batch's in-memory authority elapsed while HTTP was pending.
            if (batch != null && approvalScope != null && !scopeAuthorized()) dropScopeKeys()
            checkNotNull(operation).onResponse(step.id, status.toUShort(), body, now())
          } catch (error: CancellationException) {
            throw error
          } catch (error: Exception) {
            if (JSONObject(checkNotNull(operation).publicStatus()).isNull("pausedCode")) throw error
          }
          persist()
          onProgress(view())
        }
      }
    }
  }

  fun reviewDigest(text: String): String {
    if (batch != null) {
      check(text == displayedText)
      return checkNotNull(displayedScope).digest.removePrefix("0x")
    }
    return java.security.MessageDigest.getInstance("SHA-256")
      .digest(text.toByteArray())
      .joinToString("") { "%02x".format(it) }
  }

  val hasFundingBatch: Boolean
    get() = batch != null

  private fun children(): List<JSONObject> =
    checkNotNull(batch).json.getJSONArray("children").let { rows ->
      (0 until rows.length()).map(rows::getJSONObject)
    }

  private fun scopeAuthorized(): Boolean {
    val scope = approvalScope ?: return false
    return try {
      store.load().use {
        scope.assertAuthorized(
          it,
          JSONObject(checkNotNull(operation).exportState()),
          System.currentTimeMillis(),
        )
      }
      true
    } catch (_: IllegalStateException) {
      false
    }
  }

  private fun dropScopeKeys() {
    approvalScope?.invalidate()
    approvalScope = null
    unlockedScopedOperation = null
    val op = checkNotNull(operation)
    val state = op.exportState()
    op.close()
    operation = SwapOperation.restore(state, gateway)
    persist()
  }

  private fun unlockWithinScope() {
    val op = checkNotNull(operation)
    if (unlockedScopedOperation == op.operationId()) return
    store.load().use { record ->
      checkNotNull(approvalScope)
        .assertAuthorized(record, JSONObject(op.exportState()), System.currentTimeMillis())
      op.unlock(record.entropy, now())
    }
    unlockedScopedOperation = op.operationId()
  }

  private suspend fun batchReview(
    activeText: String?,
    onProgress: (Map<String, Any?>) -> Unit,
  ): SwapUi.Review {
    val funding = checkNotNull(batch)
    check(!funding.cancelled)
    persist()
    // A fee increase can leave a new unsigned funding quote in progress. Finish only
    // these public reads with no key, then review the completed new terms.
    while (true) {
      val state = JSONObject(checkNotNull(operation).exportState())
      if (
        state.isNull("approvedMs") ||
          !state.getJSONObject("data").isNull("signedOperation") ||
          state.getJSONObject("step").getString("step") !in
            setOf("fundingQuote", "fundingPrepare", "sourceChain")
      )
        break
      when (val step = checkNotNull(operation).nextStep(now())) {
        is SwapStep.Request -> {
          check(NativeRpcTransport.allowed(step.url))
          persist()
          onProgress(view())
          val response =
            try {
              transport.execute(step.method, step.url, step.body)
            } catch (_: RpcFailure) {
              0 to ""
            }
          checkNotNull(operation)
            .onResponse(step.id, response.first.toUShort(), response.second, now())
          persist()
        }
        is SwapStep.Wait -> {
          persist()
          onProgress(view())
          kotlinx.coroutines.delay(step.millis.toLong())
        }
        is SwapStep.Paused ->
          error("Source funding preview paused: ${step.code}. Resume before approving.")
        else -> break
      }
    }
    val all = children()
    if (activeText != null) all[funding.currentIndex].put("nativeReviewText", activeText)
    for (index in funding.currentIndex + 1 until funding.size) {
      val child = all[index]
      val state = JSONObject(child.getString("state"))
      if (!SwapBatchApproval.safeToPreview(state)) {
        check(
          !state.isNull("approvedMs") &&
            state.getJSONObject("step").getString("step") == "review" &&
            child.has("nativeReviewText")
        ) {
          "A future source needs its saved operation reconciled before batch approval"
        }
        continue
      }
      SwapOperation.restore(child.getString("state"), gateway).use { draft ->
        draft.retry()
        while (true) {
          check(SwapBatchApproval.safeToPreview(JSONObject(draft.exportState()))) {
            "Only unsigned source drafts may be previewed"
          }
          when (val step = draft.nextStep(now())) {
            is SwapStep.Review -> {
              child
                .put("state", draft.exportState())
                .put("status", draft.publicStatus())
                .put("nativeReviewText", step.text)
              persist()
              break
            }
            is SwapStep.Request -> {
              check(NativeRpcTransport.allowed(step.url))
              child.put("state", draft.exportState()).put("status", draft.publicStatus())
              persist()
              onProgress(view())
              val response =
                try {
                  transport.execute(step.method, step.url, step.body)
                } catch (_: RpcFailure) {
                  0 to ""
                }
              check(SwapBatchApproval.safeToPreview(JSONObject(draft.exportState())))
              draft.onResponse(step.id, response.first.toUShort(), response.second, now())
              child.put("state", draft.exportState()).put("status", draft.publicStatus())
              persist()
            }
            is SwapStep.Wait -> {
              child.put("state", draft.exportState()).put("status", draft.publicStatus())
              persist()
              onProgress(view())
              kotlinx.coroutines.delay(step.millis.toLong())
            }
            is SwapStep.Paused -> {
              child.put("state", draft.exportState()).put("status", draft.publicStatus())
              persist()
              error(
                "Source ${index+1} preview paused: ${step.code}. Resume to refresh the batch before signing."
              )
            }
            else -> error("A future source cannot be advanced during native preview")
          }
        }
      }
    }
    val text = buildString {
      append(
        "REVIEW FUNDING BATCH · ${funding.size} SOURCES\nTotal source debit at most ${java.math.BigDecimal(funding.budgetAtoms.toBigInteger(),6).toPlainString()} USDC, including funding fees.\n"
      )
      append(
        "One passkey approves the listed source limits and their sequential swap steps for the existing fifteen-minute signing session. A changed quote, interrupted screen or expired approval requires a fresh review. Each source finishes before the next source deposits.\n"
      )
      if (funding.currentIndex > 0)
        append(
          "${funding.currentIndex} source(s) already completed; their purchases remain saved.\n"
        )
      for (index in funding.currentIndex until funding.size) {
        val child = all[index]
        val state = JSONObject(child.getString("state"))
        val native =
          if (!state.isNull("reapproval")) state.getString("reapproval")
          else child.optString("nativeReviewText", "")
        check(native.isNotBlank()) {
          "A saved source review is missing; refresh the unsigned draft before approval"
        }
        append("\nSOURCE ${index+1} OF ${funding.size}\n")
        append(
          native
            .replace("for 15 minutes", "within this fifteen-minute batch approval")
            .replace(
              "After 15 minutes you unlock again for this same plan.",
              "After the batch approval expires, review the remaining steps again.",
            )
        )
        val d = state.getJSONObject("data")
        val q = d.getJSONObject("fundingQuote")
        fun usdc(name: String) =
          java.math.BigDecimal(swapBatchAtoms(d.getString(name)), 6).toPlainString()
        append(
          "\nCURRENT FUNDING TERMS: these amounts supersede any earlier source estimate above.\nBudget ${usdc("budget")} USDC; source transfer ${usdc("fundingAmount")} USDC; fee at most ${usdc("fundingFee")} USDC.\n"
        )
        append(
          "Private credit at least ${java.math.BigDecimal(swapBatchAtoms(q.getString("minAmountOut")),6).toPlainString()} USDC. Source deposit ${q.getString("depositAddress")}.\n"
        )
      }
    }
    displayedScope?.invalidate()
    displayedScope =
      store.load().use { record ->
        SwapBatchApproval.create(
          record.id,
          record.journalId,
          record.roleRegistry,
          funding.id,
          all.drop(funding.currentIndex),
          text,
        )
      }
    displayedText = text
    persist()
    return SwapUi.Review(text)
  }

  /** The caller has just completed the passkey challenge bound to the entire displayed text. */
  fun authorizeReviewed(record: WalletRecord, text: String) {
    if (batch == null) {
      unlock(record)
      approve()
      return
    }
    val funding = checkNotNull(batch)
    val scope = checkNotNull(displayedScope)
    check(text == displayedText)
    scope.approveAfterPasskey(record, System.currentTimeMillis())
    try {
      for (index in funding.currentIndex until funding.size) {
        val child = children()[index]
        val state = JSONObject(child.getString("state"))
        scope.assertAuthorized(record, state, System.currentTimeMillis())
        val rows = checkNotNull(reservations).batch(funding.id).getJSONArray("legs")
        val leg =
          (0 until rows.length()).map(rows::getJSONObject).single {
            it.optString("operationId") == child.getString("operationId")
          }
        check(
          leg.getString("address").equals(child.getString("fundingAddress"), true) &&
            leg.getString("budgetAtoms") == child.getString("budgetAtoms")
        )
        checkNotNull(reservations).assertActive(child.getString("operationId"))
        val current = index == funding.currentIndex
        val core =
          if (current) checkNotNull(operation)
          else SwapOperation.restore(child.getString("state"), gateway)
        try {
          core.unlock(record.entropy, now())
          if (state.isNull("approvedMs") || !state.isNull("reapproval")) core.approve(now())
          child.put("state", core.exportState()).put("status", core.publicStatus())
          persist()
        } finally {
          if (!current) core.close()
        }
      }
      approvalScope = scope
      displayedScope = null
      displayedText = null
      unlockedScopedOperation = checkNotNull(operation).operationId()
    } catch (error: Exception) {
      scope.invalidate()
      displayedScope = null
      displayedText = null
      dropScopeKeys()
      throw error
    }
  }

  fun approve() {
    store.load().use { record -> assertExecutionAvailable(record) }
    batch?.let { funding ->
      val ledger = checkNotNull(reservations)
      val rows = ledger.batch(funding.id).getJSONArray("legs")
      val leg =
        (0 until rows.length()).map(rows::getJSONObject).single {
          it.getString("address").equals(funding.current.getString("fundingAddress"), true)
        }
      check(
        leg.optString("operationId") == checkNotNull(operation).operationId() &&
          leg.getString("budgetAtoms") == funding.current.getString("budgetAtoms")
      )
      ledger.assertActive(checkNotNull(operation).operationId())
    }
    checkNotNull(operation).approve(now())
    persist()
  }

  fun unlock(record: WalletRecord) {
    check(record.id == saved.walletId)
    assertExecutionAvailable(record)
    checkNotNull(operation).unlock(record.entropy, now())
    persist()
  }

  fun retry() {
    store.load().use { record -> assertExecutionAvailable(record) }
    operation?.retry()
  }

  fun cancel() {
    approvalScope?.invalidate()
    displayedScope?.invalidate()
    approvalScope = null
    displayedScope = null
    operation?.cancel()
    batch?.cancel()
    persist()
    batch?.let { checkNotNull(reservations).cancelBatchUnsigned(it.id) }
  }

  fun view(): Map<String, Any?> {
    val status = aggregateStatus()
    fun text(name: String) = if (status.isNull(name)) null else status.optString(name)
    return mapOf(
      "operationId" to status.getString("operationId"),
      "phase" to status.getString("phase"),
      "step" to status.getString("step"),
      "pausedCode" to text("pausedCode"),
      "targetSymbol" to status.optString("targetSymbol"),
      "targetDecimals" to status.optInt("targetDecimals"),
      "sourceAtoms" to status.optString("sourceAtoms"),
      "creditedAtoms" to status.optString("creditedAtoms"),
      "payoutsSubmitted" to status.optInt("payoutsSubmitted"),
      "ordersComplete" to status.optInt("ordersComplete"),
      "receivedTargetAtoms" to status.optString("receivedTargetAtoms"),
      "direction" to status.optString("direction", "buy"),
      "kind" to status.optString("kind", ""),
      "completionTarget" to status.optString("completionTarget", "public"),
      "privateCreditedAtoms" to status.optString("privateCreditedAtoms", "0"),
      "soldAtoms" to status.optString("soldAtoms", "0"),
      "receivedUsdgAtoms" to status.optString("receivedUsdgAtoms", "0"),
      "legs" to status.optInt("legs", 3),
      "holders" to status.optInt("holders", status.optInt("legs", 3)),
      "approved" to status.optBoolean("approved"),
      "returnAddresses" to returnAddresses(),
      "fundingAddress" to checkNotNull(fundingAddress),
      "fundingBatchId" to batch?.id,
      "fundingBatchSize" to batch?.size,
      "fundingLegIndex" to batch?.currentIndex,
    )
  }

  private fun returnAddresses(): List<String> {
    val root = saved.load() ?: return emptyList()
    val state = JSONObject(root.getString("state"))
    if (
      state.optJSONObject("plan")?.optString("kind") != "confidentialSell" ||
        state.optJSONObject("plan")?.optString("completionTarget") == "confidential"
    )
      return emptyList()
    val recipients = state.optJSONArray("recipients") ?: return emptyList()
    return (0 until recipients.length()).map { recipients.getString(it) }
  }

  private fun persist() {
    val op = checkNotNull(operation)
    val state = op.exportState()
    val status = op.publicStatus()
    batch?.record(state, status)
    val current = JSONObject(status)
    val sold = current.optString("soldAtoms", "0")
    val credit = current.optString("privateCreditedAtoms", "0")
    val progress = "$sold:$credit"
    if (
      current.optString("completionTarget") == "confidential" &&
        (sold != "0" || credit != "0") &&
        progress != lastInvalidatedPublicSaleProgress
    ) {
      // Dirty the origin observations before publishing newly verified private
      // credit, so an interrupted refresh cannot retain both as fresh value.
      store.load().use { record ->
        NativeOwnedPortfolio(saved.context)
          .invalidateTokens(
            record,
            4663,
            setOf(JSONObject(state).getJSONObject("plan").getString("target")),
          )
      }
      lastInvalidatedPublicSaleProgress = progress
    }
    saved.save(batch?.id ?: op.operationId(), state, checkNotNull(fundingAddress), batch?.json)
    // Signatures are durably saved before the shared source reservation becomes signed.
    if (
      batch != null &&
        JSONObject(status).getString("phase") != "COMPLETE" &&
        !JSONObject(state).getJSONObject("data").isNull("signedOperation")
    )
      checkNotNull(reservations).markSigned(op.operationId())
    saved.portfolio.remember(state, aggregateStatus().toString())
    if (
      current.optString("completionTarget") == "confidential" &&
        current.optString("privateCreditedAtoms", "0") != "0" &&
        current.optString("privateCreditedAtoms") != lastInvalidatedPrivateCredit
    ) {
      store.load().use { record ->
        val confidential = JSONObject(state).getString("confidential")
        NativeOwnedConfidentialPortfolio(saved.context)
          .invalidateSources(record, setOf(confidential))
        lastInvalidatedPrivateCredit = current.optString("privateCreditedAtoms")
      }
    }
    diagnostic("persisted")
  }

  private fun rememberPrevious(existing: JSONObject, previous: SwapOperation) {
    val view = JSONObject(previous.publicStatus())
    val status =
      existing.optJSONObject("fundingBatch")?.let {
        SwapFundingBatch.restore(it).publicStatus(view)
      } ?: view
    saved.portfolio.remember(existing.getString("state"), status.toString())
  }

  private fun aggregateStatus(): JSONObject {
    val status = JSONObject(checkNotNull(operation).publicStatus())
    val funding = batch ?: return status
    funding.record(checkNotNull(operation).exportState(), checkNotNull(operation).publicStatus())
    return funding.publicStatus(status)
  }

  // Enable explicitly with: adb shell setprop log.tag.GizuSwap DEBUG.
  // Never log the exported state, URLs, bodies, addresses or signatures.
  private fun diagnostic(
    event: String,
    requestId: ULong? = null,
    status: Int? = null,
    elapsedMs: Long? = null,
  ) {
    if (!Log.isLoggable("GizuSwap", Log.DEBUG)) return
    val state = operation?.let { JSONObject(it.publicStatus()) } ?: return
    fun label(key: String): String =
      state.optString(key).takeIf { it.matches(Regex("[A-Za-z0-9_]{1,64}")) } ?: "none"
    Log.d(
      "GizuSwap",
      "$event phase=${label("phase")} step=${label("step")} pause=${label("pausedCode")} request=$requestId status=$status elapsedMs=$elapsedMs",
    )
  }

  override fun close() {
    approvalScope?.invalidate()
    displayedScope?.invalidate()
    approvalScope = null
    displayedScope = null
    operation?.close()
    operation = null
  }

  private fun now() = System.currentTimeMillis().toULong()
}

/** Native-only, nonpersisted authority for the exact combined review and source limits. */
internal class SwapBatchApproval
private constructor(
  private val walletId: String,
  private val generation: String,
  private val registry: String,
  private val terms: Map<String, Pair<String, java.math.BigInteger>>,
  val digest: String,
) {
  private var approvedAt: Long? = null
  private var invalidated = false

  companion object {
    fun safeToPreview(state: JSONObject): Boolean {
      if (!state.isNull("approvedMs") || state.optBoolean("cancelled")) return false
      val data = state.getJSONObject("data")
      if (!data.isNull("signedOperation")) return false
      fun unsigned(rows: JSONArray?, fields: List<String>) =
        rows == null ||
          (0 until rows.length()).all { index ->
            fields.all { rows.getJSONObject(index).isNull(it) }
          }
      return unsigned(data.optJSONArray("payouts"), listOf("signed")) &&
        unsigned(data.optJSONArray("orders"), listOf("permit", "signature"))
    }

    fun create(
      walletId: String,
      generation: String,
      roleRegistry: String,
      batchId: String,
      children: List<JSONObject>,
      review: String,
    ): SwapBatchApproval {
      check(children.size in 1..256 && review.isNotBlank())
      val terms = linkedMapOf<String, Pair<String, java.math.BigInteger>>()
      val manifest = JSONArray()
      var shared: String? = null
      for (child in children) {
        val state = JSONObject(child.getString("state"))
        val p = state.getJSONObject("plan")
        val data = state.getJSONObject("data")
        check(
          p.getString("kind") == "confidentialSwap" &&
            state.getString("id") == child.getString("operationId") &&
            p.getInt("sourceIndex") == child.getInt("sourceIndex")
        )
        check(
          state.getString("source").equals(child.getString("fundingAddress"), true) &&
            swapBatchAtoms(data.getString("budget")) ==
              child.getString("budgetAtoms").toBigInteger()
        )
        val same =
          swapBatchCanonical(
            JSONObject()
              .put("target", p.get("target"))
              .put("recipientIndices", p.getJSONArray("recipientIndices"))
              .put("recipients", state.getJSONArray("recipients"))
              .put("confidential", state.getString("confidential"))
          )
        check(shared == null || shared == same)
        shared = same
        val immutable = binding(state)
        val cap = swapBatchAtoms(data.getString("fundingFee"))
        check(terms.put(state.getString("id"), immutable to cap) == null)
        manifest.put(
          JSONObject(immutable)
            .put("maximumFundingFeeAtoms", cap.toString())
            .put("originalPrepared", data.opt("prepared") ?: JSONObject.NULL)
        )
      }
      val registry = swapBatchCanonical(JSONObject(roleRegistry))
      val text =
        swapBatchCanonical(
          JSONObject()
            .put("walletId", walletId)
            .put("generation", generation)
            .put("registry", JSONObject(registry))
            .put("batchId", batchId)
            .put("children", manifest)
            .put("review", review)
        )
      val digest =
        "0x" +
          java.security.MessageDigest.getInstance("SHA-256")
            .digest(text.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
      return SwapBatchApproval(walletId, generation, registry, terms, digest)
    }

    private fun binding(state: JSONObject): String {
      val d = state.getJSONObject("data")
      return swapBatchCanonical(
        JSONObject()
          .put("id", state.getString("id"))
          .put("plan", state.getJSONObject("plan"))
          .put("source", state.getString("source"))
          .put("confidential", state.getString("confidential"))
          .put("recipients", state.getJSONArray("recipients"))
          .put("budget", swapBatchAtoms(d.getString("budget")).toString())
          .put("fundingAmount", swapBatchAtoms(d.getString("fundingAmount")).toString())
          .put("fundingQuote", d.getJSONObject("fundingQuote"))
          .put("estimates", d.getJSONArray("estimates"))
          .put("rateAmount", d.getString("rateAmount"))
          .put("rateEnd", d.getString("rateEnd"))
      )
    }
  }

  @Synchronized
  fun approveAfterPasskey(record: WalletRecord, now: Long) {
    check(!invalidated && approvedAt == null && now >= 0 && now <= Long.MAX_VALUE - 900000)
    wallet(record)
    approvedAt = now
  }

  @Synchronized
  fun assertAuthorized(record: WalletRecord, state: JSONObject, now: Long) {
    val start = approvedAt
    check(!invalidated && start != null && now >= start && now - start < 900000)
    wallet(record)
    val term = terms[state.getString("id")]
    check(
      term != null &&
        !state.optBoolean("cancelled") &&
        binding(state) == term.first &&
        swapBatchAtoms(state.getJSONObject("data").getString("fundingFee")) <= term.second
    ) {
      "Swap source terms changed; review the batch again"
    }
  }

  private fun wallet(record: WalletRecord) {
    check(
      record.id == walletId &&
        record.journalId == generation &&
        record.verified &&
        !record.earnRecoveryRequired &&
        swapBatchCanonical(JSONObject(record.roleRegistry)) == registry
    )
  }

  @Synchronized
  fun invalidate() {
    invalidated = true
    approvedAt = null
  }
}

/** New purchases draw wallet count and shares once; false restores fixed three-wallet 30/30/40. */
private const val RANDOM_LEGS = true

private fun randomBytes(): ByteArray = ByteArray(32).also { SecureRandom().nextBytes(it) }

private fun swapBatchAtoms(value: String): java.math.BigInteger =
  if (value.startsWith("0x")) value.substring(2).toBigInteger(16) else value.toBigInteger()

private fun swapBatchCanonical(value: Any?): String =
  when (value) {
    null,
    JSONObject.NULL -> "null"
    is JSONObject ->
      value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") {
        JSONObject.quote(it) + ":" + swapBatchCanonical(value.get(it))
      }
    is JSONArray ->
      (0 until value.length()).joinToString(",", "[", "]") { swapBatchCanonical(value.get(it)) }
    is String -> JSONObject.quote(value)
    is Boolean -> value.toString()
    is Number -> java.math.BigDecimal(value.toString()).stripTrailingZeros().toPlainString()
    else -> error("Invalid native swap manifest")
  }

/** Private sale plans contain existing holders, never freshly allocated receivers. */
internal fun confidentialSalePlan(target: String, holders: JSONArray): JSONObject {
  require(target.matches(Regex("0x[0-9a-fA-F]{40}")))
  require(holders.length() in 1..5)
  val indices =
    (0 until holders.length()).map { index ->
      val value = holders.getInt(index)
      require(holders.getDouble(index) == value.toDouble() && value >= 3)
      value
    }
  require(indices.distinct().size == indices.size)
  return JSONObject()
    .put("kind", "confidentialSell")
    .put("completionTarget", "confidential")
    .put("target", target)
    .put("holderIndices", JSONArray(indices))
    .put("recipientIndices", JSONArray(indices))
}
