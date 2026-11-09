package io.gizu.storedwallet

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.*

private val sponsoredFields =
  setOf(
    "kind",
    "operationId",
    "revision",
    "chainId",
    "profileChainId",
    "expectedFrom",
    "token",
    "amountAtoms",
    "nonce",
    "deadline",
    "maximumTokenFeeAtoms",
    "budgetAtoms",
    "withdrawalReserveAtoms",
    "slippageBps",
  )
private val sponsoredOptionalFields =
  setOf(
    "vault",
    "router",
    "recipient",
    "quoteId",
    "confidentialAccount",
    "refundOwner",
    "cycleIndex",
    "investmentSlot",
    "sourceAccountIndex",
    "fundingBatchId",
    "fundingBatchSize",
  )

internal fun sponsoredPublicProposal(
  walletId: String,
  owner: String,
  profile: Int,
  request: Map<String, Any?>,
): Pair<JSONObject, JSONObject> {
  check(
    request.keys == setOf("walletId", "proposal", "userOperation") &&
      request["walletId"] == walletId
  )
  val p = JSONObject(request["proposal"] as? Map<*, *> ?: error("Missing proposal"))
  val keys = p.keys().asSequence().toSet()
  check(
    keys.containsAll(sponsoredFields) &&
      keys.all { it in sponsoredFields + sponsoredOptionalFields }
  )
  check(p.getString("expectedFrom").equals(owner, true))
  p.put("expectedFrom", owner)
  for (field in listOf("revision", "chainId", "profileChainId", "deadline", "slippageBps")) {
    val n = p.get(field) as? Number ?: error("Invalid integer")
    val d = n.toDouble()
    check(d.isFinite() && d >= 0 && d <= 9007199254740991.0 && d == n.toLong().toDouble())
    p.put(field, n.toLong())
  }
  check(p.getLong("profileChainId") == profile.toLong())
  if (p.getString("kind") == "sourceFunding")
    check(p.getString("withdrawalReserveAtoms") == "10000")
  val op = JSONObject(request["userOperation"] as? Map<*, *> ?: error("Missing user operation"))
  check(!op.has("eip7702Auth") && (!op.has("signature") || op.getString("signature") == "0x"))
  op.put("signature", "0x")
  return p to op
}

internal fun storedEarnAuthorization(a: NativeSignedEarnAuthorization): JSONObject =
  JSONObject()
    .put("chainId", a.chainId.toLong())
    .put("address", a.address)
    .put("nonce", a.nonce.toLong())
    .put("from", a.from)
    .put("r", a.r)
    .put("s", a.s)
    .put("yParity", a.yParity.toInt())
    .put("signatureHash", a.signatureHash)

internal fun restoredEarnAuthorization(a: JSONObject) =
  NativeSignedEarnAuthorization(
    a.getLong("chainId").toULong(),
    a.getString("address"),
    a.getLong("nonce").toULong(),
    a.getString("from"),
    a.getString("r"),
    a.getString("s"),
    a.getInt("yParity").toUInt(),
    a.getString("signatureHash"),
  )

internal fun sponsoredStateBinding(s: NativeSponsoredState): JSONObject =
  JSONObject()
    .put("chainId", s.chainId.toLong())
    .put("owner", s.owner)
    .put("entryPointNonce", s.entryPointNonce)
    .put("transactionNonce", s.transactionNonce.toString())
    .put("tokenBalanceAtoms", s.tokenBalanceAtoms)
    .put("shares", s.shares)
    .put("senderCode", s.senderCode)
    .put("tokenCodeHash", s.tokenCodeHash)
    .put("paymasterCodeHash", s.paymasterCodeHash)
    .put("implementationCodeHash", s.implementationCodeHash)
    .put("entryPointCodeHash", s.entryPointCodeHash)
    .put("vaultCodeHash", s.vaultCodeHash)
    .put("routerCodeHash", s.routerCodeHash)
    .put("recipientCode", s.recipientCode)
    .put("vaultAsset", s.vaultAsset)

internal interface NativeSponsoredSigner : AutoCloseable {
  fun prepare(
    revision: ULong,
    userOperation: String,
    state: NativeSponsoredState,
    quote: NativeEarnQuoteBinding?,
    authorization: NativeSignedEarnAuthorization?,
  ): String

  fun reviewHash(): String

  fun approve(revision: ULong, hash: String)

  fun sign(revision: ULong, state: NativeSponsoredState): NativeSignedEarnUserOperation
}

private class RustSponsoredSigner(p: String, entropy: ByteArray) : NativeSponsoredSigner {
  private val core = SponsoredEarnOperation(p, entropy)

  override fun prepare(
    revision: ULong,
    userOperation: String,
    state: NativeSponsoredState,
    quote: NativeEarnQuoteBinding?,
    authorization: NativeSignedEarnAuthorization?,
  ) = core.prepare(revision, userOperation, state, quote, authorization)

  override fun reviewHash() = core.reviewHash()

  override fun approve(revision: ULong, hash: String) = core.approve(revision, hash)

  override fun sign(revision: ULong, state: NativeSponsoredState) = core.sign(revision, state)

  override fun close() {
    core.invalidate()
    core.close()
  }
}

internal data class SponsoredReview(
  val id: String,
  val revision: Int,
  val coreRevision: ULong,
  val hash: String,
  val text: String,
  val kind: String,
)

/** Native-only ceremony engine: 7702 approval is distinct from exact UserOp approval. */
internal class EarnSponsoredEngine(
  private val store: WalletStore,
  val journal: EarnSponsoredJournal,
  private val chainRpc: TransferRpc,
  private val bundler: TransferRpc,
  private val signerFactory: (String, ByteArray) -> NativeSponsoredSigner = ::RustSponsoredSigner,
  private val stateReader: suspend (JSONObject) -> NativeSponsoredState =
    EarnSponsoredStateLoader(chainRpc)::load,
  private val quoteReader: suspend (JSONObject) -> NativeEarnRouteProof? =
    NativeEarnQuoteGateway(quotes = journal.quotes)::binding,
  private val eventTopic: (String) -> String = ::earnEventTopic,
  private val reservations: FundingReservations? = null,
  private val sourceReplanner: suspend (WalletRecord, JSONObject) -> Pair<JSONObject, JSONObject> =
    EarnSourceReplanner(journal.quotes)::replan,
  private val baselineReader: suspend (JSONObject, () -> Unit) -> JSONObject =
    { proposal, authority ->
      readNativeSponsoredBaseline(
        nativeCycleReadAuth(store, authority),
        proposal.getString("confidentialAccount"),
      )
    },
) : AutoCloseable {
  private var signer: NativeSponsoredSigner? = null
  private var delegation: EarnDelegationOperation? = null
  private var displayed: SponsoredReview? = null
  private var preparedUserOp: String? = null
  private var preparedQuote: NativeEarnRouteProof? = null

  private fun walletCheck(record: WalletRecord, p: JSONObject? = null) {
    requireSponsoredWallet(record, journal.walletId)
    check(record.journalId == journal.generation)
    if (p != null) {
      check(p.getLong("profileChainId") == record.earnChain.toLong())
      requireActiveEarnCycle(record, p)
    }
  }

  suspend fun create(request: Map<String, Any?>): JSONObject {
    val requestedChain =
      ((request["proposal"] as? Map<*, *>)?.get("chainId") as? Number)?.toInt()
        ?: error("Missing chain")
    reconcileEarnSponsoredOperations(
      journal,
      chainRpc,
      bundler,
      eventTopic,
      stateReader,
      requestedChain,
      journal
        .all()
        .filter { it.getString("status") !in terminalSteps }
        .map { it.getString("operationId") }
        .toSet(),
    )
    return store.load().use { record ->
      walletCheck(record)
      val incoming = JSONObject(request["proposal"] as? Map<*, *> ?: error("Missing proposal"))
      val chain = incoming.getLong("chainId")
      val owner =
        if (chain == 143L) publicAccountAddress(record, incoming.optInt("sourceAccountIndex", 0))
        else {
          check(chain == 4663L && record.earnChain == 4663)
          cycleInvestmentAddress(record)
        }
      val (p, op) = sponsoredPublicProposal(record.id, owner, record.earnChain, request)
      if (chain == 143L) check(!p.has("investmentSlot")) else attachInvestmentSlot(record, p)
      requireActiveEarnCycle(record, p)
      if (p.getString("kind") in setOf("sourceFunding", "hoodTokenReturn")) {
        check(p.getString("confidentialAccount").equals(cycleConfidential(record), true))
        check(p.getString("refundOwner").equals(owner, true))
      }
      signerFactory(p.toString(), record.entropy).use {}
      val existing =
        journal.all().singleOrNull { it.getString("operationId") == p.getString("operationId") }
      if (existing != null) {
        check(
          nativeJsonEqual(existing.getJSONObject("proposal"), p) &&
            nativeJsonEqual(existing.getJSONObject("unsignedUserOperation"), op)
        ) {
          "Saved funding terms changed; resume the original operation"
        }
        return@use existing
      }
      if (p.getString("kind") == "sourceFunding") {
        val prior =
          currentCycleRows(record, journal.all()).filter {
            it.getJSONObject("proposal").getString("kind") == "sourceFunding" &&
              it.sponsoredSpendSaved()
          }
        check(
          prior.all {
            p.has("fundingBatchId") &&
              it.getJSONObject("proposal").optString("fundingBatchId") ==
                p.getString("fundingBatchId")
          }
        ) {
          "Prepare a fresh investment before funding again"
        }
        if (p.has("fundingBatchId")) {
          val batch = reservations?.batch(p.getString("fundingBatchId"))
          check(batch != null) { "Funding reservation is missing" }
          if (batch != null)
            check(
              batch.getInt("cycleIndex") == record.earnCycleIndex &&
                batch.getString("feature") == "earn" &&
                batch.getJSONArray("legs").length() == p.getInt("fundingBatchSize")
            )
          reservations?.bind(
            p.getString("fundingBatchId"),
            owner,
            p.getString("operationId"),
            p.getString("budgetAtoms"),
          )
        } else {
          val fresh = stateReader(p)
          reservations?.reserveOperation(
            p.getString("operationId"),
            "earn",
            record.earnCycleIndex,
            owner,
            p.optInt("sourceAccountIndex", 0),
            p.getString("budgetAtoms"),
            fresh.tokenBalanceAtoms,
          )
        }
      }
      journal.create(p, op).also {
        if (p.optInt("fundingBatchSize", 0) == 1)
          reservations?.commitBatch(p.getString("fundingBatchId"))
      }
    }
  }

  private fun delegationProposal(p: JSONObject, state: NativeSponsoredState) =
    JSONObject()
      .put("kind", if (state.chainId == 143uL) "authorizeSource7702" else "authorizeHood7702")
      .put("operationId", p.getString("operationId"))
      .put("revision", p.getLong("revision"))
      .put("chainId", state.chainId.toLong())
      .put("expectedFrom", state.owner)
      .put("nonce", state.transactionNonce.toLong())
      .put("deadline", p.getLong("deadline"))
      .put("cycleIndex", p.optInt("cycleIndex", 0))
      .also {
        if (state.chainId == 143uL) it.put("sourceAccountIndex", p.optInt("sourceAccountIndex", 0))
        else if (p.has("investmentSlot")) it.put("investmentSlot", p.getInt("investmentSlot"))
      }

  suspend fun prepare(id: String, revision: Int): SponsoredReview {
    check(journal.get(id).getInt("revision") == revision)
    val requestedChain = journal.get(id).getJSONObject("proposal").getInt("chainId")
    reconcileEarnSponsoredOperations(
      journal,
      chainRpc,
      bundler,
      eventTopic,
      stateReader,
      requestedChain,
      setOf(id),
    )
    var op = journal.get(id)
    var p = op.getJSONObject("proposal")
    store.load().use { walletCheck(it, p) }
    if (
      p.getString("kind") == "sourceFunding" &&
        !op.sponsoredSpendSaved() &&
        !op.optBoolean("cancelled") &&
        p.getLong("deadline") * 1000 <= System.currentTimeMillis() + 15000
    ) {
      val oldRevision = op.getInt("revision")
      val refreshed =
        store.load().use { record ->
          walletCheck(record, p)
          sourceReplanner(record, op)
        }
      op = journal.refreshUnsignedSource(id, oldRevision, refreshed.first, refreshed.second)
      p = op.getJSONObject("proposal")
    }
    check(journal.public(op)["canResume"] == true)
    reservations?.assertActive(id)
    val state = stateReader(p)
    if (p.getString("kind") == "hoodTokenReturn") check(state.shares == "0")
    val coreRevision = p.getLong("revision").toULong()
    if (op.has("signedUserOperation")) {
      check(op.getString("status") == "signed" && !op.optBoolean("conflict"))
      checkSponsoredRetry(op, state)
      return SponsoredReview(
          id,
          op.getInt("revision"),
          coreRevision,
          op.getString("reviewHash"),
          "Rebroadcast the exact saved sponsored operation and delegation. No new nonce, authorization or signature.\n${op.getString("review")}\nSaved UserOperation hash ${op.getString("userOperationHash")}",
          "retry",
        )
        .also { displayed = it }
    }
    check(!op.optBoolean("cancelled"))
    if (state.senderCode == "0x" && !op.has("authorization")) {
      // Confirm configured infrastructure and native route binding before creating durable 7702
      // authority.
      val supported = bundler.call("eth_supportedEntryPoints", JSONArray()) as JSONArray
      check(
        (0 until supported.length()).any { supported.getString(it).equals(EARN_ENTRY_POINT, true) }
      )
      preparedQuote = quoteReader(p)
      val required =
        p.getString("amountAtoms").toBigInteger() +
          p.getString("maximumTokenFeeAtoms").toBigInteger() +
          p.getString("withdrawalReserveAtoms").toBigInteger()
      check(
        state.tokenBalanceAtoms.toBigInteger() >=
          if (p.getString("kind") == "hoodRedeemAll")
            required - p.getString("amountAtoms").toBigInteger()
          else required
      )

      delegation?.invalidate()
      delegation?.close()
      delegation =
        store.load().use { record ->
          walletCheck(record, p)
          EarnDelegationOperation(delegationProposal(p, state).toString(), record.entropy)
        }
      val core = checkNotNull(delegation)
      val text = core.prepare(coreRevision, state)
      val hash = core.reviewHash()
      return SponsoredReview(id, op.getInt("revision"), coreRevision, hash, text, "delegation")
        .also { displayed = it }
    }
    val authorization = op.optJSONObject("authorization")?.let(::restoredEarnAuthorization)
    if (authorization != null)
      check(state.senderCode == "0x" && state.transactionNonce == authorization.nonce)
    val unsigned = JSONObject(op.getJSONObject("unsignedUserOperation").toString())
    if (authorization != null) unsigned.put("eip7702Auth", rpcEarnAuthorization(authorization))
    val routeProof = quoteReader(p)
    val quote = routeProof?.binding
    // Validate public calldata and its authenticated route before sending native auth to a
    // provider.
    val forValidation = JSONObject(unsigned.toString())
    forValidation.remove("eip7702Auth")
    store.load().use { record ->
      walletCheck(record, p)
      signerFactory(p.toString(), record.entropy).use {
        it.prepare(coreRevision, forValidation.toString(), state, quote, authorization)
      }
    }
    val pm =
      bundler.call(
        "pm_getPaymasterData",
        JSONArray()
          .put(unsigned)
          .put(EARN_ENTRY_POINT)
          .put("0x" + state.chainId.toString(16))
          .put(JSONObject().put("token", p.getString("token"))),
      ) as JSONObject
    check(
      pm.keys().asSequence().all {
        it in
          setOf(
            "paymaster",
            "paymasterData",
            "paymasterPostOpGasLimit",
            "paymasterVerificationGasLimit",
            "isFinal",
          )
      }
    )
    check(!pm.has("isFinal") || pm.getBoolean("isFinal"))
    unsigned.remove("eip7702Auth")
    unsigned.put("signature", "0x")
    for (field in
      listOf(
        "paymaster",
        "paymasterData",
        "paymasterPostOpGasLimit",
        "paymasterVerificationGasLimit",
      )) unsigned.put(field, pm.getString(field))
    check(unsigned.getString("paymaster").equals(EARN_PAYMASTER, true))
    signer?.close()
    signer =
      store.load().use { record ->
        walletCheck(record, p)
        signerFactory(p.toString(), record.entropy)
      }
    val core = checkNotNull(signer)
    val text = core.prepare(coreRevision, unsigned.toString(), state, quote, authorization)
    val hash = core.reviewHash()
    preparedUserOp = unsigned.toString()
    preparedQuote = routeProof
    return SponsoredReview(id, op.getInt("revision"), coreRevision, hash, text, "operation").also {
      displayed = it
    }
  }

  suspend fun execute(review: SponsoredReview, authority: () -> Unit) =
    executeBounded(review, authority) {}

  /** Additional journey limits apply to the same freshly reconstructed native state. */
  suspend fun executeBounded(
    review: SponsoredReview,
    authority: () -> Unit,
    stateGuard: (NativeSponsoredState) -> Unit,
  ) {
    check(displayed == review && journal.get(review.id).getInt("revision") == review.revision)
    authority()
    currentCoroutineContext().ensureActive()
    reservations?.assertActive(review.id)
    val op = journal.get(review.id)
    val p = op.getJSONObject("proposal")
    store.load().use { walletCheck(it, p) }
    // Private reads can take several network round trips. Finish them before loading
    // the final public signing state; Rust retains its 15-second freshness bound.
    val route = preparedQuote
    val baseline =
      if (review.kind == "operation" && route?.maximumCreditAtoms != null) {
        checkNotNull(route.recoveryEnvelope)
        requireSequentialSourceCredit(journal.all(), op, journal.walletId, journal.generation)
        baselineReader(p, authority).also {
          check(
            it.getString("confidentialAddress").equals(p.getString("confidentialAccount"), true)
          )
          check(it.getBoolean("authenticated") && !it.getBoolean("operationScoped"))
          authority()
        }
      } else null
    val state = stateReader(p)
    stateGuard(state)
    if (p.getString("kind") == "hoodTokenReturn") check(state.shares == "0")
    authority()
    currentCoroutineContext().ensureActive()
    check(journal.get(review.id).getInt("revision") == review.revision)
    if (review.kind == "retry") {
      checkSponsoredRetry(op, state)
      journal.update(review.id, review.revision) { it.put("status", "unknown") }
      authority()
      currentCoroutineContext().ensureActive()
      reservations?.markSigned(review.id)
      val returned =
        bundler.text(
          "eth_sendUserOperation",
          JSONObject(op.getString("signedUserOperation")),
          EARN_ENTRY_POINT,
        )
      check(returned.equals(op.getString("userOperationHash"), true))
    } else if (review.kind == "delegation") {
      // Fresh reconstruction must reproduce every displayed byte and the passkey-bound hash.
      delegation?.invalidate()
      delegation?.close()
      delegation = null
      val core =
        store.load().use { record ->
          walletCheck(record, p)
          EarnDelegationOperation(delegationProposal(p, state).toString(), record.entropy)
        }
      core.use {
        val text = it.prepare(review.coreRevision, state)
        val hash = it.reviewHash()
        check(text == review.text && hash == review.hash)
        authority()
        currentCoroutineContext().ensureActive()
        it.approve(review.coreRevision, hash)
        val signed = it.sign(review.coreRevision, state)
        journal.saveAuthorization(
          review.id,
          review.revision,
          storedEarnAuthorization(signed),
          text,
          hash,
        )
      }
    } else {
      check(review.kind == "operation")
      val userOp = checkNotNull(preparedUserOp)
      val routeProof = preparedQuote
      val quote = routeProof?.binding
      val auth = op.optJSONObject("authorization")?.let(::restoredEarnAuthorization)
      signer?.close()
      signer = null
      val core =
        store.load().use { record ->
          walletCheck(record, p)
          signerFactory(p.toString(), record.entropy)
        }
      core.use {
        val text = it.prepare(review.coreRevision, userOp, state, quote, auth)
        val hash = it.reviewHash()
        check(text == review.text && hash == review.hash)
        authority()
        currentCoroutineContext().ensureActive()
        it.approve(review.coreRevision, hash)
        val signed =
          journal.withSpendSigning(review.id, review.revision) {
            reservations?.markSigned(review.id)
            val signed = it.sign(review.coreRevision, state)
            check(
              signed.operationId == review.id &&
                signed.revision == review.coreRevision &&
                signed.reviewHash == review.hash
            )
            val binding = sponsoredStateBinding(state)
            if (baseline != null) binding.put("privateBaseline", baseline)
            if (routeProof != null)
              binding.put(
                "routeProof",
                JSONObject()
                  .put("operationId", routeProof.binding.operationId)
                  .put("revision", routeProof.binding.revision.toLong())
                  .put("recipient", routeProof.binding.recipient)
                  .put("confidentialAccount", routeProof.binding.confidentialAccount)
                  .put("refundOwner", routeProof.binding.refundOwner)
                  .put("amountAtoms", routeProof.binding.amountAtoms)
                  .put("quoteId", routeProof.binding.quoteId)
                  .put("expiresAt", routeProof.binding.expiresAt.toLong())
                  .put("feePolicy", routeProof.binding.feePolicy?.let(::JSONObject))
                  .put("minimumCreditAtoms", routeProof.minimumCreditAtoms)
                  .put("maximumCreditAtoms", routeProof.maximumCreditAtoms)
                  .put("originAsset", routeProof.originAsset)
                  .put("authenticatedBodyHash", routeProof.binding.authenticatedBodyHash)
                  .put("recoveryEnvelope", routeProof.recoveryEnvelope),
              )
            journal.saveSigned(
              review.id,
              review.revision,
              signed.userOperationHash,
              signed.rpcUserOperation,
              text,
              hash,
              binding,
            )
            reservations?.markSigned(review.id)
            signed
          }
        authority()
        store.load().use { record -> walletCheck(record, p) }
        currentCoroutineContext().ensureActive()
        reservations?.markSigned(review.id)
        val returned =
          bundler.text(
            "eth_sendUserOperation",
            JSONObject(signed.rpcUserOperation),
            EARN_ENTRY_POINT,
          )
        check(returned.equals(signed.userOperationHash, true))
      }
    }
    if (review.kind != "delegation")
      reconcileEarnSponsoredOperations(
        journal,
        chainRpc,
        bundler,
        eventTopic,
        stateReader,
        p.getInt("chainId"),
        setOf(review.id),
      )
    releaseConfirmedReservations()
    displayed = null
    preparedUserOp = null
    preparedQuote = null
  }

  fun releaseConfirmedReservations() {
    journal
      .all()
      .filter {
        it.getJSONObject("proposal").getString("kind") == "sourceFunding" &&
          it.getString("status") in setOf("finalized", "reverted") &&
          it.has("transactionHash")
      }
      .forEach { reservations?.complete(it.getString("operationId")) }
  }

  override fun close() {
    signer?.close()
    signer = null
    delegation?.invalidate()
    delegation?.close()
    delegation = null
    displayed = null
    preparedUserOp = null
    preparedQuote = null
  }
}

internal fun rpcEarnAuthorization(a: NativeSignedEarnAuthorization): JSONObject =
  JSONObject()
    .put("chainId", "0x" + a.chainId.toString(16))
    .put("address", a.address)
    .put("nonce", "0x" + a.nonce.toString(16))
    .put("r", a.r)
    .put("s", a.s)
    .put("yParity", "0x" + a.yParity.toString(16).padStart(2, '0'))

internal fun checkSponsoredRetry(op: JSONObject, state: NativeSponsoredState) {
  val saved = op.getJSONObject("stateBinding")
  val fresh = sponsoredStateBinding(state)
  for (field in
    listOf(
      "chainId",
      "owner",
      "entryPointNonce",
      "transactionNonce",
      "senderCode",
      "tokenCodeHash",
      "paymasterCodeHash",
      "implementationCodeHash",
      "entryPointCodeHash",
      "vaultCodeHash",
      "routerCodeHash",
      "recipientCode",
      "vaultAsset",
    )) check(saved.get(field).toString() == fresh.get(field).toString()) {
    "Saved operation native state changed"
  }
  val p = op.getJSONObject("proposal")
  val signed = JSONObject(op.getString("signedUserOperation"))
  check(
    !op.optBoolean("conflict") && quantity(state.entryPointNonce) == quantity(p.getString("nonce"))
  )
  check(p.getLong("deadline") > System.currentTimeMillis() / 1000) {
    "Saved sponsored deadline expired"
  }
  check(
    state.baseFeeWei.toBigInteger() + quantity(signed.getString("maxPriorityFeePerGas")) <=
      quantity(signed.getString("maxFeePerGas"))
  )
  val required =
    p.getString("maximumTokenFeeAtoms").toBigInteger() +
      p.getString("withdrawalReserveAtoms").toBigInteger() +
      if (p.getString("kind") == "hoodRedeemAll") java.math.BigInteger.ZERO
      else p.getString("amountAtoms").toBigInteger()
  check(state.tokenBalanceAtoms.toBigInteger() >= required) {
    "Saved sponsored fee and reserve no longer funded"
  }
  if (p.getString("kind") == "hoodRedeemAll")
  // Morpho Vault V2's maxRedeem view always returns zero. Retry only the
  // originally signed full share balance, with every binding above unchanged.
  check(state.shares == p.getString("amountAtoms"))
  if (p.getString("kind") == "hoodTokenReturn") check(state.shares == "0")
}

internal fun nativeJsonEqual(a: Any?, b: Any?): Boolean =
  when {
    a is JSONObject && b is JSONObject ->
      a.keys().asSequence().toSet() == b.keys().asSequence().toSet() &&
        a.keys().asSequence().all { nativeJsonEqual(a.get(it), b.get(it)) }
    a is JSONArray && b is JSONArray ->
      a.length() == b.length() && (0 until a.length()).all { nativeJsonEqual(a.get(it), b.get(it)) }
    a is Number && b is Number ->
      a.toString().toBigDecimal().compareTo(b.toString().toBigDecimal()) == 0
    else -> a == b
  }

/** A dedicated cycle account has at most one uncredited incoming route at a time. */
internal fun requireSequentialSourceCredit(
  rows: List<JSONObject>,
  current: JSONObject,
  walletId: String? = null,
  generation: String? = null,
) {
  val p = current.getJSONObject("proposal")
  val owner = p.getString("confidentialAccount")
  for (other in rows) {
    if (other.getString("operationId") == current.getString("operationId")) continue
    val proposal = other.getJSONObject("proposal")
    if (
      proposal.optString("kind") !in
        setOf("sourceFunding", "hoodTokenReturn", "returnUsdc", "returnEth")
    )
      continue
    if (!proposal.optString("confidentialAccount").equals(owner, true)) continue
    if (other.sponsoredSpendSaved() && other.getString("status") != "reverted")
      check(
        other.getString("status") == "finalized" &&
          (other.optJSONObject("settlement")?.optString("status") == "credited" ||
            (other.has("minimumReturnReceipt") &&
              savedMinimumReturnReceipt(other, checkNotNull(walletId), checkNotNull(generation)) !=
                null))
      ) {
        "Previous source credit must settle first"
      }
  }
}
