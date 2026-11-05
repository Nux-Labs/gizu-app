package io.gizu.storedwallet

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.*

internal interface NativeLiquidityCancellationSigner : AutoCloseable {
  fun prepare(revision: ULong, state: NativeEthereumLiquidityState): String

  fun reviewHash(): String

  fun approve(revision: ULong, hash: String)

  fun sign(revision: ULong, state: NativeEthereumLiquidityState): NativeSignedEarnTransaction
}

private class RustLiquidityCancellationSigner(p: String, entropy: ByteArray) :
  NativeLiquidityCancellationSigner {
  private val core = EthereumLiquidityCancellationOperation(p, entropy)

  override fun prepare(revision: ULong, state: NativeEthereumLiquidityState) =
    core.prepare(revision, state)

  override fun reviewHash() = core.reviewHash()

  override fun approve(revision: ULong, hash: String) = core.approve(revision, hash)

  override fun sign(revision: ULong, state: NativeEthereumLiquidityState) =
    core.sign(revision, state)

  override fun close() {
    core.invalidate()
    core.close()
  }
}

internal data class LiquidityCancellationReview(
  val id: String,
  val revision: Int,
  val coreRevision: ULong,
  val hash: String,
  val text: String,
  val retry: Boolean,
)

/**
 * This context is assembled exclusively from an authenticated private journal, never an Expo
 * proposal.
 */
internal suspend fun requireProtectedLiquidityCancellationNonce(op: JSONObject, rpc: TransferRpc) {
  check(
    op.has("raw") &&
      !op.liquidityRawConsumed() &&
      quantity(rpc.text("eth_chainId")) == java.math.BigInteger.ONE
  )
  val p = op.optJSONObject("signingProposal") ?: op.getJSONObject("proposal")
  val owner = p.getString("expectedFrom")
  val expected = p.getLong("nonce").toBigInteger()
  val latest = quantity(rpc.text("eth_getTransactionCount", owner, "latest"))
  val pending = quantity(rpc.text("eth_getTransactionCount", owner, "pending"))
  check(latest == expected && (pending == latest || pending == latest + java.math.BigInteger.ONE)) {
    "Original nonce already consumed or unrelated pending nonce"
  }
  if (pending != latest) {
    var known = false
    val original =
      rpc.call("eth_getTransactionByHash", JSONArray().put(op.getString("transactionHash")))
    if (original is JSONObject) {
      requireLiquidityTransaction(original, p, op.getString("transactionHash"))
      known = !original.has("blockHash") || original.isNull("blockHash")
    } else check(original === JSONObject.NULL)
    for (attempt in op.liquidityCancellationAttempts()) {
      val tx =
        rpc.call("eth_getTransactionByHash", JSONArray().put(attempt.getString("transactionHash")))
      if (tx is JSONObject) {
        requireLiquidityCancellationTransaction(
          tx,
          attempt.getJSONObject("proposal"),
          attempt.getString("transactionHash"),
        )
        known = known || !tx.has("blockHash") || tx.isNull("blockHash")
      } else check(tx === JSONObject.NULL)
    }
    check(known) { "Pending nonce is not independently bound to this saved operation" }
  }
}

private fun bumpedCancellationFee(value: String): java.math.BigInteger {
  val n = value.toBigInteger()
  check(n.signum() >= 0)
  return ((n * 9.toBigInteger() + 7.toBigInteger()) / 8.toBigInteger()).max(
    n + java.math.BigInteger.ONE
  )
}

internal fun nativeLiquidityCancellationProposal(
  op: JSONObject,
  state: NativeEthereumLiquidityState,
  now: Long = System.currentTimeMillis() / 1000,
): JSONObject {
  val original = op.optJSONObject("signingProposal") ?: op.getJSONObject("proposal")
  val last = op.liquidityCancellationAttempts().lastOrNull()
  val replaced = last?.getJSONObject("proposal") ?: original
  val raw = last?.getString("raw") ?: op.getString("raw")
  val hash = last?.getString("transactionHash") ?: op.getString("transactionHash")
  val legacy = !raw.startsWith("0x02", true)
  val tip =
    if (legacy) java.math.BigInteger.ZERO
    else bumpedCancellationFee(replaced.getString("priorityFeePerGasWei"))
  val maximum =
    bumpedCancellationFee(replaced.getString("maxFeePerGasWei"))
      .max(state.baseFeeWei.toBigInteger() * 2.toBigInteger() + tip)
  val cost = maximum * 21000.toBigInteger()
  check(
    state.nonce.toString() == original.getLong("nonce").toString() &&
      state.nativeBalanceWei.toBigInteger() >= cost
  ) {
    "Cancellation gas budget is not funded"
  }
  return JSONObject()
    .put("kind", "cancelPendingLiquidity")
    .put("operationId", op.getString("operationId"))
    .put("revision", op.getInt("revision"))
    .put("chainId", 1)
    .put("expectedFrom", original.getString("expectedFrom"))
    .put("confidentialAccount", original.getString("confidentialAccount"))
    .put("originalRawTransaction", raw)
    .put("originalTransactionHash", hash)
    .put("nonce", original.getLong("nonce"))
    .put("deadline", Math.addExact(now, 300L))
    .put("gasLimit", 21000)
    .put("maxFeePerGasWei", maximum.toString())
    .put("priorityFeePerGasWei", tip.toString())
    .put("maximumGasCostWei", cost.toString())
    .also {
      if (original.has("cycleIndex")) it.put("cycleIndex", original.getInt("cycleIndex"))
      if (original.has("investmentSlot"))
        it.put("investmentSlot", original.getInt("investmentSlot"))
    }
}

internal fun requireSavedLiquidityCancellationAffordable(
  attempt: JSONObject,
  state: NativeEthereumLiquidityState,
) {
  val p = attempt.getJSONObject("proposal")
  check(
    state.chainId == 1uL &&
      state.owner.equals(p.getString("expectedFrom"), true) &&
      state.nonce.toString() == p.getLong("nonce").toString() &&
      state.senderCode == "0x"
  )
  check(
    state.baseFeeWei.toBigInteger() + p.getString("priorityFeePerGasWei").toBigInteger() <=
      p.getString("maxFeePerGasWei").toBigInteger()
  )
  check(state.nativeBalanceWei.toBigInteger() >= p.getString("maximumGasCostWei").toBigInteger())
  val saved = attempt.getJSONObject("stateBinding")
  val fresh = liquidityStateBinding(state)
  for (field in
    listOf(
      "senderCode",
      "usdcCodeHash",
      "wethCodeHash",
      "routerCodeHash",
      "settlementCodeHash",
      "feeReceiverCodeHash",
      "vaultCodeHash",
    )) check(saved.getString(field).equals(fresh.getString(field), true))
  // The approval deadline limits creation of a signature. A saved raw transaction has no on-chain
  // expiry.
}

/** A click may approve one same-nonce cancellation or rebroadcast its exact saved bytes. */
internal class EarnLiquidityCancellationEngine(
  private val store: WalletStore,
  val journal: EarnLiquidityJournal,
  private val rpc: TransferRpc,
  private val signerFactory: (String, ByteArray) -> NativeLiquidityCancellationSigner =
    ::RustLiquidityCancellationSigner,
  private val stateReader: suspend (JSONObject) -> NativeEthereumLiquidityState =
    EarnLiquidityStateLoader(rpc)::loadCancellation,
  private val reconcile: suspend () -> Unit = {
    reconcileEarnLiquidityOperations(journal, rpc, NativeFusionGateway())
  },
) : AutoCloseable {
  private var signer: NativeLiquidityCancellationSigner? = null
  private var displayed: LiquidityCancellationReview? = null
  private var proposal: JSONObject? = null

  private fun walletCheck(record: WalletRecord, proposal: JSONObject) {
    requireEarnExecutionWallet(record, journal.walletId)
    check(record.journalId == journal.generation)
    requireActiveEarnCycle(record, proposal)
  }

  suspend fun prepare(id: String, revision: Int): LiquidityCancellationReview? {
    check(journal.get(id).getInt("revision") == revision)
    store.load().use { walletCheck(it, journal.get(id).getJSONObject("proposal")) }
    reconcile()
    val op = journal.get(id)
    if (op.liquidityRawConsumed()) return null
    check(journal.public(op)["canCancelPending"] == true)
    requireProtectedLiquidityCancellationNonce(op, rpc)
    val original = op.optJSONObject("signingProposal") ?: op.getJSONObject("proposal")
    val last = op.liquidityCancellationAttempts().lastOrNull()
    // A provisional native-only context pins the original canonical nonce even when its pending
    // count is nonce+1.
    val context =
      last?.getJSONObject("proposal")
        ?: JSONObject()
          .put("kind", "cancelPendingLiquidity")
          .put("expectedFrom", original.getString("expectedFrom"))
          .put("nonce", original.getLong("nonce"))
          .put("originalTransactionHash", op.getString("transactionHash"))
    val state = stateReader(context)
    if (
      last != null &&
        state.baseFeeWei.toBigInteger() +
          last.getJSONObject("proposal").getString("priorityFeePerGasWei").toBigInteger() <=
          last.getJSONObject("proposal").getString("maxFeePerGasWei").toBigInteger()
    ) {
      requireSavedLiquidityCancellationAffordable(last, state)
      proposal = last.getJSONObject("proposal")
      return LiquidityCancellationReview(
          id,
          op.getInt("revision"),
          0uL,
          last.getString("reviewHash"),
          "Rebroadcast the exact saved same-nonce cancellation. No new signature, nonce or fee.\n${last.getString("review")}\nSaved cancellation hash ${last.getString("transactionHash")}",
          true,
        )
        .also { displayed = it }
    }
    val p = nativeLiquidityCancellationProposal(op, state)
    val revisionCore = p.getLong("revision").toULong()
    signer?.close()
    signer =
      store.load().use { record ->
        walletCheck(record, p)
        signerFactory(p.toString(), record.entropy)
      }
    val core = checkNotNull(signer)
    val text = core.prepare(revisionCore, state)
    val hash = core.reviewHash()
    proposal = p
    return LiquidityCancellationReview(id, op.getInt("revision"), revisionCore, hash, text, false)
      .also { displayed = it }
  }

  suspend fun execute(review: LiquidityCancellationReview, authority: () -> Unit) {
    check(displayed == review && journal.get(review.id).getInt("revision") == review.revision)
    authority()
    store.load().use { walletCheck(it, journal.get(review.id).getJSONObject("proposal")) }
    currentCoroutineContext().ensureActive()
    reconcile()
    val op = journal.get(review.id)
    if (op.liquidityRawConsumed()) return
    check(op.getInt("revision") == review.revision)
    requireProtectedLiquidityCancellationNonce(op, rpc)
    val p = checkNotNull(proposal)
    val state = stateReader(p)
    authority()
    store.load().use { walletCheck(it, journal.get(review.id).getJSONObject("proposal")) }
    currentCoroutineContext().ensureActive()
    if (review.retry) {
      val saved = op.liquidityCancellationAttempts().last()
      requireSavedLiquidityCancellationAffordable(saved, state)
      journal.update(review.id, review.revision) { target ->
        target.liquidityCancellationAttempts().last().put("status", "unknown")
        target.put("status", "cancellationPending")
      }
      authority()
      store.load().use { walletCheck(it, journal.get(review.id).getJSONObject("proposal")) }
      currentCoroutineContext().ensureActive()
      check(
        rpc
          .text("eth_sendRawTransaction", saved.getString("raw"))
          .equals(saved.getString("transactionHash"), true)
      )
    } else {
      signer?.close()
      signer = null
      val core =
        store.load().use { record ->
          walletCheck(record, p)
          signerFactory(p.toString(), record.entropy)
        }
      core.use {
        val text = it.prepare(review.coreRevision, state)
        val hash = it.reviewHash()
        check(text == review.text && hash == review.hash)
        authority()
        currentCoroutineContext().ensureActive()
        check(journal.get(review.id).getInt("revision") == review.revision)
        it.approve(review.coreRevision, hash)
        val signed = it.sign(review.coreRevision, state)
        check(
          signed.operationId == review.id &&
            signed.revision == review.coreRevision &&
            signed.nonce.toString() == p.getLong("nonce").toString() &&
            signed.from.equals(p.getString("expectedFrom"), true) &&
            signed.reviewHash == hash
        )
        journal.update(review.id, review.revision) { target ->
          check(target.has("raw") && !target.liquidityRawConsumed())
          val attempts = target.optJSONArray("cancellationAttempts") ?: JSONArray()
          check(attempts.length() < 256)
          check(
            target.getString("transactionHash") != signed.transactionHash &&
              target.liquidityCancellationAttempts().none { old ->
                old.getString("transactionHash") == signed.transactionHash
              }
          )
          attempts.put(
            JSONObject()
              .put("raw", signed.rawTransaction)
              .put("transactionHash", signed.transactionHash)
              .put("proposal", JSONObject(p.toString()))
              .put("stateBinding", liquidityStateBinding(state))
              .put("review", text)
              .put("reviewHash", hash)
              .put("status", "unknown")
          )
          target.put("cancellationAttempts", attempts).put("status", "cancellationPending")
        }
        authority()
        store.load().use { walletCheck(it, journal.get(review.id).getJSONObject("proposal")) }
        currentCoroutineContext().ensureActive()
        check(
          rpc
            .text("eth_sendRawTransaction", signed.rawTransaction)
            .equals(signed.transactionHash, true)
        )
      }
    }
    reconcile()
    displayed = null
    proposal = null
  }

  override fun close() {
    signer?.close()
    signer = null
    displayed = null
    proposal = null
  }
}
