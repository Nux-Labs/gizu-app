package io.gizu.storedwallet

import java.math.BigInteger
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONObject

internal data class EarnSourceReplanState(
  val owner: String,
  val entryPointNonce: String,
  val tokenBalanceAtoms: String,
  val transactionNonce: ULong,
  val senderCode: String,
)

/**
 * Refreshes only unsigned terms. The existing native engine still owns review, final sponsorship,
 * delegation authority, signing and durable journal updates.
 */
internal class EarnSourceReplanner(
  private val quotes: EarnQuoteJournal?,
  private val feeReader: suspend (JSONObject) -> JSONObject = { request ->
    JSONObject(
      NativeRpcTransport(EARN_NATIVE_BACKEND.removeSuffix("/native") + "/monad/funding-plan")
        .post(request.toString())
    )
  },
  private val quoteCreator: suspend (Int, String, Int, String, String, String) -> Map<String, Any> =
    { profile, id, revision, owner, confidential, amount ->
      NativeEarnQuoteGateway(quotes = quotes)
        .create(profile, id, revision, owner, confidential, amount, false)
    },
  private val stateReader: suspend (JSONObject) -> EarnSourceReplanState = { p ->
    EarnSponsoredStateLoader(EarnSponsoredChainRpc(143)).load(p).let {
      EarnSourceReplanState(
        it.owner,
        it.entryPointNonce,
        it.tokenBalanceAtoms,
        it.transactionNonce,
        it.senderCode,
      )
    }
  },
  private val sourceIdentity: (WalletRecord, Int) -> String = ::publicAccountAddress,
  private val confidentialIdentity: (WalletRecord) -> String = ::cycleConfidential,
  private val now: () -> Long = System::currentTimeMillis,
) {
  suspend fun replan(record: WalletRecord, op: JSONObject): Pair<JSONObject, JSONObject> {
    requireSponsoredWallet(record, op.getString("walletId"))
    check(
      !op.sponsoredSpendSaved() &&
        !op.optBoolean("signingPending") &&
        !op.optBoolean("spendSigningPending") &&
        !op.optBoolean("signingAuthorizationPending")
    ) {
      "Signed source funding must retain its exact saved bytes"
    }
    val old = op.getJSONObject("proposal")
    check(
      old.getString("kind") == "sourceFunding" &&
        old.getInt("chainId") == 143 &&
        old.getInt("profileChainId") == record.earnChain &&
        old.getString("operationId") == op.getString("operationId")
    )
    requireActiveEarnCycle(record, old)
    val owner = sourceIdentity(record, old.optInt("sourceAccountIndex", 0))
    val confidential = confidentialIdentity(record)
    check(
      old.getString("expectedFrom").equals(owner, true) &&
        old.getString("refundOwner").equals(owner, true) &&
        old.getString("confidentialAccount").equals(confidential, true) &&
        old.getString("token").equals(MONAD_EARN_USDC, true)
    )
    check(old.getString("withdrawalReserveAtoms") == "10000")
    val budget = sourceAtoms(old.getString("budgetAtoms"))
    // Only the deposit adapter supplies these limits from its in-memory passkey grant.
    // The annotation is a private copy, never a persisted or JavaScript-provided proposal.
    val limits = op.optJSONObject("fundingApprovalLimits")
    if (limits != null) {
      check(
        limits.keys().asSequence().toSet() ==
          setOf("amountAtoms", "maximumFeeAtoms", "minimumCreditAtoms")
      )
      check(
        limits.getString("amountAtoms") == old.getString("amountAtoms") &&
          limits.getString("maximumFeeAtoms") == old.getString("maximumTokenFeeAtoms")
      )
      check(
        sourceAtoms(limits.getString("minimumCreditAtoms")) in
          BigInteger.ONE..sourceAtoms(limits.getString("amountAtoms"))
      )
      check(
        sourceAtoms(limits.getString("amountAtoms")) +
          sourceAtoms(limits.getString("maximumFeeAtoms")) +
          BigInteger.valueOf(10000) <= budget
      )
    }
    check(budget > BigInteger.valueOf(10010))
    val state = stateReader(old)
    check(state.owner.equals(owner, true) && sourceAtoms(state.tokenBalanceAtoms) >= budget)
    val auth = op.optJSONObject("authorization")
    if (auth != null)
      check(
        auth.getString("from").equals(owner, true) &&
          auth.getLong("chainId") == 143L &&
          auth.getString("address").equals(EARN_IMPLEMENTATION, true) &&
          state.senderCode == "0x" &&
          auth.getLong("nonce").toULong() == state.transactionNonce
      ) {
        "Saved delegation state changed"
      }
    suspend fun fees(recipient: String, amount: String): SourceReplanFees {
      currentCoroutineContext().ensureActive()
      val request =
        JSONObject()
          .put("owner", owner)
          .put("recipient", recipient)
          .put("amount", amount)
          .put("budget", budget.toString())
      return parseSourceReplanFees(
        feeReader(request),
        owner,
        recipient,
        amount,
        budget.toString(),
        state,
        now(),
      )
    }
    val reserve = BigInteger.valueOf(10000)
    val probeCap = fees(confidential, "1").cap
    if (limits != null)
      check(probeCap <= sourceAtoms(limits.getString("maximumFeeAtoms"))) {
        "Funding fee exceeds the approved limit"
      }
    var amount =
      limits?.let { sourceAtoms(it.getString("amountAtoms")) } ?: (budget - probeCap - reserve)
    var nextRevision = Math.addExact(old.getInt("revision"), 1)
    for (attempt in 1..4) {
      check(amount >= BigInteger.TEN) {
        "Saved source budget no longer covers fresh fees and reserve"
      }
      // A killed/failed refresh may have durably saved a protected quote before
      // its source journal update. Never collide with that immutable cache entry.
      var skipped = 0
      while (quotes?.get(op.getString("operationId"), nextRevision) != null) {
        check(skipped++ < 256)
        nextRevision = Math.addExact(nextRevision, 1)
      }
      val revision = nextRevision
      nextRevision = Math.addExact(nextRevision, 1)
      currentCoroutineContext().ensureActive()
      val quote =
        JSONObject(
          quoteCreator(
            record.earnChain,
            op.getString("operationId"),
            revision,
            owner,
            confidential,
            amount.toString(),
          )
        )
      val clock = now() / 1000
      check(
        quote.getString("operationId") == op.getString("operationId") &&
          quote.getInt("revision") == revision &&
          quote.getInt("chainId") == 143 &&
          quote.getString("token").equals(MONAD_EARN_USDC, true) &&
          quote.getString("amountAtoms") == amount.toString()
      )
      check(
        quote.getString("confidentialAccount").equals(confidential, true) &&
          quote.getString("refundOwner").equals(owner, true) &&
          quote.getString("originAsset") == EARN_MONAD_ASSET
      )
      earnHash(quote.getString("quoteId"))
      earnAddressWord(quote.getString("recipient"))
      check(sourceAtoms(quote.getString("minimumCreditAtoms")) > BigInteger.ZERO)
      if (limits != null)
        check(
          sourceAtoms(quote.getString("minimumCreditAtoms")) >=
            sourceAtoms(limits.getString("minimumCreditAtoms"))
        ) {
          "Funding credit fell below the approved minimum"
        }
      check(quote.getLong("expiresAt") > clock + 15 && quote.getLong("expiresAt") <= clock + 600)
      // Qualification is performed by NativeEarnQuoteGateway over native TLS.
      check(quote.getInt("providerFeeBps") in 0..100)
      val finalFees = fees(quote.getString("recipient"), amount.toString())
      if (limits != null)
        check(finalFees.cap <= sourceAtoms(limits.getString("maximumFeeAtoms"))) {
          "Funding fee exceeds the approved limit"
        }
      if (amount + finalFees.cap + reserve <= budget) {
        check(quote.getLong("expiresAt") > now() / 1000 + 15 && finalFees.expiresAtMs > now()) {
          "Fresh funding terms expired during preparation"
        }
        currentCoroutineContext().ensureActive()
        val p =
          JSONObject(old.toString())
            .put("revision", revision)
            .put("expectedFrom", owner)
            .put("refundOwner", owner)
            .put("confidentialAccount", confidential)
            .put("amountAtoms", amount.toString())
            .put(
              "maximumTokenFeeAtoms",
              limits?.getString("maximumFeeAtoms") ?: finalFees.cap.toString(),
            )
            .put("nonce", finalFees.operation.getString("nonce"))
            .put("deadline", minOf(quote.getLong("expiresAt"), now() / 1000 + 180))
            .put("recipient", quote.getString("recipient"))
            .put("quoteId", quote.getString("quoteId"))
        // Identity, batch, cycle and approved budget are copied unchanged. No signature is
        // produced.
        return p to finalFees.operation
      }
      amount = budget - finalFees.cap - reserve
    }
    error("Fresh source fees did not stabilize inside the saved budget")
  }
}

private data class SourceReplanFees(
  val cap: BigInteger,
  val operation: JSONObject,
  val expiresAtMs: Long,
)

private fun sourceAtoms(value: String): BigInteger {
  check(value.matches(Regex("0|[1-9][0-9]{0,77}")))
  return value.toBigInteger().also { check(it.bitLength() <= 256) }
}

private fun parseSourceReplanFees(
  row: JSONObject,
  owner: String,
  recipient: String,
  amount: String,
  budget: String,
  state: EarnSourceReplanState,
  now: Long,
): SourceReplanFees {
  check(
    row.getString("version") == "gizu-monad-funding-v1" &&
      row.getInt("chainId") == 143 &&
      row.getString("owner").equals(owner, true) &&
      row.getString("recipient").equals(recipient, true) &&
      row.getString("token").equals(MONAD_EARN_USDC, true)
  )
  check(
    row.getString("amount") == amount &&
      row.getString("budget") == budget &&
      row.getString("entryPoint").equals(EARN_ENTRY_POINT, true) &&
      row.getString("paymaster").equals(EARN_PAYMASTER, true) &&
      row.getString("delegation").equals(EARN_IMPLEMENTATION, true)
  )
  check(
    !row.getBoolean("executionAvailable") &&
      row.getString("paymasterDataStatus") == "stub" &&
      now - row.getLong("timestampMs") in -5000L..60000L &&
      row.getLong("expiresAtMs") > now &&
      row.getLong("expiresAtMs") <= row.getLong("timestampMs") + 60000
  )
  earnHash(row.getString("referenceHash"))
  sourceAtoms(row.getString("referenceBlock"))
  check(
    sourceAtoms(row.getString("authorizationNonce")) ==
      state.transactionNonce.toString().toBigInteger() &&
      row.getBoolean("authorizationRequired") == (state.senderCode == "0x")
  )
  val raw = row.getJSONObject("operation")
  val allowed =
    setOf(
      "sender",
      "nonce",
      "callData",
      "callGasLimit",
      "verificationGasLimit",
      "preVerificationGas",
      "paymasterVerificationGasLimit",
      "paymasterPostOpGasLimit",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
      "paymaster",
      "paymasterData",
      "factory",
      "factoryData",
      "signature",
    )
  check(
    raw.getString("sender").equals(owner, true) &&
      raw.getString("paymaster").equals(EARN_PAYMASTER, true)
  )
  // SDK dummy signatures/delegation placeholders are never authority. Copy only
  // the same public unsigned fields accepted by the initial JS funding builder.
  val operation = JSONObject().put("signature", "0x")
  for (field in allowed - setOf("factory", "factoryData", "signature")) {
    val value = raw.getString(field)
    check(value.matches(Regex("0x[0-9a-fA-F]+")))
    operation.put(field, value)
  }
  for (field in listOf("factory", "factoryData")) if (raw.has(field))
    operation.put(field, raw.getString(field))
  check(quantity(operation.getString("nonce")) == quantity(state.entryPointNonce))
  if (operation.has("factory") || operation.has("factoryData"))
    check(operation.getString("factory") == "0x7702" && operation.getString("factoryData") == "0x")
  val cap = sourceReplanFeeCap(operation, now / 1000)
  check(sourceAtoms(row.getString("feeCap")) == cap && cap > BigInteger.ZERO)
  check(
    sourceAtoms(amount) + cap + sourceAtoms(row.getString("remainingBudget")) == sourceAtoms(budget)
  )
  return SourceReplanFees(cap, operation, row.getLong("expiresAtMs"))
}

/** Same parser, bounds and ceil cap as the native signing authority. */
private fun sourceReplanFeeCap(op: JSONObject, now: Long): BigInteger =
  try {
    uniffi.gizu_stored_signer_core
      .earnErc20FeeCap(op.toString(), MONAD_EARN_USDC, now.toULong())
      .toBigInteger()
  } catch (failure: uniffi.gizu_stored_signer_core.SignerException) {
    // Preserve the adapter's existing validation failure contract at its callers.
    throw IllegalStateException("Invalid source funding gas terms", failure)
  }
