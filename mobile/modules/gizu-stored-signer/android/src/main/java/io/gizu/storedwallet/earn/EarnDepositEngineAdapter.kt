package io.gizu.storedwallet

import android.content.Context
import java.math.BigInteger
import java.security.SecureRandom
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.EarnReadAuthentication
import uniffi.gizu_stored_signer_core.NativeSponsoredState

/**
 * Joins exact existing engine reviews to bounded native authority; contains no signing
 * implementation.
 */
internal class EarnDepositEngineAdapter(
  private val context: Context,
  private val store: WalletStore,
  private val walletId: String,
  private val generation: String,
  private val cycle: Int,
  private val foreground: () -> Unit,
  private val gateway: EarnDepositGateway = EarnDepositGateway(),
  private val now: () -> Long = System::currentTimeMillis,
) : EarnDepositEngines {
  private fun <T> record(action: (WalletRecord) -> T): T =
    store.load().use { r ->
      check(
        r.id == walletId &&
          r.journalId == generation &&
          r.earnCycleIndex == cycle &&
          r.earnChain == 4663
      )
      requireSponsoredWallet(r, walletId)
      action(r)
    }

  private fun sponsored() = record { earnSponsoredJournal(context, it) }

  private fun payouts() = record { earnPayoutJournal(context, it) }

  private fun sponsoredEngine(chain: Int): EarnSponsoredEngine =
    EarnSponsoredEngine(
      store,
      sponsored(),
      EarnSponsoredChainRpc(chain),
      EarnSponsoredBundlerRpc(chain),
      reservations = record { fundingReservations(context, it) },
      sourceReplanner = { record, row ->
        val annotated = JSONObject(row.toString())
        executionGrant?.let { grant ->
          foreground()
          grant.assertRead(record, now())
          grant.fundingRefreshLimits(row.getString("operationId"))?.let {
            annotated.put("fundingApprovalLimits", it)
          }
        }
        EarnSourceReplanner(earnQuoteJournal(context, record)).replan(record, annotated)
      },
    )

  private fun batch(sourceId: String): List<JSONObject> {
    val journal = sponsored()
    val p = journal.get(sourceId).getJSONObject("proposal")
    val reservation = record {
      fundingReservations(context, it).batch(p.getString("fundingBatchId"))
    }
    check(
      reservation.getString("feature") == "earn" &&
        reservation.getInt("cycleIndex") == cycle &&
        reservation.getBoolean("registrationComplete")
    )
    val ids = reservation.getJSONArray("legs").objects().map { it.getString("operationId") }
    check(ids.size == p.getInt("fundingBatchSize") && ids.distinct().size == ids.size)
    return ids.map(journal::get)
  }

  private suspend fun readAuth(grant: EarnDepositApproval): EarnReadAuthentication {
    foreground()
    record { grant.assertRead(it, now()) }
    val salt = ConfidentialBalance().salt()
    val random = ByteArray(7).also { SecureRandom().nextBytes(it) }
    val started = now()
    foreground()
    return record { r ->
      grant.assertRead(r, now())
      cycleReadAuth(r, salt, random, started.toULong(), now().toULong())
    }
  }

  private fun payoutEngine(grant: EarnDepositApproval) = payoutEngine { readAuth(grant) }

  private fun payoutEngine(auth: suspend () -> EarnReadAuthentication) =
    EarnPayoutEngine(
      store,
      payouts(),
      EarnSponsoredChainRpc(4663),
      sourceReader = { id, revision ->
        val row = sponsored().get(id)
        check(row.getInt("revision") == revision)
        check(credit(row) != null)
        row
      },
      sourceBatchReader = { id ->
        batch(id).also { rows -> check(rows.all { credit(it) != null }) }
      },
      readAuth = auth,
      groupedDelivery = {
        isGuidedEarnPayout(it, listOf(JSONObject().put("review", depositReview())))
      },
      privateFundingOffset = {
        depositReview()
          .getJSONArray("sources")
          .objects()
          .filter { it.optString("kind") == "private" }
          .fold(BigInteger.ZERO) { sum, source ->
            sum + depositAtoms(source.getString("amountAtoms"))
          }
          .toString()
      },
    )

  private fun depositReview(): JSONObject = record { r ->
    earnDepositJournal(context, r)
      .all()
      .single { it.getInt("cycleIndex") == cycle }
      .getJSONObject("review")
  }

  private fun privateSource(sourceId: String): Boolean =
    depositReview()
      .getJSONArray("fundingRows")
      .objects()
      .single { it.getString("operationId") == sourceId }
      .let(::isPrivateDepositSource)

  private fun privatePayoutEngine(
    readAuthority: (() -> Unit)? = null,
    readAuthorization: suspend () -> Unit = {},
  ): EarnPrivatePayoutEngine {
    fun authority() {
      foreground()
      if (readAuthority != null) readAuthority()
      else record { checkNotNull(executionGrant).assertRead(it, now()) }
    }
    val privateGateway =
      NativeCashoutGateway(
        auth = { source ->
          readAuthorization()
          val signed =
            store.load().use { r ->
              record {}
              privateDepositReadAuth(r, source, ::authority)
            }
          JSONObject()
            .put("standard", "erc191")
            .put("payload", signed.payload)
            .put("signature", signed.signature)
        },
        rpc = EarnSponsoredChainRpc(4663),
        route = "private-funding",
      )
    return EarnPrivatePayoutEngine(
      store,
      payouts(),
      privateGateway,
      { source ->
        readAuthorization()
        store.load().use { r ->
          record {}
          readPrivateDepositBalance(context, r, source, ::authority)
        }
      },
      ::authority,
      { r, addresses ->
        io.gizu.storedwallet.portfolio
          .NativeOwnedConfidentialPortfolio(context)
          .invalidateSources(r, addresses)
        io.gizu.storedwallet.swap.MainnetPortfolio(context).invalidate(r)
      },
    )
  }

  private var executionGrant: EarnDepositApproval? = null

  /** Host/coordinator sets this only for the currently owned foreground job. */
  override fun useGrant(grant: EarnDepositApproval?) {
    executionGrant = grant
  }

  override fun invested(journeyId: String) = record {
    store.completeEarnDepositCycle(it, journeyId)
  }

  override suspend fun registerFunding(row: JSONObject): JSONObject {
    foreground()
    return sponsoredEngine(143).use {
      it.create(
        mapOf(
          "walletId" to walletId,
          "proposal" to depositJsonMap(row.getJSONObject("proposal")),
          "userOperation" to depositJsonMap(row.getJSONObject("unsignedUserOperation")),
        )
      )
    }
  }

  override suspend fun preparePayout(sourceId: String, leg: String): JSONObject {
    val grant = checkNotNull(executionGrant)
    foreground()
    record { grant.assertRead(it, now()) }
    val existing =
      payouts().all().singleOrNull { row ->
        val p = row.getJSONObject("proposal")
        p.getString("operationId") == sourceId &&
          p.getString("leg") == leg &&
          p.optInt("cycleIndex", 0) == cycle
      }
    if (existing != null) return existing
    if (privateSource(sourceId)) return privatePayoutEngine().create(depositReview(), sourceId, leg)
    val source = sponsored().get(sourceId)
    return payoutEngine(grant).use {
      it.create(
        mapOf(
          "walletId" to walletId,
          "sourceOperationId" to sourceId,
          "sourceRevision" to source.getInt("revision"),
          "leg" to leg,
          "cycleIndex" to cycle,
        )
      )
    }
  }

  override suspend fun prepareDeposit(id: String, attributedAtoms: String, slot: Int?): JSONObject {
    foreground()
    selectDepositSlot(slot)
    val existing = sponsored().all().singleOrNull { it.getString("operationId") == id }
    if (
      existing != null &&
        (existing.sponsoredSpendSaved() ||
          existing.getString("status") !in setOf("planned", "authorizationSaved"))
    )
      return existing
    val pair =
      store.load().use { r ->
        record {}
        checkNotNull(executionGrant).assertRead(r, now())
        gateway.depositPlan(r, id, attributedAtoms, slot)
      }
    if (existing != null) {
      pair.first.put("revision", existing.getJSONObject("proposal").getInt("revision") + 1)
      return sponsored()
        .refreshUnsignedDeposit(id, existing.getInt("revision"), pair.first, pair.second)
    }
    return sponsoredEngine(4663).use {
      it.create(
        mapOf(
          "walletId" to walletId,
          "proposal" to depositJsonMap(pair.first),
          "userOperation" to depositJsonMap(pair.second),
        )
      )
    }
  }

  private fun selectDepositSlot(slot: Int?) {
    record { r ->
      val distribution = savedCycleDistribution(r)
      if (distribution == null) check(slot == null)
      else check(slot != null && slot in distributionWeights(distribution).indices)
    }
    if (slot != null) store.selectEarnInvestmentSlot(cycle, slot)
  }

  private fun selectDepositChild(stage: String, id: String) {
    if (stage != "deposit") return
    val p = sponsored().get(id).getJSONObject("proposal")
    check(p.getString("kind") == "hoodDeposit" && p.optInt("cycleIndex", 0) == cycle)
    val slot = if (p.has("investmentSlot")) p.getInt("investmentSlot") else null
    selectDepositSlot(slot)
    record { r ->
      requireActiveEarnCycle(r, p)
      check(p.getString("expectedFrom").equals(cycleInvestmentAddress(r, slot), true))
    }
  }

  override fun child(stage: String, id: String): JSONObject =
    try {
      if (stage == "payouts") payouts().get(id) else sponsored().get(id)
    } catch (_: NoSuchElementException) {
      error("Missing child journal; reconcile restored activity")
    }

  private fun witness(
    row: JSONObject,
    hash: String,
    text: String,
    state: NativeSponsoredState? = null,
  ): JSONObject {
    val proof = JSONObject().put("hash", hash).put("text", text)
    val p = row.getJSONObject("proposal")
    if (p.getString("kind") == "hoodDeposit") {
      val current = checkNotNull(state)
      val amount = depositAtoms(p.getString("amountAtoms"), true)
      val shares = depositAtoms(current.previewDepositShares, true)
      val numerator = amount * BigInteger.TEN.pow(27) * BigInteger.valueOf(10010)
      val denominator = shares * BigInteger.valueOf(10000)
      val price = (numerator + denominator - BigInteger.ONE) / denominator
      proof.put("minimumSharesAtoms", (amount * BigInteger.TEN.pow(27) / price).toString())
    }
    return proof
  }

  override suspend fun execute(stage: String, id: String, grant: EarnDepositApproval) {
    foreground()
    selectDepositChild(stage, id)
    record { grant.assertRead(it, now()) }
    if (stage == "payouts") {
      if (payouts().get(id).getJSONObject("proposal").getString("kind") == "privateEarnPayout") {
        privatePayoutEngine().execute(id, grant) { row, proof ->
          record { grant.assertPrepared(it, stage, row, proof, now()) }
        }
        return
      }
      payoutEngine(grant).use { engine ->
        var row = engine.journal.get(id)
        val review = engine.prepare(id, row.getInt("revision"))
        row = engine.journal.get(id)
        val quoted = NativePayoutGateway().decode(row.getString("preparedText"), !review.retry)
        val proof =
          witness(row, review.hash, review.text)
            .put("providerFeeBps", JSONObject(quoted.text).getJSONObject("quote").getInt("feeBps"))
        try {
          engine.execute(review) {
            foreground()
            val fresh = engine.journal.get(id)
            record { grant.assertPrepared(it, stage, fresh, proof, now()) }
            if (fresh.has("signedData"))
              grant.recordDurableSignature(stage, id, depositDigest(fresh.getString("signedData")))
          }
        } catch (failure: Exception) {
          if (
            !engine.journal.get(id).has("signedData") ||
              failure is kotlinx.coroutines.CancellationException
          )
            throw failure
        }
      }
    } else {
      val chain = if (stage == "funding") 143 else 4663
      sponsoredEngine(chain).use { engine ->
        // A required delegation and subsequent UserOperation share this bounded grant.
        for (attempt in 0..1) {
          val row = engine.journal.get(id)
          val review = engine.prepare(id, row.getInt("revision"))
          val after = engine.journal.get(id)
          var state =
            EarnSponsoredStateLoader(EarnSponsoredChainRpc(chain))
              .load(after.getJSONObject("proposal"))
          val authority = {
            foreground()
            val fresh = engine.journal.get(id)
            record {
              grant.assertPrepared(
                it,
                stage,
                fresh,
                witness(fresh, review.hash, review.text, state),
                now(),
              )
            }
            if (fresh.has("signedUserOperation"))
              grant.recordDurableSignature(
                stage,
                id,
                depositDigest(fresh.getString("signedUserOperation")),
              )
          }
          try {
            engine.executeBounded(review, authority) { current ->
              state = current
              authority()
            }
          } catch (failure: Exception) {
            // A durable signature remains authoritative after an uncertain send. Reconcile it.
            if (!engine.journal.get(id).sponsoredSpendSaved()) throw failure
            if (failure is kotlinx.coroutines.CancellationException) throw failure
          }
          if (review.kind != "delegation") break
        }
      }
    }
  }

  override suspend fun reconcile(
    stage: String,
    id: String,
    grant: EarnDepositApproval?,
  ): JSONObject {
    selectDepositChild(stage, id)
    if (stage == "payouts") {
      val journal = payouts()
      val row = journal.get(id)
      if (row.getJSONObject("proposal").has("distribution")) return row
      if (grant == null || !row.has("signedData") || row.getString("status") == "paid") return row
      if (row.getJSONObject("proposal").getString("kind") == "privateEarnPayout")
        return privatePayoutEngine().reconcile(id)
      return payoutEngine(grant).use { it.reconcile(id, row.getInt("revision")) }
    }
    val journal = sponsored()
    val chain = if (stage == "funding") 143 else 4663
    reconcileEarnSponsoredOperations(
      journal,
      EarnSponsoredChainRpc(chain),
      EarnSponsoredBundlerRpc(chain),
      chainFilter = chain,
      operationIds = setOf(id),
    )
    val row = journal.get(id)
    if (
      stage == "funding" &&
        row.getString("status") == "finalized" &&
        row.optJSONObject("settlement")?.optString("status") != "credited" &&
        grant != null
    ) {
      val proof = readNativeSponsoredSettlement(readAuth(grant), sponsoredSettlementExpected(row))
      foreground()
      record { grant.assertRead(it, now()) }
      val saved = journal.update(id, row.getInt("revision")) { it.put("settlement", proof) }
      if (proof.getString("status") == "credited")
        record { fundingReservations(context, it).complete(id) }
      return saved
    }
    return row
  }

  override suspend fun reconcilePayoutGroup(review: JSONObject, grant: EarnDepositApproval?) {
    if (grant == null || !review.has("distribution")) return
    suspend fun auth() = readAuth(grant)
    fun authority() {
      foreground()
      record { grant.assertRead(it, now()) }
    }
    reconcileDistributionGroup(review, ::auth, ::authority)
  }

  private suspend fun reconcileDistributionGroup(
    review: JSONObject,
    auth: suspend () -> EarnReadAuthentication,
    readAuthority: () -> Unit,
  ) {
    fun authority() {
      foreground()
      readAuthority()
      record {}
    }
    authority()
    val group = earnPayoutGroup(review)
    record { r ->
      group.getJSONArray("recipients").let { recipients ->
        for (slot in 0 until recipients.length()) check(
          recipients.getString(slot).equals(cycleInvestmentAddress(r, slot), true)
        )
      }
    }
    val journal = payouts()
    val id = depositDigest(depositCanonical(group))
    val saved = journal.group(id)
    if (saved?.optBoolean("recoveryRequired") == true) throw EarnGroupRecoveryRequired()
    if (saved?.getString("status") == "paid") return
    val children = earnPayoutGroupChildren(group, journal.all())
    if (children.none { it?.has("signedData") == true }) return
    val chain = EarnSponsoredChainRpc(4663)
    val rpc =
      object : TransferRpc {
        override suspend fun call(method: String, params: JSONArray): Any {
          authority()
          return chain.call(method, params).also { authority() }
        }
      }
    fun signed(a: EarnReadAuthentication) =
      JSONObject().put("standard", "erc191").put("payload", a.payload).put("signature", a.signature)
    val gateway =
      EarnPayoutGroupGateway(
        rpc,
        beforeCandidatePost = {
          authority()
          WalletRecoveryRuntime.beforeSubmission()
          authority()
        },
        persistCandidates = { candidate ->
          authority()
          journal.saveGroup(group, children, candidate)
        },
        owners = {
          authority()
          // Invokes the existing bounded authenticator even for all-private journeys.
          val funded = auth()
          val proofs = JSONArray()
          if (group.getJSONArray("members").objects().any { it.getString("kind") == "funded" })
            proofs.put(signed(funded))
          val sources =
            review
              .getJSONArray("fundingRows")
              .objects()
              .filter(::isPrivateDepositSource)
              .map { it.getJSONObject("proposal").getJSONObject("source") }
              .distinctBy { it.getString("address").lowercase() }
          for (source in sources) {
            authority()
            val proof = store.load().use { r -> privateDepositReadAuth(r, source, ::authority) }
            proofs.put(signed(proof))
          }
          check(proofs.length() in 1..128)
          proofs
        },
      )
    val proof = gateway.status(group, children, saved ?: JSONObject())
    authority()
    journal.saveGroup(group, children, proof)
  }

  /**
   * Reconciles saved children using login's bounded read-only permission, never a spending grant.
   */
  private var remainingGroupReconciled = false

  suspend fun reconcileBeforeRemaining(
    stage: String,
    id: String,
    auth: suspend () -> EarnReadAuthentication,
    readAuthority: () -> Unit = foreground,
  ): JSONObject {
    foreground()
    if (stage == "payouts" && payouts().get(id).getJSONObject("proposal").has("distribution")) {
      readAuthority()
      if (!remainingGroupReconciled) {
        reconcileDistributionGroup(depositReview(), auth, readAuthority)
        remainingGroupReconciled = true
      }
      return payouts().get(id)
    }
    if (stage == "payouts")
      return reconcileDepositPayoutBeforeReview(payouts().get(id)) { row ->
        if (row.getJSONObject("proposal").getString("kind") == "privateEarnPayout") {
          // The supplied empty-intents authenticator checks the current bounded login permission.
          auth()
          privatePayoutEngine(readAuthority = readAuthority, readAuthorization = { auth() })
            .reconcile(id)
        } else payoutEngine(auth).use { it.reconcile(id, row.getInt("revision")) }
      }
    check(stage == "funding")
    val row = reconcile(stage, id, null)
    if (
      row.getString("status") != "finalized" ||
        row.optJSONObject("settlement")?.optString("status") == "credited"
    )
      return row
    val proof = readNativeSponsoredSettlement(auth(), sponsoredSettlementExpected(row))
    foreground()
    val saved = sponsored().update(id, row.getInt("revision")) { it.put("settlement", proof) }
    if (proof.getString("status") == "credited")
      record { fundingReservations(context, it).complete(id) }
    return saved
  }

  override fun credit(row: JSONObject): String? {
    if (
      row.getString("status") != "finalized" ||
        row.optJSONObject("settlement")?.optString("status") != "credited"
    )
      return null
    record { r ->
      val p = row.getJSONObject("proposal")
      requireActiveEarnCycle(r, p)
      nativePayoutSource(
        row,
        row.getInt("revision"),
        PayoutIdentities(
          publicAccountAddress(r, p.getInt("sourceAccountIndex")),
          cycleConfidential(r),
          cycleAddresses(r)[0],
        ),
        4663,
      )
    }
    return row.getJSONObject("settlement").getString("creditedAtoms")
  }

  override fun payoutReceipt(row: JSONObject): String? {
    if (row.getString("status") != "paid") return null
    if (row.has("groupId")) {
      val group = earnPayoutGroup(depositReview())
      val id = depositDigest(depositCanonical(group))
      check(row.getString("groupId") == id && row.has("signedData"))
      val proof = checkNotNull(payouts().group(id))
      check(proof.getString("status") == "paid" && proof.getString("groupId") == id)
      val slot = distributionSlot(row.getString("leg"), group.getJSONObject("distribution"))
      check(
        row.getJSONObject("receipt").getString("groupId") == id &&
          row.getJSONObject("receipt").getInt("slot") == slot
      )
      check(earnPayoutGroupChildren(group, listOf(row)).count { it != null } == 1)
      check(
        depositAtoms(row.getString("receivedAtoms"), true) >=
          depositAtoms(row.getJSONObject("proposal").getString("minimumDestinationAtoms"), true)
      )
      return row.getString("receivedAtoms")
    }
    check(
      row.has("signedData") &&
        row.has("receipt") &&
        row.has("settlement") &&
        row.has("destinationTransactionHash")
    )
    earnHash(row.getString("destinationTransactionHash"))
    return row.getString("receivedAtoms")
  }

  override fun investment(row: JSONObject): DepositInvestment? {
    if (row.getString("status") != "finalized") return null
    check(
      row.has("signedUserOperation") &&
        row.has("stateBinding") &&
        row.getJSONObject("proposal").getString("kind") == "hoodDeposit"
    )
    return DepositInvestment(
      row.getJSONObject("proposal").getString("amountAtoms"),
      row.getString("settledShares"),
      row.getString("transactionHash"),
    )
  }
}
