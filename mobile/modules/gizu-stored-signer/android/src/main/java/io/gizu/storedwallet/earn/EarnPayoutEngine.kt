package io.gizu.storedwallet

import java.security.SecureRandom
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.*

internal interface NativePayoutSigner : AutoCloseable {
  fun prepare(
    revision: ULong,
    credit: NativeEarnSourceCreditProof,
    quote: NativeEarnPayoutQuoteBinding,
    payload: String,
    journal: NativeEarnPayoutJournalEvidence,
  ): String

  fun reviewHash(): String

  fun approve(revision: ULong, hash: String)

  fun sign(revision: ULong, journal: NativeEarnPayoutJournalEvidence): NativeSignedEarnPayout
}

internal data class PayoutIdentities(
  val source: String,
  val confidential: String,
  val recipient: String,
)

internal data class EarnPayoutReview(
  val id: String,
  val revision: Int,
  val coreRevision: ULong,
  val hash: String,
  val text: String,
  val retry: Boolean,
)

private class RustPayoutSigner(p: String, entropy: ByteArray) : NativePayoutSigner {
  private val core =
    EarnPayoutOperation(
      JSONObject(p)
        .also {
          it.remove("sourceOwner")
          it.remove("fundingBatchId")
          it.remove("fundingBatchSize")
        }
        .toString(),
      entropy,
    )

  override fun prepare(
    revision: ULong,
    credit: NativeEarnSourceCreditProof,
    quote: NativeEarnPayoutQuoteBinding,
    payload: String,
    journal: NativeEarnPayoutJournalEvidence,
  ) = core.prepare(revision, credit, quote, payload, journal)

  override fun reviewHash() = core.reviewHash()

  override fun approve(revision: ULong, hash: String) = core.approve(revision, hash)

  override fun sign(revision: ULong, journal: NativeEarnPayoutJournalEvidence) =
    core.sign(revision, journal)

  override fun close() {
    core.invalidate()
    core.close()
  }
}

private fun payoutIdentities(record: WalletRecord, leg: String) =
  PayoutIdentities(
    deriveAccountAddresses(record.entropy)[0],
    cycleConfidential(record),
    savedCycleDistribution(record)?.let {
      cycleInvestmentAddress(record, distributionSlot(leg, it))
    } ?: cycleAddresses(record)[if (leg == "hold") 0 else 1],
  )

internal fun nativePayoutSource(
  op: JSONObject,
  requestedRevision: Int,
  identities: PayoutIdentities,
  profile: Int,
): JSONObject {
  check(
    op.getInt("revision") == requestedRevision &&
      op.getString("status") == "finalized" &&
      op.has("signedUserOperation")
  )
  val p = op.getJSONObject("proposal")
  check(
    p.getString("kind") == "sourceFunding" &&
      p.getInt("chainId") == 143 &&
      p.getInt("profileChainId") == profile
  )
  check(
    p.getString("expectedFrom").equals(identities.source, true) &&
      p.getString("confidentialAccount").equals(identities.confidential, true)
  )
  val source = sponsoredSettlementExpected(op)
  val settlement = op.getJSONObject("settlement")
  // The saved authenticated settlement revision precedes the mutable journal save.
  val expected = JSONObject(source.toString()).put("revision", settlement.getInt("revision"))
  validateSponsoredSettlement(settlement.toString(), expected, settlement.getLong("timestampMs"))
  check(settlement.getString("status") == "credited")
  check(settlement.getInt("revision") < op.getInt("revision"))
  source
    .put("revision", p.getLong("revision"))
    .put(
      "quoteId",
      op.getJSONObject("stateBinding").getJSONObject("routeProof").getString("quoteId"),
    )
  return source
}

/** The callback supplies the exact durable native batch membership, never a JS catalogue. */
internal fun nativePayoutBatchOffset(
  source: JSONObject,
  rows: List<JSONObject>,
  validate: (JSONObject) -> JSONObject,
): String {
  val p = source.getJSONObject("proposal")
  if (!p.has("fundingBatchId")) {
    validate(source)
    return "0"
  }
  val size = p.getInt("fundingBatchSize")
  check(size > 0 && rows.size == size) {
    "All selected funding operations must be registered and credited"
  }
  val ids = mutableSetOf<String>()
  val indices = mutableSetOf<Int>()
  val transactions = mutableSetOf<String>()
  rows.forEach { row ->
    val child = row.getJSONObject("proposal")
    check(
      child.getString("fundingBatchId") == p.getString("fundingBatchId") &&
        child.getInt("fundingBatchSize") == size
    )
    check(
      child.optInt("cycleIndex", 0) == p.optInt("cycleIndex", 0) &&
        child.getInt("profileChainId") == p.getInt("profileChainId")
    )
    check(child.getString("confidentialAccount").equals(p.getString("confidentialAccount"), true))
    check(
      ids.add(row.getString("operationId")) &&
        child.getString("operationId") == row.getString("operationId") &&
        indices.add(child.optInt("sourceAccountIndex", 0))
    )
    validate(row)
    val deposit =
      row.getString("transactionHash").lowercase() +
        ":" +
        child.getString("expectedFrom").lowercase() +
        ":" +
        child.getString("recipient").lowercase()
    check(transactions.add(deposit)) { "A funding deposit cannot be counted twice" }
  }
  val selected = rows.single { it.getString("operationId") == source.getString("operationId") }
  val selectedProposal = selected.getJSONObject("proposal")
  check(
    p.keys().asSequence().toSet() == selectedProposal.keys().asSequence().toSet() &&
      p.keys().asSequence().all { p.opt(it) == selectedProposal.opt(it) }
  ) {
    "Selected funding binding changed"
  }
  check(
    selected.getString("transactionHash").equals(source.getString("transactionHash"), true) &&
      selected.getJSONObject("settlement").getString("creditedAtoms") ==
        source.getJSONObject("settlement").getString("creditedAtoms")
  )
  val index = p.optInt("sourceAccountIndex", 0)
  val offset =
    rows
      .filter { it.getJSONObject("proposal").optInt("sourceAccountIndex", 0) < index }
      .fold(java.math.BigInteger.ZERO) { total, row ->
        total + row.getJSONObject("settlement").getString("creditedAtoms").toBigInteger()
      }
  check(offset.signum() >= 0 && offset.bitLength() <= 256)
  return offset.toString()
}

internal fun nativePayoutAmount(
  credited: String,
  offset: String,
  leg: String,
  distribution: JSONObject? = null,
): String {
  if (distribution != null)
    return distributionAmounts(distribution, credited.toBigInteger(), offset.toBigInteger())[
        distributionSlot(leg, distribution)]
      .toString()
  val credit = credited.toBigInteger()
  val prefix = offset.toBigInteger()
  val total = prefix + credit
  check(
    credit.signum() > 0 &&
      prefix.signum() >= 0 &&
      total.bitLength() <= 256 &&
      leg in setOf("hold", "invest")
  )
  val hold = total / java.math.BigInteger.TEN - prefix / java.math.BigInteger.TEN
  return (if (leg == "hold") hold else credit - hold).also { check(it.signum() > 0) }.toString()
}

private fun payoutSignedData(s: NativeSignedEarnPayout): String =
  "{\"standard\":\"erc191\",\"payload\":${JSONObject.quote(s.payload)},\"signature\":${JSONObject.quote(s.signature)}}"

internal class EarnPayoutEngine(
  private val store: WalletStore,
  val journal: EarnPayoutJournal,
  private val destinationRpc: TransferRpc,
  private val gateway: PayoutGateway = NativePayoutGateway(),
  private val sourceReader: suspend (String, Int) -> JSONObject,
  private val readAuth: suspend () -> EarnReadAuthentication,
  private val signerFactory: (String, ByteArray) -> NativePayoutSigner = ::RustPayoutSigner,
  private val identities: (WalletRecord, String) -> PayoutIdentities = ::payoutIdentities,
  private val now: () -> Long = System::currentTimeMillis,
  private val eventTopic: (String) -> String = ::earnEventTopic,
  private val sourceBatchReader: (suspend (String) -> List<JSONObject>)? = null,
  private val sourceIdentity: (WalletRecord, Int) -> String = ::publicAccountAddress,
  private val privateFundingOffset: () -> String = { "0" },
) : AutoCloseable {
  private var signer: NativePayoutSigner? = null
  private var displayed: EarnPayoutReview? = null

  private fun walletCheck(
    record: WalletRecord,
    proposal: JSONObject? = null,
    recoveryRead: Boolean = false,
  ) {
    if (recoveryRead)
      check(record.id == journal.walletId && record.verified && record.earnChain in setOf(1, 4663))
    else requireSponsoredWallet(record, journal.walletId)
    check(record.journalId == journal.generation)
    if (proposal != null) {
      check(proposal.getInt("profileChainId") == record.earnChain)
      requireActiveEarnCycle(record, proposal)
      requireSavedDistribution(record, proposal)
      val pair = identities(record, proposal.getString("leg"))
      check(
        proposal.getString("expectedSigner").equals(pair.confidential, true) &&
          proposal.getString("expectedRecipient").equals(pair.recipient, true)
      )
    }
  }

  suspend fun create(request: Map<String, Any?>): JSONObject {
    check(
      request.keys.containsAll(setOf("walletId", "sourceOperationId", "sourceRevision", "leg")) &&
        request.keys.all {
          it in setOf("walletId", "sourceOperationId", "sourceRevision", "leg", "cycleIndex")
        } &&
        request["walletId"] == journal.walletId
    )
    val id = request["sourceOperationId"] as? String ?: error("Missing funding operation")
    check(id.matches(Regex("[-a-zA-Z0-9_]{1,128}")))
    val revision = request["sourceRevision"] as? Number ?: error("Missing source revision")
    check(revision.toDouble() == revision.toInt().toDouble() && revision.toInt() > 0)
    val leg = request["leg"] as? String ?: error("Missing payout role")
    val distribution =
      store.load().use { record ->
        walletCheck(record)
        check(leg in cyclePayoutLegs(record))
        savedCycleDistribution(record)
      }
    val pair =
      store.load().use { record ->
        walletCheck(record)
        identities(record, leg)
      }
    // This native callback rejects the caller revision before canonical receipt reconciliation.
    // Reconciliation may increment the source journal revision while preserving its funding tuple.
    val sourceOp = sourceReader(id, revision.toInt())
    check(sourceOp.getString("operationId") == id)
    val sourceProposal = sourceOp.getJSONObject("proposal")
    val selectedIndex = sourceProposal.optInt("sourceAccountIndex", 0)
    val cycle = sourceProposal.optInt("cycleIndex", 0)
    if (request.containsKey("cycleIndex"))
      check((request["cycleIndex"] as? Number)?.toDouble() == cycle.toDouble())
    val source = validatedSource(sourceOp, leg)
    val offset = batchOffset(sourceOp, leg)
    val auth = readAuth()
    currentCoroutineContext().ensureActive()
    val sourceRequest =
      store.load().use { record ->
        walletCheck(record)
        JSONObject()
          .put("operationId", source.getString("operationId"))
          .put("revision", source.getLong("revision"))
          .put("profileChainId", record.earnChain)
          .put("leg", leg)
          .put("recipient", pair.recipient)
          .put("source", source)
          .put("sourceAccountIndex", selectedIndex)
          .put("cycleIndex", cycle)
          .put("splitOffsetAtoms", offset)
          .also { if (distribution != null) it.put("distribution", distribution) }
      }
    val prepared =
      gateway.prepare(
        JSONObject(sourceRequest.toString())
          .put(
            "signedData",
            JSONObject()
              .put("standard", "erc191")
              .put("payload", auth.payload)
              .put("signature", auth.signature),
          )
      )

    val q = prepared.quote
    val c = prepared.credit
    val credited = sourceOp.getJSONObject("settlement").getString("creditedAtoms")
    check(
      c.operationId == id &&
        c.revision == source.getLong("revision").toULong() &&
        c.creditedAtoms == credited &&
        c.sourceTransactionHash.equals(source.getString("transactionHash"), true) &&
        c.sourceQuoteId == source.getString("quoteId") &&
        c.sourceOwner.equals(source.getString("sourceOwner"), true)
    )
    check(
      q.operationId == id &&
        q.revision == c.revision &&
        q.leg == leg &&
        q.destinationRecipient.equals(pair.recipient, true) &&
        q.confidentialAccount.equals(pair.confidential, true)
    )
    val amount = nativePayoutAmount(credited, offset, leg, distribution)
    check(q.amountAtoms == amount)
    val p =
      JSONObject()
        .put("kind", "confidentialPayout")
        .put("operationId", id)
        .put("revision", c.revision.toLong())
        .put("profileChainId", q.profileChainId.toLong())
        .put("leg", leg)
        .put("sourceAccountIndex", selectedIndex)
        .put("cycleIndex", cycle)
        .put("splitOffsetAtoms", offset)
        .put("sourceOwner", source.getString("sourceOwner"))
        .put("expectedSigner", pair.confidential)
        .put("expectedRecipient", pair.recipient)
        .put("sourceQuoteId", c.sourceQuoteId)
        .put("sourceTransactionHash", c.sourceTransactionHash)
        .put("sourceHistoryId", c.sourceHistoryId)
        .put("creditedAtoms", credited)
        .put("amountAtoms", amount.toString())
        .put("quoteId", q.quoteId)
        .put("minimumDestinationAtoms", q.minimumDestinationAtoms)
        .put("deadlineMs", q.deadlineMs.toLong())
    if (distribution != null) p.put("distribution", distribution)
    if (sourceProposal.has("fundingBatchId"))
      p.put("fundingBatchId", sourceProposal.getString("fundingBatchId"))
        .put("fundingBatchSize", sourceProposal.getInt("fundingBatchSize"))
    store.load().use { walletCheck(it, p) }
    currentCoroutineContext().ensureActive()
    val reservation =
      "0x" +
        ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    return journal.create(
      p,
      prepared.text,
      prepared.nonce,
      q.payloadHash,
      reservation,
      sourceRequest.toString(),
    )
  }

  private fun validatedSource(row: JSONObject, leg: String): JSONObject =
    store.load().use { record ->
      walletCheck(record)
      val p = row.getJSONObject("proposal")
      requireActiveEarnCycle(record, p)
      val pair =
        identities(record, leg)
          .copy(source = sourceIdentity(record, p.optInt("sourceAccountIndex", 0)))
      nativePayoutSource(row, row.getInt("revision"), pair, record.earnChain)
    }

  private suspend fun batchOffset(row: JSONObject, leg: String): String {
    val rows =
      if (row.getJSONObject("proposal").has("fundingBatchId"))
        checkNotNull(sourceBatchReader) { "Native funding batch membership is unavailable" }(
          row.getString("operationId")
        )
      else listOf(row)
    return (depositAtoms(nativePayoutBatchOffset(row, rows) { validatedSource(it, leg) }) +
        depositAtoms(privateFundingOffset()))
      .toString()
  }

  private suspend fun checkSavedBatch(op: JSONObject) {
    val p = op.getJSONObject("proposal")
    if (!p.has("fundingBatchId")) return
    val rows = checkNotNull(sourceBatchReader)(p.getString("operationId"))
    val source = rows.single { it.getString("operationId") == p.getString("operationId") }
    check(
      (depositAtoms(
          nativePayoutBatchOffset(source, rows) { validatedSource(it, p.getString("leg")) }
        ) + depositAtoms(privateFundingOffset()))
        .toString() == p.getString("splitOffsetAtoms")
    )
    check(
      source.getJSONObject("settlement").getString("creditedAtoms") == p.getString("creditedAtoms")
    )
    val s = source.getJSONObject("proposal")
    check(
      s.getString("fundingBatchId") == p.getString("fundingBatchId") &&
        s.getInt("fundingBatchSize") == p.getInt("fundingBatchSize") &&
        s.optInt("sourceAccountIndex", 0) == p.getInt("sourceAccountIndex")
    )
    currentCoroutineContext().ensureActive()
    store.load().use { walletCheck(it, p) }
  }

  suspend fun prepare(id: String, revision: Int): EarnPayoutReview {
    var op = journal.get(id)
    var p = op.getJSONObject("proposal")
    check(op.getInt("revision") == revision)
    store.load().use { walletCheck(it, p) }
    check(op.getString("status") != "paid" && !op.optBoolean("signingAuthorizationPending", false))
    if (op.has("signedData")) {
      check(op.getString("status") == "submissionUnknown" && p.getLong("deadlineMs") > now())
      return EarnPayoutReview(
          id,
          revision,
          p.getLong("revision").toULong(),
          op.getString("reviewHash"),
          "Retry only the exact saved payout bytes and nonce. No new allocation or signature.\n${op.getString("review")}",
          true,
        )
        .also { displayed = it }
    }
    checkSavedBatch(op)
    val saved = gateway.decode(op.getString("preparedText"), false)
    if (
      op.getString("status") == "cancelled" ||
        saved.credit.expiresAtMs.toLong() <= now() ||
        now() - saved.credit.observedAtMs.toLong() > 60000 ||
        saved.quote.expiresAtMs.toLong() <= now()
    ) {
      op = refreshUnsigned(id, revision)
      p = op.getJSONObject("proposal")
    }
    val currentRevision = op.getInt("revision")
    val prepared = gateway.decode(op.getString("preparedText"))
    val evidence = journal.evidence(id, op.getString("leg"), currentRevision, now())
    signer?.close()
    signer =
      store.load().use { record ->
        walletCheck(record, p)
        signerFactory(p.toString(), record.entropy)
      }
    val core = checkNotNull(signer)
    val text =
      core.prepare(
        p.getLong("revision").toULong(),
        prepared.credit,
        prepared.quote,
        prepared.payload,
        evidence,
      )
    val hash = core.reviewHash()
    return EarnPayoutReview(id, currentRevision, p.getLong("revision").toULong(), hash, text, false)
      .also { displayed = it }
  }

  suspend fun refreshUnsigned(id: String, revision: Int): JSONObject {
    val op = journal.get(id)
    val p = op.getJSONObject("proposal")
    check(
      op.getInt("revision") == revision &&
        !op.has("signedData") &&
        !op.optBoolean("signingAuthorizationPending", false) &&
        op.getString("status") in setOf("planned", "cancelled")
    )
    store.load().use { walletCheck(it, p) }
    checkSavedBatch(op)
    val old = gateway.decode(op.getString("preparedText"), false)
    val expired = old.quote.expiresAtMs.toLong() <= now() || p.getLong("deadlineMs") <= now()
    val auth = readAuth()
    currentCoroutineContext().ensureActive()
    val request =
      JSONObject(op.getString("sourceRequest"))
        .put("recoveryEnvelope", old.recoveryEnvelope)
        .put("replaceExpiredUnsigned", expired)
        .put(
          "signedData",
          JSONObject()
            .put("standard", "erc191")
            .put("payload", auth.payload)
            .put("signature", auth.signature),
        )
    val fresh = gateway.prepare(request)
    val c = fresh.credit
    val q = fresh.quote
    check(
      c.operationId == p.getString("operationId") &&
        c.revision == p.getLong("revision").toULong() &&
        c.creditedAtoms == p.getString("creditedAtoms") &&
        c.sourceQuoteId == p.getString("sourceQuoteId") &&
        c.sourceTransactionHash.equals(p.getString("sourceTransactionHash"), true) &&
        c.sourceHistoryId == p.getString("sourceHistoryId") &&
        c.sourceOwner.equals(
          p.optString(
            "sourceOwner",
            JSONObject(op.getString("sourceRequest"))
              .getJSONObject("source")
              .getString("sourceOwner"),
          ),
          true,
        )
    )
    check(
      q.operationId == c.operationId &&
        q.revision == c.revision &&
        q.leg == op.getString("leg") &&
        q.amountAtoms == p.getString("amountAtoms") &&
        q.confidentialAccount.equals(p.getString("expectedSigner"), true) &&
        q.destinationRecipient.equals(p.getString("expectedRecipient"), true)
    )
    if (!expired)
      check(
        q.quoteId == old.quote.quoteId &&
          fresh.payload == old.payload &&
          fresh.nonce == old.nonce &&
          q.deadlineMs == old.quote.deadlineMs &&
          q.minimumDestinationAtoms == old.quote.minimumDestinationAtoms
      )
    else check(q.quoteId != old.quote.quoteId && fresh.nonce != old.nonce)
    val proposal =
      JSONObject(p.toString())
        .put("quoteId", q.quoteId)
        .put("deadlineMs", q.deadlineMs.toLong())
        .put("minimumDestinationAtoms", q.minimumDestinationAtoms)
    currentCoroutineContext().ensureActive()
    store.load().use { walletCheck(it, proposal) }
    // The synchronized unsigned/revision guard runs again after network and account auth.
    signer?.close()
    signer = null
    displayed = null
    return journal.refreshUnsigned(id, revision, proposal, fresh.text, fresh.nonce, q.payloadHash)
  }

  suspend fun execute(review: EarnPayoutReview, authority: () -> Unit): JSONObject {
    check(displayed == review)
    var op = journal.get(review.id)
    val p = op.getJSONObject("proposal")
    val leg = op.getString("leg")
    check(op.getInt("revision") == review.revision && p.getLong("deadlineMs") > now())
    authority()
    currentCoroutineContext().ensureActive()
    store.load().use { walletCheck(it, p) }
    if (!review.retry) {
      checkSavedBatch(op)
      val core = checkNotNull(signer)
      val evidence = journal.evidence(review.id, leg, review.revision, now())
      check(core.reviewHash() == review.hash)
      val boundedPrepared = gateway.decode(op.getString("preparedText"), false)
      requireDistributionPayoutSigningStorage(op, boundedPrepared.payload, review.text, review.hash)
      authority()
      core.approve(review.coreRevision, review.hash)
      val signed = core.sign(review.coreRevision, evidence)
      check(
        signed.operationId == p.getString("operationId") &&
          signed.revision == review.coreRevision &&
          signed.leg == leg &&
          signed.quoteId == p.getString("quoteId") &&
          signed.payloadHash == op.getString("payloadHash") &&
          signed.reviewHash == review.hash
      )
      val prepared = gateway.decode(op.getString("preparedText"), false)
      check(
        signed.standard == "erc191" &&
          signed.payload == prepared.payload &&
          signed.nonce == op.getString("nonce")
      )
      // No cancellation check between signing and the synchronous durable write.
      op =
        journal.saveSigned(
          review.id,
          leg,
          review.revision,
          payoutSignedData(signed),
          review.text,
          review.hash,
        )
      signer?.close()
      signer = null
    } else {
      check(op.has("signedData") && op.getString("status") == "submissionUnknown")
      op = journal.update(review.id, leg, review.revision) { it.put("status", "submissionUnknown") }
    }
    authority()
    currentCoroutineContext().ensureActive()
    store.load().use { walletCheck(it, p) }
    val response = gateway.submit(submission(op, JSONObject(op.getString("signedData"))))
    if (op.has("distributionStorageVersion"))
      requireDistributionPayoutResponseStorage(p, "submission", response)
    validateResponseIdentity(response, p)
    check(response.getString("status") in setOf("submitted", "submissionUnknown"))
    op =
      journal.update(review.id, leg, op.getInt("revision")) {
        it
          .put("status", response.getString("status"))
          .put("submission", JSONObject(response.toString()))
      }
    displayed = null
    return op
  }

  private fun submission(op: JSONObject, signedData: JSONObject): JSONObject {
    val p = op.getJSONObject("proposal")
    val envelope = gateway.decode(op.getString("preparedText"), false).recoveryEnvelope
    return JSONObject()
      .put("recoveryEnvelope", envelope)
      .put("operationId", p.getString("operationId"))
      .put("revision", p.getLong("revision"))
      .put("leg", p.getString("leg"))
      .put("quoteId", p.getString("quoteId"))
      .put("signedData", signedData)
      .also { if (p.has("distribution")) it.put("distribution", p.getJSONObject("distribution")) }
  }

  private fun validateResponseIdentity(row: JSONObject, p: JSONObject) {
    check(
      row.getString("operationId") == p.getString("operationId") &&
        row.getLong("revision") == p.getLong("revision") &&
        row.getString("leg") == p.getString("leg") &&
        row.getString("quoteId").equals(p.getString("quoteId"), true)
    )
  }

  suspend fun reconcile(id: String, revision: Int): JSONObject {
    val op = journal.get(id)
    check(op.getInt("revision") == revision && op.has("signedData"))
    val p = op.getJSONObject("proposal")
    store.load().use { walletCheck(it, p, recoveryRead = true) }
    val auth = readAuth()
    currentCoroutineContext().ensureActive()
    val signedData =
      JSONObject()
        .put("standard", "erc191")
        .put("payload", auth.payload)
        .put("signature", auth.signature)
    val request =
      submission(op, signedData).put("submittedIntent", JSONObject(op.getString("signedData")))
    val privateQuote = gateway.decode(op.getString("preparedText"), false).reference
    var row = gateway.settlement(request)
    validateSettlement(row, p, op.has("distributionStorageVersion"))
    var nextScan: String? = null
    if (row.getString("status") == "awaitingDestinationConfirmation") {
      val scan =
        scanNativePayoutTransfers(
          destinationRpc,
          privateQuote,
          op.optString(
            "nextScanBlock",
            (privateQuote.getString("referenceBlock").toBigInteger() + java.math.BigInteger.ONE)
              .toString(),
          ),
          eventTopic,
        )
      nextScan = scan.nextBlock
      if (scan.transactionHash != null) {
        request.put("destinationTransactionHash", scan.transactionHash)
        row = gateway.settlement(request)
        validateSettlement(row, p, op.has("distributionStorageVersion"))
      }
    }
    if (row.getString("status") == "delivered") {
      val receipt =
        confirmNativePayoutReceipt(
          destinationRpc,
          privateQuote,
          row.getString("destinationTransactionHash"),
          row.getString("receivedAtoms"),
          eventTopic,
        )
      if (op.has("distributionStorageVersion"))
        requireDistributionPayoutResponseStorage(p, "receipt", receipt)
      requireUnusedPayoutReceipt(journal.all(), op, receipt.getString("transactionHash"))
      return journal.update(id, op.getString("leg"), revision) {
        it
          .put("status", "paid")
          .put("receivedAtoms", row.getString("receivedAtoms"))
          .put("destinationTransactionHash", receipt.getString("transactionHash"))
          .put("settlement", JSONObject(row.toString()))
          .put("receipt", receipt)
      }
    }
    return journal.update(id, op.getString("leg"), revision) {
      it
        .put(
          "status",
          if (
            row.getString("status") == "awaitingSettlement" &&
              op.getString("status") == "submissionUnknown"
          )
            "submissionUnknown"
          else row.getString("status"),
        )
        .put("settlement", JSONObject(row.toString()))
      if (nextScan != null) it.put("nextScanBlock", nextScan)
    }
  }

  private fun validateSettlement(row: JSONObject, p: JSONObject, bounded: Boolean) {
    if (bounded) requireDistributionPayoutResponseStorage(p, "settlement", row)
    validateResponseIdentity(row, p)
    earnHash(row.getString("nativeTlsBodyHash"))
    check(
      row.getBoolean("authenticated") &&
        row.getBoolean("operationScoped") &&
        now() - row.getLong("observedAtMs") in 0L..60000L &&
        row.getLong("expiresAtMs") > now()
    )
    check(
      row.getString("confidentialAccount").equals(p.getString("expectedSigner"), true) &&
        row.getLong("destinationChainId") == p.getLong("profileChainId") &&
        row.getString("destinationRecipient").equals(p.getString("expectedRecipient"), true)
    )
    check(
      row
        .getString("destinationToken")
        .equals(if (p.getInt("profileChainId") == 1) ETH_EARN_USDC else HOOD_EARN_USDG, true) &&
        row.getString("minimumDestinationAtoms") == p.getString("minimumDestinationAtoms")
    )
    val received = row.getString("receivedAtoms")
    earnNumberWord(received)
    when (row.getString("status")) {
      "delivered" ->
        check(received.toBigInteger() >= p.getString("minimumDestinationAtoms").toBigInteger())
      "awaitingSettlement",
      "awaitingDestinationConfirmation" -> check(received == "0")
      else -> error("Unsupported payout settlement")
    }
  }

  override fun close() {
    signer?.close()
    signer = null
    displayed = null
  }
}

internal fun requireUnusedPayoutReceipt(rows: List<JSONObject>, current: JSONObject, hash: String) {
  val recipient = current.getJSONObject("proposal").getString("expectedRecipient")
  check(
    rows.none { row ->
      row.getString("operationId") != current.getString("operationId") &&
        row.optString("destinationTransactionHash").equals(hash, true) &&
        row.getJSONObject("proposal").getString("expectedRecipient").equals(recipient, true)
    }
  ) {
    "Payout receipt already attributed"
  }
}
