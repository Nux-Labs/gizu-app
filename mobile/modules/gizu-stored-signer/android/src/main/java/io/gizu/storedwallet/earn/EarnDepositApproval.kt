package io.gizu.storedwallet

import java.math.BigDecimal
import java.math.BigInteger
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/** Memory-only authority. Persisted review/progress is evidence, never an approved signer. */
internal class EarnDepositApproval
private constructor(
  private val walletId: String,
  private val generation: String,
  private val cycle: Int,
  private val registry: String,
  review: JSONObject,
  private val funding: EarnFundingBatchApproval,
) {
  private val envelope = JSONObject(review.toString())
  val review: JSONObject
    get() = JSONObject(envelope.toString())

  private var remainingApprovalAt: Long? = null
  val digest: String
    get() =
      depositDigest(
        depositCanonical(
          JSONObject()
            .put("review", review)
            .put("remainingApprovalAt", remainingApprovalAt ?: JSONObject.NULL)
        )
      )

  private var approvedAt: Long? = null
  private var lastObservedAt = 0L
  private var invalidated = false
  private val credits = linkedMapOf<String, String>()
  private val payouts = linkedMapOf<String, String>()
  private val logicalChildren = linkedMapOf<String, String>()
  private val proposals = linkedMapOf<String, String>()
  private val signatures = linkedMapOf<String, String>()
  private val sources =
    review.getJSONArray("sources").objects().sortedBy { it.getInt("accountIndex") }

  companion object {
    /** Fresh explicit resume approval preserves saved minimums; it does not renew old quotes. */
    fun fromRemainingReview(
      record: WalletRecord,
      review: JSONObject,
      now: Long,
    ): EarnDepositApproval {
      check(now >= review.getLong("quotedAtMs") && now <= Long.MAX_VALUE - 45000)
      return fromReview(record, review).also { it.remainingApprovalAt = now }
    }

    fun fromReview(record: WalletRecord, review: JSONObject): EarnDepositApproval {
      check(record.verified && !record.earnRecoveryRequired && record.earnChain == 4663)
      check(
        review.getString("walletId") == record.id &&
          review.getString("generation") == record.journalId
      )
      check(
        review.getInt("cycleIndex") == record.earnCycleIndex &&
          review.getInt("profileChainId") == 4663
      )
      check(
        depositCanonical(review.getJSONObject("roleRegistry")) ==
          depositCanonical(JSONObject(record.roleRegistry))
      )
      check(review.getString("confidentialAccount") == cycleConfidential(record))
      val distribution = savedCycleDistribution(record)
      check(nativeJsonEqual(review.opt("distribution"), distribution))
      if (distribution == null) check(!review.has("deposits"))
      val addresses = cycleAddresses(record)
      val legs = depositReviewLegs(review)
      val deposits = depositReviewDeposits(review)
      check(
        review.getJSONArray("destinations").let {
          it.length() == addresses.size &&
            addresses.indices.all { n -> it.getString(n).equals(addresses[n], true) }
        }
      )
      val quoted = review.getLong("quotedAtMs")
      val expiry = review.getLong("expiresAtMs")
      check(quoted >= 0 && expiry > quoted && expiry - quoted <= 60000)
      val sources = review.getJSONArray("sources").objects()
      check(
        sources.size in 1..256 &&
          sources.map { it.getInt("accountIndex") }.distinct().size == sources.size
      )
      check(sources.map { it.getString("operationId") }.distinct().size == sources.size)
      val rows = review.getJSONArray("fundingRows").objects()
      check(rows.size == sources.size)
      var offset = BigInteger.ZERO
      var totalBudget = BigInteger.ZERO
      val investMinimum = MutableList(deposits.size) { BigInteger.ZERO }
      for (s in sources.sortedBy { it.getInt("accountIndex") }) {
        val p =
          rows
            .single { it.getString("operationId") == s.getString("operationId") }
            .getJSONObject("proposal")
        check(
          s.getString("address")
            .equals(publicAccountAddress(record, s.getInt("accountIndex")), true)
        )
        check(addresses.none { it.equals(s.getString("address"), true) })
        check(
          p.getString("token").equals(MONAD_EARN_USDC, true) &&
            p.getString("confidentialAccount") == cycleConfidential(record)
        )
        check(p.getInt("sourceAccountIndex") == s.getInt("accountIndex"))
        for ((bound, proposal) in
          listOf(
            "budgetAtoms" to "budgetAtoms",
            "amountAtoms" to "amountAtoms",
            "maximumFeeAtoms" to "maximumTokenFeeAtoms",
          )) check(s.getString(bound) == p.getString(proposal))
        val amount = depositAtoms(s.getString("amountAtoms"), true)
        val credit = depositAtoms(s.getString("minimumCreditAtoms"), true)
        val fee = depositAtoms(s.getString("maximumFeeAtoms"), true)
        val retained = depositAtoms(s.getString("retainedAtoms"))
        val budget = depositAtoms(s.getString("budgetAtoms"), true)
        check(
          credit <= amount &&
            retained >= BigInteger.valueOf(10000) &&
            amount + fee + retained == budget
        )
        if (distribution != null) {
          check(!s.has("hold") && !s.has("invest"))
          check(s.getJSONArray("allocations").length() == legs.size)
        } else check(!s.has("allocations"))
        for ((n, leg) in legs.withIndex()) {
          val l = depositReviewBound(s, leg, review)
          check(l.getString("recipient").equals(addresses[n], true))
          check(
            l.getString("inputAtoms") ==
              nativePayoutAmount(credit.toString(), offset.toString(), leg, distribution)
          )
          val minimum = depositAtoms(l.getString("minimumOutputAtoms"), true)
          check(minimum <= depositAtoms(l.getString("estimatedOutputAtoms"), true))
          check(l.getInt("providerFeeBps") in 0..100)
          if (distribution != null) investMinimum[n] += minimum
          else if (leg == "invest") investMinimum[0] += minimum
        }
        offset += credit
        totalBudget += budget
      }
      check(totalBudget == depositAtoms(review.getString("sourceBudgetAtoms"), true))
      check(deposits.size == if (distribution == null) 1 else addresses.size)
      for ((slot, d) in deposits.withIndex()) {
        if (distribution != null) {
          check(d.get("slot") is Number && d.getDouble("slot") == slot.toDouble())
          check(d.getString("recipient").equals(addresses[slot], true))
        }
        val minimum = depositAtoms(d.getString("minimumAssetsAtoms"), true)
        check(minimum <= depositAtoms(d.getString("estimatedAssetsAtoms"), true))
        check(
          minimum +
            depositAtoms(d.getString("maximumFeeAtoms"), true) +
            depositAtoms(d.getString("withdrawalReserveAtoms"), true) <= investMinimum[slot]
        )
        check(d.getInt("shareDecimals") in 0..18)
        depositAtoms(d.getString("minimumSharesAtoms"), true)
      }
      if (distribution != null)
        check(nativeJsonEqual(review.getJSONObject("deposit"), aggregateDepositBounds(deposits)))
      val reservation = review.getJSONObject("reservation")
      val funding =
        EarnFundingBatchApproval.createManifest(
          rows,
          record.id,
          record.journalId,
          record.earnCycleIndex,
          reservation.getString("id"),
          record.roleRegistry,
          reservation,
          allowUnsignedRefresh = review.optBoolean("sourceRefreshWithinLimits", false),
        )
      return EarnDepositApproval(
        record.id,
        record.journalId,
        record.earnCycleIndex,
        depositCanonical(JSONObject(record.roleRegistry)),
        JSONObject(review.toString()),
        funding,
      )
    }
  }

  @Synchronized
  fun approveAfterPasskey(now: Long) {
    val start = remainingApprovalAt ?: review.getLong("quotedAtMs")
    val expiry = remainingApprovalAt?.let { it + 45000 } ?: review.getLong("expiresAtMs")
    check(!invalidated && approvedAt == null && now >= start && now < expiry)
    check(now <= Long.MAX_VALUE - 900000)
    funding.approveAfterPasskey(now)
    approvedAt = now
    lastObservedAt = now
  }

  @Synchronized
  fun assertRead(record: WalletRecord, now: Long) {
    val started = approvedAt
    check(!invalidated && started != null && now >= lastObservedAt && now - started < 900000) {
      "Deposit approval expired"
    }
    check(
      record.id == walletId &&
        record.journalId == generation &&
        record.verified &&
        !record.earnRecoveryRequired &&
        record.earnChain == 4663 &&
        record.earnCycleIndex == cycle &&
        depositCanonical(JSONObject(record.roleRegistry)) == registry
    )
    check(nativeJsonEqual(savedCycleDistribution(record), envelope.opt("distribution")))
    lastObservedAt = now
  }

  @Synchronized
  fun assertPrepared(
    record: WalletRecord,
    stage: String,
    child: JSONObject,
    preparedReview: JSONObject,
    now: Long,
  ) {
    assertRead(record, now)
    check(stage in setOf("funding", "payouts", "deposit"))
    check(
      preparedReview.getString("hash").matches(Regex("0x[0-9a-fA-F]{64}")) &&
        preparedReview.getString("text").isNotBlank()
    )
    check(
      child.getString("walletId") == walletId &&
        !child.optBoolean("cancelled") &&
        !child.optBoolean("conflict")
    )
    val p = child.getJSONObject("proposal")
    val id = child.getString("operationId")
    check(p.getInt("profileChainId") == 4663 && p.optInt("cycleIndex", 0) == cycle)
    val logical =
      when (stage) {
        "funding" -> {
          funding.assertAuthorized(record, child, now)
          check(p.getLong("deadline") > now / 1000)
          "funding:$id"
        }
        "payouts" -> {
          check(p.getString("kind") == "confidentialPayout" && credits.size == sources.size)
          val source =
            sources.singleOrNull { it.getString("operationId") == p.getString("operationId") }
          check(source != null)
          val sourceId = source.getString("operationId")
          val leg = p.getString("leg")
          check(leg in depositReviewLegs(envelope))
          check(nativeJsonEqual(p.opt("distribution"), envelope.opt("distribution")))
          check(!p.has("investmentSlot"))
          val bound = depositReviewBound(source, leg, envelope)
          check(p.getString("expectedSigner") == review.getString("confidentialAccount"))
          check(
            p.getString("sourceOwner").equals(source.getString("address"), true) &&
              p.getInt("sourceAccountIndex") == source.getInt("accountIndex")
          )
          check(p.getString("expectedRecipient").equals(bound.getString("recipient"), true))
          val credit = checkNotNull(credits[sourceId])
          val offset =
            sources
              .filter { it.getInt("accountIndex") < source.getInt("accountIndex") }
              .fold(BigInteger.ZERO) { n, s ->
                n + depositAtoms(checkNotNull(credits[s.getString("operationId")]))
              }
              .toString()
          check(p.getString("creditedAtoms") == credit && p.getString("splitOffsetAtoms") == offset)
          check(
            p.getString("amountAtoms") ==
              nativePayoutAmount(credit, offset, leg, envelope.optJSONObject("distribution"))
          )
          check(
            depositAtoms(p.getString("minimumDestinationAtoms"), true) >=
              depositAtoms(bound.getString("minimumOutputAtoms"), true)
          )
          check(preparedReview.getInt("providerFeeBps") <= bound.getInt("providerFeeBps"))
          check(p.getLong("deadlineMs") > now)
          "payouts:$sourceId:$leg"
        }
        else -> {
          check(p.getString("kind") == "hoodDeposit")
          val distribution = envelope.optJSONObject("distribution")
          val slot =
            if (distribution != null) {
              val value = p.getInt("investmentSlot")
              check(
                p.get("investmentSlot") is Number &&
                  p.getDouble("investmentSlot") == value.toDouble()
              )
              check(value in distributionWeights(distribution).indices)
              value
            } else {
              check(!p.has("investmentSlot"))
              null
            }
          val leg = slot?.let { "invest:$it" } ?: "invest"
          check(sources.all { payouts.containsKey(it.getString("operationId") + ":" + leg) })
          if (slot == null) check(payouts.size == sources.size * 2)
          check(
            p.getInt("chainId") == 4663 &&
              p.getString("expectedFrom")
                .equals(review.getJSONArray("destinations").getString(slot ?: 1), true)
          )
          check(
            p.getString("token").equals(HOOD_EARN_USDG, true) &&
              p.getString("vault").equals(HOOD_EARN_VAULT, true) &&
              p.getString("router").equals(HOOD_EARN_ROUTER, true)
          )
          val bound = depositReviewDeposits(envelope)[slot ?: 0]
          val amount = depositAtoms(p.getString("amountAtoms"), true)
          val fee = depositAtoms(p.getString("maximumTokenFeeAtoms"), true)
          val reserve = depositAtoms(p.getString("withdrawalReserveAtoms"), true)
          val received =
            sources.fold(BigInteger.ZERO) { n, s ->
              n + depositAtoms(checkNotNull(payouts[s.getString("operationId") + ":" + leg]))
            }
          check(amount >= depositAtoms(bound.getString("minimumAssetsAtoms"), true))
          check(
            fee <= depositAtoms(bound.getString("maximumFeeAtoms"), true) &&
              reserve >= depositAtoms(bound.getString("withdrawalReserveAtoms"), true)
          )
          check(
            amount + fee + reserve <= received &&
              depositAtoms(p.getString("budgetAtoms"), true) <= received
          )
          check(
            depositAtoms(preparedReview.getString("minimumSharesAtoms"), true) >=
              depositAtoms(bound.getString("minimumSharesAtoms"), true)
          )
          check(p.getInt("slippageBps") == 10 && p.getLong("deadline") > now / 1000)
          slot?.let { "deposit:$it" } ?: "deposit"
        }
      }
    val previous = logicalChildren[logical]
    check(previous == null || previous == id) {
      "Deposit child budget already belongs to another operation"
    }
    val key = "$stage:$id"
    val canonical = depositCanonical(p)
    check(
      proposals[key] == null ||
        proposals[key] == canonical ||
        (stage == "funding" &&
          review.optBoolean("sourceRefreshWithinLimits", false) &&
          signatures[key] == null &&
          !child.sponsoredSpendSaved())
    ) {
      "Prepared deposit child terms changed"
    }
    logicalChildren[logical] = id
    proposals[key] = canonical
  }

  /** Exact original limits for refreshing unsigned source terms, never a new source allocation. */
  fun fundingRefreshLimits(sourceId: String): JSONObject? {
    if (!review.optBoolean("sourceRefreshWithinLimits", false)) return null
    val source = sources.single { it.getString("operationId") == sourceId }
    return JSONObject()
      .put("amountAtoms", source.getString("amountAtoms"))
      .put("maximumFeeAtoms", source.getString("maximumFeeAtoms"))
      .put("minimumCreditAtoms", source.getString("minimumCreditAtoms"))
  }

  /** Called only with independently authenticated, operation-specific native journal evidence. */
  @Synchronized
  fun recordCredit(sourceId: String, atoms: String) {
    val source = sources.singleOrNull { it.getString("operationId") == sourceId }
    check(source != null)
    val credit = depositAtoms(atoms, true)
    check(
      credit >= depositAtoms(source.getString("minimumCreditAtoms"), true) &&
        credit <= depositAtoms(source.getString("amountAtoms"), true)
    )
    check(credits[sourceId] == null || credits[sourceId] == atoms)
    credits[sourceId] = atoms
  }

  /** Called only after the payout engine verifies the destination receipt. */
  @Synchronized
  fun recordPayout(sourceId: String, leg: String, atoms: String) {
    check(credits.size == sources.size && leg in depositReviewLegs(envelope))
    val source = sources.singleOrNull { it.getString("operationId") == sourceId }
    check(source != null)
    check(
      depositAtoms(atoms, true) >=
        depositAtoms(
          depositReviewBound(source, leg, envelope).getString("minimumOutputAtoms"),
          true,
        )
    )
    val key = "$sourceId:$leg"
    check(payouts[key] == null || payouts[key] == atoms)
    payouts[key] = atoms
  }

  @Synchronized
  fun recordDurableSignature(stage: String, childId: String, signedHash: String) {
    check(!invalidated && approvedAt != null)
    val key = "$stage:$childId"
    check(proposals.containsKey(key) && signedHash.isNotBlank())
    check(signatures[key] == null || signatures[key] == signedHash) {
      "A signed deposit child cannot be replaced"
    }
    signatures[key] = signedHash
  }

  @Synchronized
  fun invalidate() {
    invalidated = true
    approvedAt = null
    funding.invalidate()
  }
}

internal fun JSONArray.objects(): List<JSONObject> = (0 until length()).map(::getJSONObject)

internal fun depositAtoms(value: String, positive: Boolean = false): BigInteger {
  check(value.matches(Regex("0|[1-9][0-9]{0,77}")))
  return value.toBigInteger().also {
    check(it.bitLength() <= 256 && (!positive || it.signum() > 0))
  }
}

internal fun depositCanonical(value: Any?): String =
  when (value) {
    null,
    JSONObject.NULL -> "null"
    is JSONObject ->
      value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") {
        JSONObject.quote(it) + ":" + depositCanonical(value.get(it))
      }
    is JSONArray ->
      (0 until value.length()).joinToString(",", "[", "]") { depositCanonical(value.get(it)) }
    is String -> JSONObject.quote(value)
    is Boolean -> value.toString()
    is Number -> BigDecimal(value.toString()).stripTrailingZeros().toPlainString()
    else -> error("Unsupported deposit manifest value")
  }

internal fun depositDigest(text: String): String =
  "0x" +
    MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") {
      "%02x".format(it)
    }

/**
 * Vault approval limits shown at review and enforced at signing, built from a deposit preview. The
 * fee cap and withdrawal reserve are both quoted from the same gas price, so exact limits fail
 * whenever gas moves either way before signing. Allow 25% gas movement: the fee cap rises 25%, the
 * reserve floor drops to 75%, and the asset/share minimums drop by the extra gas they permit.
 */
internal fun vaultApprovalBounds(preview: JSONObject): JSONObject {
  val four = BigInteger.valueOf(4)
  val assets = depositAtoms(preview.getString("depositAmount"), true)
  val fee = depositAtoms(preview.getString("depositFeeBudget"), true)
  val reserve = depositAtoms(preview.getString("withdrawalReserve"), true)
  val shares = depositAtoms(preview.getString("minimumSharesAtoms"), true)
  val minimumAssets = assets - (fee + reserve + BigInteger.valueOf(3)) / four
  check(minimumAssets.signum() > 0)
  return JSONObject()
    .put("estimatedAssetsAtoms", assets.toString())
    .put("minimumAssetsAtoms", minimumAssets.toString())
    .put("minimumSharesAtoms", (shares * minimumAssets / assets).toString())
    .put("shareDecimals", preview.getInt("shareDecimals"))
    .put("maximumFeeAtoms", (fee + (fee + BigInteger.valueOf(3)) / four).toString())
    .put("withdrawalReserveAtoms", (reserve * BigInteger.valueOf(3) / four).toString())
}

/**
 * Shared interpretation of the versioned review; absent metadata is the original two-role policy.
 */
internal fun depositReviewLegs(review: JSONObject): List<String> =
  review.optJSONObject("distribution")?.let {
    distributionWeights(it).indices.map { slot -> "invest:$slot" }
  } ?: listOf("hold", "invest")

internal fun depositReviewBound(source: JSONObject, leg: String, review: JSONObject): JSONObject =
  review.optJSONObject("distribution")?.let {
    source.getJSONArray("allocations").getJSONObject(distributionSlot(leg, it))
  } ?: source.getJSONObject(leg)

internal fun depositReviewDeposits(review: JSONObject): List<JSONObject> =
  if (review.has("distribution")) review.getJSONArray("deposits").objects()
  else listOf(review.getJSONObject("deposit"))

internal fun depositChildId(journeyId: String, slot: Int? = null): String =
  if (slot == null) "vault_$journeyId" else "vault_${journeyId}_$slot"
