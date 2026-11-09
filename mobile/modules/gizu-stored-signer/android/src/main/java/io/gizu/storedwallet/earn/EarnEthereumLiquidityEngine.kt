package io.gizu.storedwallet

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.*

internal sealed class LiquiditySigned {
  data class Permit(val value: NativeSignedFusionPermit) : LiquiditySigned()

  data class Order(val value: NativeSignedFusionOrder) : LiquiditySigned()

  data class Transaction(val value: NativeSignedEarnTransaction) : LiquiditySigned()
}

internal interface NativeLiquiditySigner : AutoCloseable {
  fun prepare(
    revision: ULong,
    state: NativeEthereumLiquidityState,
    fusion: NativeFusionQuoteBinding?,
    returning: NativeEarnQuoteBinding?,
    permit: NativeSignedFusionPermit?,
  ): String

  fun reviewHash(): String

  fun approve(revision: ULong, hash: String)

  fun sign(revision: ULong, state: NativeEthereumLiquidityState): LiquiditySigned
}

private class RustLiquiditySigner(p: String, entropy: ByteArray) : NativeLiquiditySigner {
  private val kind = JSONObject(p).getString("kind")
  private val permit =
    if (kind == "fusionUsdcPermit") EthereumFusionPermitOperation(p, entropy) else null
  private val order =
    if (kind == "fusionEthOrder") EthereumFusionOrderOperation(p, entropy) else null
  private val transaction =
    if (permit == null && order == null) EthereumLiquidityTransactionOperation(p, entropy) else null

  override fun prepare(
    revision: ULong,
    state: NativeEthereumLiquidityState,
    fusion: NativeFusionQuoteBinding?,
    returning: NativeEarnQuoteBinding?,
    permit: NativeSignedFusionPermit?,
  ) =
    this.permit?.prepare(revision, state, checkNotNull(fusion))
      ?: order?.prepare(revision, state, checkNotNull(fusion), permit)
      ?: checkNotNull(transaction).prepare(revision, state, fusion, returning)

  override fun reviewHash() =
    permit?.reviewHash() ?: order?.reviewHash() ?: checkNotNull(transaction).reviewHash()

  override fun approve(revision: ULong, hash: String) {
    when {
      permit != null -> permit.approve(revision, hash)
      order != null -> order.approve(revision, hash)
      else -> checkNotNull(transaction).approve(revision, hash)
    }
  }

  override fun sign(revision: ULong, state: NativeEthereumLiquidityState): LiquiditySigned =
    when {
      permit != null -> LiquiditySigned.Permit(permit.sign(revision, state))
      order != null -> LiquiditySigned.Order(order.sign(revision, state))
      else -> LiquiditySigned.Transaction(checkNotNull(transaction).sign(revision, state))
    }

  override fun close() {
    permit?.invalidate()
    permit?.close()
    order?.invalidate()
    order?.close()
    transaction?.invalidate()
    transaction?.close()
  }
}

internal fun storedFusionPermit(p: NativeSignedFusionPermit) =
  JSONObject()
    .put("owner", p.owner)
    .put("inputAtoms", p.inputAtoms)
    .put("nonce", p.nonce)
    .put("deadline", p.deadline.toLong())
    .put("signature", p.signature)
    .put("signatureHash", p.signatureHash)
    .put("permitData", p.permitData)

internal fun restoredFusionPermit(p: JSONObject) =
  NativeSignedFusionPermit(
    p.getString("owner"),
    p.getString("inputAtoms"),
    p.getString("nonce"),
    p.getLong("deadline").toULong(),
    p.getString("signature"),
    p.getString("signatureHash"),
    p.getString("permitData"),
  )

internal fun canonicalLiquidityProposal(
  owner: String,
  confidential: String,
  request: Map<String, Any?>,
): JSONObject {
  check(request.keys == setOf("walletId", "proposal"))
  val p = JSONObject(request["proposal"] as? Map<*, *> ?: error("Missing liquidity proposal"))
  check(
    p.getString("expectedFrom").equals(owner, true) &&
      p.getString("confidentialAccount").equals(confidential, true)
  )
  p.put("expectedFrom", owner).put("confidentialAccount", confidential)
  for (field in listOf("revision", "chainId", "deadline", "gasLimit", "nonce")) if (p.has(field)) {
    val n = p.get(field) as? Number ?: error("Invalid integer")
    val d = n.toDouble()
    check(d.isFinite() && d >= 0 && d <= 9007199254740991.0 && d == n.toLong().toDouble())
    p.put(field, n.toLong())
  }
  check(
    p.getLong("chainId") == 1L &&
      p.getString("kind") in
        setOf("fusionEthOrder", "fusionUsdcApproval", "returnUsdc", "returnEth")
  )
  if (p.getString("kind") in setOf("returnUsdc", "returnEth"))
    check(p.getString("refundOwner").equals(owner, true))
  return p
}

internal fun liquidityPermitProposal(
  p: JSONObject,
  state: NativeEthereumLiquidityState,
): JSONObject {
  val fields =
    listOf(
      "operationId",
      "revision",
      "chainId",
      "expectedFrom",
      "confidentialAccount",
      "quoteId",
      "inputAtoms",
      "minimumEthWei",
      "grossEthWei",
      "maximumResolverOverheadWei",
      "deadline",
    )
  return JSONObject().put("kind", "fusionUsdcPermit").put("nonce", state.permitNonce).also { out ->
    for (field in fields) out.put(field, p.get(field))
    if (p.has("cycleIndex")) out.put("cycleIndex", p.getInt("cycleIndex"))
    if (p.has("investmentSlot")) out.put("investmentSlot", p.getInt("investmentSlot"))
  }
}

internal data class LiquidityReview(
  val id: String,
  val revision: Int,
  val coreRevision: ULong,
  val hash: String,
  val text: String,
  val kind: String,
)

/**
 * Separate purpose-bound permit/order/transaction ceremonies. Every signed byte is saved before
 * networking.
 */
internal class EarnLiquidityEngine(
  private val store: WalletStore,
  val journal: EarnLiquidityJournal,
  private val rpc: TransferRpc,
  private val gateway: NativeFusionGateway = NativeFusionGateway(),
  private val signerFactory: (String, ByteArray) -> NativeLiquiditySigner = ::RustLiquiditySigner,
  private val stateReader: suspend (JSONObject) -> NativeEthereumLiquidityState =
    EarnLiquidityStateLoader(rpc)::load,
  private val fusionReader: suspend (JSONObject) -> NativeFusionQuote = gateway::binding,
  private val finalFusionReader:
    suspend (JSONObject, NativeSignedFusionPermit?, String?) -> NativeFusionQuote =
    gateway::executable,
  private val returnReader: suspend (JSONObject) -> NativeEarnRouteProof? =
    NativeEarnQuoteGateway(quotes = journal.quotes)::binding,
  private val reconcile: suspend () -> Unit = {
    reconcileEarnLiquidityOperations(journal, rpc, gateway)
  },
  private val baselineReader: suspend (JSONObject, () -> Unit) -> JSONObject =
    { proposal, authority ->
      readNativeSponsoredBaseline(
        nativeCycleReadAuth(store, authority),
        proposal.getString("confidentialAccount"),
      )
    },
) : AutoCloseable {
  private var signer: NativeLiquiditySigner? = null
  private var displayed: LiquidityReview? = null
  private var signing: JSONObject? = null
  private var fusion: NativeFusionQuote? = null
  private var returning: NativeEarnRouteProof? = null

  private fun walletCheck(record: WalletRecord) {
    requireEarnExecutionWallet(record, journal.walletId)
    check(record.journalId == journal.generation)
  }

  suspend fun create(request: Map<String, Any?>): JSONObject {
    reconcile()
    return store.load().use { record ->
      walletCheck(record)
      check(request["walletId"] == record.id)
      val p =
        attachInvestmentSlot(
          record,
          canonicalLiquidityProposal(
            cycleInvestmentAddress(record),
            cycleConfidential(record),
            request,
          ),
        )
      requireActiveEarnCycle(record, p)
      signerFactory(p.toString(), record.entropy).use {}
      journal.create(p)
    }
  }

  suspend fun prepare(id: String, revision: Int): LiquidityReview {
    check(journal.get(id).getInt("revision") == revision)
    reconcile()
    var op = journal.get(id)
    check(journal.public(op)["canResume"] == true)
    store.load().use {
      walletCheck(it)
      requireActiveEarnCycle(it, journal.get(id).getJSONObject("proposal"))
    }
    var p =
      JSONObject(
        op.optJSONObject("signingProposal")?.toString() ?: op.getJSONObject("proposal").toString()
      )
    if (op.has("raw") || op.has("signedOrder")) {
      check(op.getString("status") == "signed" && !op.optBoolean("conflict"))
      checkLiquidityRetry(op, stateReader(p))
      return LiquidityReview(
          id,
          op.getInt("revision"),
          p.getLong("revision").toULong(),
          op.getString("reviewHash"),
          "Resubmit exactly the encrypted saved authority. No new nonce, signature or repricing.\n${op.getString("review")}",
          "retry",
        )
        .also { displayed = it }
    }
    check(!op.optBoolean("cancelled"))
    var state = stateReader(p)
    returning = null
    fusion = null
    val kind = p.getString("kind")
    if (kind == "fusionEthOrder" && p.getString("fundingMode") == "permit" && !op.has("permit")) {
      fusion = fusionReader(p)
      p = liquidityPermitProposal(p, state)
    } else if (kind == "fusionEthOrder") {
      val permit = op.optJSONObject("permit")?.let(::restoredFusionPermit)
      if (!op.has("executableQuote")) {
        val quote =
          finalFusionReader(
            p,
            permit,
            op.optJSONObject("permitQuote")?.getString("requestedResolverGasPriceWei"),
          )
        check(quote.executionAvailable)
        val original = op.getJSONObject("proposal")
        check(
          quote.binding.operationId == id &&
            quote.binding.revision == original.getLong("revision").toULong() &&
            quote.binding.owner.equals(original.getString("expectedFrom"), true) &&
            quote.binding.confidentialAccount.equals(
              original.getString("confidentialAccount"),
              true,
            )
        )
        check(
          quote.binding.inputAtoms == original.getString("inputAtoms") &&
            quote.binding.minimumEthWei.toBigInteger() >=
              original.getString("minimumEthWei").toBigInteger() &&
            quote.binding.deadline == original.getLong("deadline").toULong()
        )
        p.put("quoteId", quote.binding.quoteId)
          .put("minimumEthWei", quote.binding.minimumEthWei)
          .put("grossEthWei", quote.binding.grossEthWei)
          .put("unsignedOrder", quote.unsignedOrder)
          .put("extension", quote.extension)
        val nonce = liquidityOrderNonce(quote.unsignedOrder)
        check(
          journal
            .all()
            .filter { it.getString("operationId") != id }
            .none { other ->
              other
                .optJSONObject("signingProposal")
                ?.optJSONObject("unsignedOrder")
                ?.let(::liquidityOrderNonce) == nonce ||
                other
                  .getJSONObject("proposal")
                  .optJSONObject("unsignedOrder")
                  ?.let(::liquidityOrderNonce) == nonce
            }
        )
        op =
          journal.update(id, op.getInt("revision")) {
            it.put("signingProposal", p).put("executableQuote", quote.raw)
          }
        state = stateReader(p)
      }
      val bindingRequest = JSONObject(p.toString())
      op
        .optJSONObject("executableQuote")
        ?.optString("recoveryEnvelope")
        ?.takeIf { it.isNotEmpty() }
        ?.let { bindingRequest.put("recoveryEnvelope", it) }
      fusion = fusionReader(bindingRequest)
      check(checkNotNull(fusion).executionAvailable)
    } else if (kind == "fusionUsdcApproval") fusion = fusionReader(p)
    else returning = returnReader(p)
    signer?.close()
    signer =
      store.load().use { record ->
        walletCheck(record)
        signerFactory(p.toString(), record.entropy)
      }
    val coreRevision = p.getLong("revision").toULong()
    val core = checkNotNull(signer)
    val permit = op.optJSONObject("permit")?.let(::restoredFusionPermit)
    val text =
      core.prepare(
        coreRevision,
        state,
        fusion?.binding,
        returning?.binding,
        if (p.getString("kind") == "fusionEthOrder") permit else null,
      )
    val hash = core.reviewHash()
    signing = p
    return LiquidityReview(id, op.getInt("revision"), coreRevision, hash, text, p.getString("kind"))
      .also { displayed = it }
  }

  suspend fun execute(review: LiquidityReview, authority: () -> Unit) {
    check(displayed == review && journal.get(review.id).getInt("revision") == review.revision)
    authority()
    store.load().use {
      walletCheck(it)
      requireActiveEarnCycle(it, journal.get(review.id).getJSONObject("proposal"))
    }
    currentCoroutineContext().ensureActive()
    val op = journal.get(review.id)
    if (review.kind == "retry") {
      val p = op.optJSONObject("signingProposal") ?: op.getJSONObject("proposal")
      checkLiquidityRetry(op, stateReader(p))
      authority()
      currentCoroutineContext().ensureActive()
      journal.update(review.id, review.revision) { it.put("status", "unknown") }
      authority()
      store.load().use {
        walletCheck(it)
        requireActiveEarnCycle(it, journal.get(review.id).getJSONObject("proposal"))
      }
      currentCoroutineContext().ensureActive()
      submitLiquiditySaved(op, rpc, gateway)
    } else {
      val p = checkNotNull(signing)
      val baseline =
        if (returning?.maximumCreditAtoms != null) {
          checkNotNull(returning?.recoveryEnvelope)
          requireSequentialSourceCredit(journal.all(), op, journal.walletId, journal.generation)
          baselineReader(p, authority).also { authority() }
        } else null
      val state = stateReader(p)
      val permit = op.optJSONObject("permit")?.let(::restoredFusionPermit)
      signer?.close()
      signer = null
      val core =
        store.load().use { record ->
          walletCheck(record)
          signerFactory(p.toString(), record.entropy)
        }
      core.use {
        val text =
          it.prepare(
            review.coreRevision,
            state,
            fusion?.binding,
            returning?.binding,
            if (review.kind == "fusionEthOrder") permit else null,
          )
        val hash = it.reviewHash()
        check(text == review.text && hash == review.hash)
        authority()
        currentCoroutineContext().ensureActive()
        check(journal.get(review.id).getInt("revision") == review.revision)
        it.approve(review.coreRevision, hash)
        val signed = it.sign(review.coreRevision, state)
        val updated =
          journal.update(review.id, review.revision) { target ->
            target
              .put("review", text)
              .put("reviewHash", hash)
              .put("stateBinding", liquidityStateBinding(state))
            if (baseline != null)
              target.getJSONObject("stateBinding").put("privateBaseline", baseline)
            if (returning != null)
              target
                .getJSONObject("stateBinding")
                .put("routeProof", storedEarnRouteProof(checkNotNull(returning)))
            when (signed) {
              is LiquiditySigned.Permit -> {
                check(!target.has("permit"))
                target
                  .put("permit", storedFusionPermit(signed.value))
                  .put("permitQuote", checkNotNull(fusion).raw)
                  .put("status", "permitSaved")
              }
              is LiquiditySigned.Order -> {
                check(
                  !target.has("signedOrder") &&
                    signed.value.operationId == review.id &&
                    signed.value.revision == review.coreRevision &&
                    signed.value.reviewHash == hash
                )
                val order =
                  JSONObject()
                    .put("operationId", signed.value.operationId)
                    .put("revision", signed.value.revision.toLong())
                    .put("quoteId", signed.value.quoteId)
                    .put("order", JSONObject(signed.value.unsignedOrder))
                    .put("extension", signed.value.extension)
                    .put("signature", signed.value.signature)
                checkNotNull(fusion)
                  .raw
                  .optString("recoveryEnvelope")
                  .takeIf { it.isNotEmpty() }
                  ?.let { order.put("recoveryEnvelope", it) }
                target
                  .put("signedOrder", order)
                  .put("orderHash", signed.value.orderHash)
                  .put("signingProposal", p)
                  .put("status", "unknown")
              }
              is LiquiditySigned.Transaction -> {
                check(
                  !target.has("raw") &&
                    signed.value.operationId == review.id &&
                    signed.value.revision == review.coreRevision &&
                    signed.value.reviewHash == hash
                )
                target
                  .put("raw", signed.value.rawTransaction)
                  .put("transactionHash", signed.value.transactionHash)
                  .put("signingProposal", p)
                  .put("status", "unknown")
              }
            }
          }
        if (signed !is LiquiditySigned.Permit) {
          authority()
          store.load().use {
            walletCheck(it)
            requireActiveEarnCycle(it, journal.get(review.id).getJSONObject("proposal"))
          }
          currentCoroutineContext().ensureActive()
          submitLiquiditySaved(updated, rpc, gateway)
        }
      }
    }
    if (review.kind != "fusionUsdcPermit") reconcile()
    displayed = null
    signing = null
    fusion = null
    returning = null
  }

  override fun close() {
    signer?.close()
    signer = null
    displayed = null
    signing = null
    fusion = null
    returning = null
  }
}

internal fun storedEarnRouteProof(q: NativeEarnRouteProof) =
  JSONObject()
    .put("operationId", q.binding.operationId)
    .put("revision", q.binding.revision.toLong())
    .put("recipient", q.binding.recipient)
    .put("confidentialAccount", q.binding.confidentialAccount)
    .put("refundOwner", q.binding.refundOwner)
    .put("amountAtoms", q.binding.amountAtoms)
    .put("quoteId", q.binding.quoteId)
    .put("expiresAt", q.binding.expiresAt.toLong())
    .put("minimumCreditAtoms", q.minimumCreditAtoms)
    .put("maximumCreditAtoms", q.maximumCreditAtoms)
    .put("originAsset", q.originAsset)
    .put("authenticatedBodyHash", q.binding.authenticatedBodyHash)
    .put("recoveryEnvelope", q.recoveryEnvelope)

internal suspend fun submitLiquiditySaved(
  op: JSONObject,
  rpc: TransferRpc,
  gateway: NativeFusionGateway,
) {
  if (op.has("raw"))
    check(
      rpc
        .text("eth_sendRawTransaction", op.getString("raw"))
        .equals(op.getString("transactionHash"), true)
    )
  else gateway.submit(op.getJSONObject("signedOrder"), op.getString("orderHash"))
}

internal fun checkLiquidityRetry(op: JSONObject, state: NativeEthereumLiquidityState) {
  val p = op.optJSONObject("signingProposal") ?: op.getJSONObject("proposal")
  check(p.getLong("deadline") > System.currentTimeMillis() / 1000 && !op.optBoolean("conflict"))
  val fresh = liquidityStateBinding(state)
  val saved = op.getJSONObject("stateBinding")
  for (field in
    listOf(
      "senderCode",
      "recipientCode",
      "usdcCodeHash",
      "wethCodeHash",
      "routerCodeHash",
      "settlementCodeHash",
      "feeReceiverCodeHash",
      "vaultCodeHash",
    )) check(saved.getString(field).equals(fresh.getString(field), true))
  if (op.has("signedOrder")) {
    check(
      state.usdcBalanceAtoms.toBigInteger() >= p.getString("inputAtoms").toBigInteger() &&
        state.fusionNonceSlot == saved.getString("fusionNonceSlot") &&
        !state.fusionInvalidatorWord
          .toBigInteger()
          .testBit(
            liquidityOrderNonce(p.getJSONObject("unsignedOrder")).and(255.toBigInteger()).toInt()
          )
    )
    val permit = op.optJSONObject("permit")
    if (permit != null)
      check(
        state.permitNonce == permit.getString("nonce") ||
          state.fusionAllowanceAtoms.toBigInteger() >= p.getString("inputAtoms").toBigInteger()
      )
    else
      check(state.fusionAllowanceAtoms.toBigInteger() >= p.getString("inputAtoms").toBigInteger())
  } else {
    check(state.nonce.toString() == p.getLong("nonce").toString())
    if (p.getString("kind") in setOf("returnUsdc", "returnEth"))
      check(state.shares == "0" && state.wethBalanceAtoms == "0")
    if (p.getString("kind") == "returnEth") check(state.usdcBalanceAtoms == "0")
    val fee = p.getString("maxFeePerGasWei").toBigInteger()
    check(
      state.baseFeeWei.toBigInteger() + p.getString("priorityFeePerGasWei").toBigInteger() <= fee
    )
    val cost = p.getLong("gasLimit").toBigInteger() * fee
    val value =
      if (p.getString("kind") == "returnEth") p.getString("amountAtoms").toBigInteger()
      else java.math.BigInteger.ZERO
    check(
      state.nativeBalanceWei.toBigInteger() >=
        cost + value + p.getString("withdrawalReserveWei").toBigInteger()
    )
    if (p.getString("kind") == "returnUsdc")
      check(state.usdcBalanceAtoms.toBigInteger() >= p.getString("amountAtoms").toBigInteger())
    check(state.recipientAssetBalanceAtoms == "0")
  }
}
