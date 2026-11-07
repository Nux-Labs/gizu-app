package io.gizu.storedwallet

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.*

private val earnProposalFields =
  setOf(
    "kind",
    "operationId",
    "revision",
    "chainId",
    "expectedFrom",
    "vault",
    "token",
    "router",
    "amountAtoms",
    "deadline",
    "slippageBps",
    "nonce",
    "gasLimits",
    "maxFeePerGasWei",
    "priorityFeePerGasWei",
    "maximumGasCostWei",
    "withdrawalReserveWei",
  )

internal fun canonicalEarnVaultProposal(
  walletId: String,
  owner: String,
  request: Map<String, Any?>,
): JSONObject {
  check(
    request.keys.containsAll(earnProposalFields + "walletId") &&
      request.keys.all {
        it in earnProposalFields + setOf("walletId", "cycleIndex", "investmentSlot")
      } &&
      request["walletId"] == walletId
  )
  val p = JSONObject(request)
  p.remove("walletId")
  check(p.getString("expectedFrom").equals(owner, true))
  p.put("expectedFrom", owner)
  fun exact(value: Any): Long {
    val n = value as? Number ?: error("Invalid integer")
    val d = n.toDouble()
    check(d.isFinite() && d >= 0 && d <= 9007199254740991.0 && d == n.toLong().toDouble())
    return n.toLong()
  }
  for (field in listOf("revision", "chainId", "deadline", "slippageBps", "nonce")) p.put(
    field,
    exact(p.get(field)),
  )
  val gas = p.getJSONArray("gasLimits")
  for (i in 0 until gas.length()) gas.put(i, exact(gas.get(i)))
  check(
    p.getLong("chainId") == 1L && p.getString("kind") in setOf("vaultDeposit", "vaultRedeemAll")
  )
  return p
}

/** Refresh only the unsigned router deadline after finalized approval and require new review. */
internal fun earnContinuationProposal(
  op: JSONObject,
  freshNonce: ULong,
  now: Long = System.currentTimeMillis() / 1000,
): JSONObject {
  val p = JSONObject(op.getJSONObject("proposal").toString())
  val signed = op.steps().filter { it.has("raw") }
  check(signed.all { it.getString("status") == "finalized" })
  if (signed.isNotEmpty()) {
    check(signed.size == 1 && !signed.single().getString("to").equals(ETH_EARN_ROUTER, true))
    check(freshNonce == p.getLong("nonce").toULong() + 1uL)
    val gas = p.getJSONArray("gasLimits")
    check(gas.length() == 2)
    check(now >= 0 && now <= Long.MAX_VALUE - 300)
    p.put("gasLimits", JSONArray().put(gas.getLong(1)))
      .put("nonce", freshNonce.toLong())
      .put("deadline", now + 300)
  }
  p.put("revision", op.getInt("revision"))
  return p
}

internal data class EarnVaultReview(
  val id: String,
  val revision: Int,
  val coreRevision: ULong,
  val hash: String,
  val text: String,
  val index: Int,
  val retry: Boolean,
)

internal interface EarnVaultSigner : AutoCloseable {
  fun prepare(revision: ULong, state: EarnExecutionState): String

  fun reviewHash(): String

  fun preparedCalls(): List<EarnExecutionCall>

  fun approve(revision: ULong, hash: String)

  fun signNextWithCanonicalReference(
    revision: ULong,
    state: EarnExecutionState,
    reference: NativeGasReference,
  ): NativeSignedEarnTransaction
}

private class RustEarnVaultSigner(proposal: String, entropy: ByteArray) : EarnVaultSigner {
  private val core = EarnExecutionOperation(proposal, entropy)

  override fun prepare(revision: ULong, state: EarnExecutionState) = core.prepare(revision, state)

  override fun reviewHash() = core.reviewHash()

  override fun preparedCalls() = core.preparedCalls()

  override fun approve(revision: ULong, hash: String) = core.approve(revision, hash)

  override fun signNextWithCanonicalReference(
    revision: ULong,
    state: EarnExecutionState,
    reference: NativeGasReference,
  ) = core.signNextWithCanonicalReference(revision, state, reference)

  override fun close() {
    core.invalidate()
    core.close()
  }
}

/**
 * Every authority callback is native-owned and rechecks wallet generation, profile and ceremony.
 */
internal class EarnVaultEngine(
  private val store: WalletStore,
  val journal: EarnVaultJournal,
  private val rpc: TransferRpc,
  private val signerFactory: (String, ByteArray) -> EarnVaultSigner = ::RustEarnVaultSigner,
  private val stateLoader: suspend (String, String, String) -> EarnExecutionState =
    EarnVaultStateLoader(rpc)::load,
  private val eventTopic: (String) -> String = ::earnEventTopic,
) : AutoCloseable {
  private var signer: EarnVaultSigner? = null
  private var prepared: EarnVaultReview? = null
  private var reviewedBlock: Pair<ULong, String>? = null

  private fun walletCheck(record: WalletRecord) {
    requireEarnExecutionWallet(record, journal.walletId)
    check(record.journalId == journal.generation)
  }

  suspend fun create(request: Map<String, Any?>): JSONObject {
    reconcileEarnVaultOperations(journal, rpc, eventTopic)
    return store.load().use { record ->
      walletCheck(record)
      val owner = cycleInvestmentAddress(record)
      val proposal =
        attachInvestmentSlot(record, canonicalEarnVaultProposal(record.id, owner, request))
      // Validate strict Rust proposal/derivation before durable creation, without approval.
      requireActiveEarnCycle(record, proposal)
      signerFactory(proposal.toString(), record.entropy).use {}
      journal.create(proposal)
    }
  }

  suspend fun prepare(id: String, revision: Int): EarnVaultReview {
    check(journal.get(id).getInt("revision") == revision)
    reconcileEarnVaultOperations(journal, rpc, eventTopic)
    val op = journal.get(id)
    check(journal.public(op)["canResume"] == true)
    store.load().use {
      walletCheck(it)
      requireActiveEarnCycle(it, journal.get(id).getJSONObject("proposal"))
    }
    val unresolved = op.steps().filter { it.has("raw") && it.getString("status") !in terminalSteps }
    if (unresolved.isNotEmpty()) {
      val step = unresolved.single()
      check(step.getString("status") == "signed" && !step.optBoolean("conflict"))
      checkRetry(op, step)
      return EarnVaultReview(
          id,
          op.getInt("revision"),
          0uL,
          op.getString("reviewHash"),
          "ETHEREUM · chain 1\nRebroadcast exactly the saved transaction. No new signature or nonce.\n${op.getString("review")}\nSaved hash ${step.getString("transactionHash")}\nSaved nonce ${step.getString("nonce")}",
          step.getInt("index"),
          true,
        )
        .also { prepared = it }
    }
    val original = op.getJSONObject("proposal")
    val state =
      stateLoader(
        original.getString("expectedFrom"),
        original.getString("kind"),
        original.getString("amountAtoms"),
      )
    val proposal = earnContinuationProposal(op, state.nonce)
    val coreRevision = proposal.getLong("revision").toULong()
    signer?.close()
    signer =
      store.load().use { record ->
        walletCheck(record)
        signerFactory(proposal.toString(), record.entropy)
      }
    val core = checkNotNull(signer)
    val text = core.prepare(coreRevision, state)
    reviewedBlock = state.blockNumber to state.blockHash
    val hash = core.reviewHash()
    val calls =
      JSONArray(
        core.preparedCalls().map { call ->
          JSONObject()
            .put("to", call.to)
            .put("data", call.data)
            .put("valueWei", call.valueWei)
            .put("nonce", call.nonce.toString())
            .put("gasLimit", call.gasLimit.toString())
            .put("maxFeePerGasWei", call.maxFeePerGasWei)
            .put("priorityFeePerGasWei", call.priorityFeePerGasWei)
        }
      )
    val updated = journal.prepare(id, op.getInt("revision"), calls, hash, text)
    val recorded =
      journal.update(id, updated.getInt("revision")) { target ->
        target
          .put("baselineShares", state.shares)
          .put("signingProposal", proposal)
          .put(
            "stateBinding",
            JSONObject()
              .put("tokenCodeHash", state.tokenCodeHash)
              .put("vaultCodeHash", state.vaultCodeHash)
              .put("routerCodeHash", state.routerCodeHash)
              .put("vaultAsset", state.vaultAsset)
              .put("tokenDecimals", state.tokenDecimals.toInt()),
          )
      }
    return EarnVaultReview(
        id,
        recorded.getInt("revision"),
        coreRevision,
        hash,
        text,
        op.steps().count { it.has("raw") },
        false,
      )
      .also { prepared = it }
  }

  private suspend fun checkRetry(op: JSONObject, step: JSONObject) {
    val p = op.getJSONObject("proposal")
    val state =
      stateLoader(p.getString("expectedFrom"), p.getString("kind"), p.getString("amountAtoms"))
    val binding = op.getJSONObject("stateBinding")
    check(
      state.tokenCodeHash == binding.getString("tokenCodeHash") &&
        state.vaultCodeHash == binding.getString("vaultCodeHash") &&
        state.routerCodeHash == binding.getString("routerCodeHash")
    )
    check(
      state.vaultAsset.equals(binding.getString("vaultAsset"), true) &&
        state.tokenDecimals.toInt() == binding.getInt("tokenDecimals")
    )
    val amount = p.getString("amountAtoms").toBigInteger()
    if (p.getString("kind") == "vaultDeposit")
      check(state.usdcBalanceAtoms.toBigInteger() >= amount)
    else
      check(state.shares.toBigInteger() == amount && state.maxRedeemShares.toBigInteger() >= amount)
    check(state.nonce.toString() == step.getString("nonce") && state.senderCode == "0x")
    check(
      quantity(rpc.text("eth_getTransactionCount", state.owner, "latest")) ==
        step.getString("nonce").toBigInteger()
    )
    requireEarnRetryEconomics(op, step, state)
  }

  suspend fun execute(review: EarnVaultReview, authority: () -> Unit) {
    check(prepared == review && journal.get(review.id).getInt("revision") == review.revision)
    authority()
    store.load().use {
      walletCheck(it)
      requireActiveEarnCycle(it, journal.get(review.id).getJSONObject("proposal"))
    }
    currentCoroutineContext().ensureActive()
    val op = journal.get(review.id)
    val p = op.getJSONObject("proposal")
    if (review.retry) {
      val step = op.steps()[review.index]
      checkRetry(op, step)
      authority()
      store.load().use {
        walletCheck(it)
        requireActiveEarnCycle(it, journal.get(review.id).getJSONObject("proposal"))
      }
      currentCoroutineContext().ensureActive()
      journal.update(review.id, review.revision) {
        it.steps()[review.index].put("status", "unknown")
      }
      authority()
      currentCoroutineContext().ensureActive()
      val returned = rpc.text("eth_sendRawTransaction", step.getString("raw"))
      check(returned.equals(step.getString("transactionHash"), true))
    } else {
      val core = checkNotNull(signer)
      val state =
        stateLoader(p.getString("expectedFrom"), p.getString("kind"), p.getString("amountAtoms"))
      val anchor = checkNotNull(reviewedBlock)
      val reference = loadEarnGasReference(rpc, anchor.first, anchor.second, state)
      authority()
      store.load().use {
        walletCheck(it)
        requireActiveEarnCycle(it, journal.get(review.id).getJSONObject("proposal"))
      }
      currentCoroutineContext().ensureActive()
      check(journal.get(review.id).getInt("revision") == review.revision)
      core.approve(review.coreRevision, review.hash)
      val tx = core.signNextWithCanonicalReference(review.coreRevision, state, reference)
      check(tx.operationId == review.id && tx.revision == review.coreRevision && tx.step == 0u)
      journal.persistSigned(
        review.id,
        review.revision,
        review.index,
        tx.rawTransaction,
        tx.transactionHash,
        tx.from,
        tx.nonce.toString(),
        tx.reviewHash,
      )
      authority()
      store.load().use {
        walletCheck(it)
        requireActiveEarnCycle(it, journal.get(review.id).getJSONObject("proposal"))
      }
      currentCoroutineContext().ensureActive()
      val returned = rpc.text("eth_sendRawTransaction", tx.rawTransaction)
      check(returned.equals(tx.transactionHash, true))
    }
    // Each invocation sends one approved transaction. Later unsigned calls get fresh native
    // approval.
    reconcileEarnVaultOperations(journal, rpc, eventTopic)
  }

  override fun close() {
    signer?.close()
    signer = null
    prepared = null
    reviewedBlock = null
  }
}

internal fun requireEarnRetryEconomics(
  op: JSONObject,
  step: JSONObject,
  state: EarnExecutionState,
  now: Long = System.currentTimeMillis() / 1000,
) {
  val proposal = op.getJSONObject("proposal")
  if (step.getString("to").equals(ETH_EARN_ROUTER, true))
    check((op.optJSONObject("signingProposal") ?: proposal).getLong("deadline") > now) {
      "Saved router deadline expired"
    }
  val remaining = op.steps().filter { it.getString("status") !in terminalSteps }
  for (call in remaining) check(
    state.baseFeeWei.toBigInteger() + call.getString("priorityFeePerGasWei").toBigInteger() <=
      call.getString("maxFeePerGasWei").toBigInteger()
  )
  val gas =
    remaining.fold(java.math.BigInteger.ZERO) { sum, call ->
      sum +
        call.getString("gasLimit").toBigInteger() * call.getString("maxFeePerGasWei").toBigInteger()
    }
  check(
    state.nativeBalanceWei.toBigInteger() >=
      gas + proposal.getString("withdrawalReserveWei").toBigInteger()
  ) {
    "Saved operation and reserve no longer funded"
  }
}
