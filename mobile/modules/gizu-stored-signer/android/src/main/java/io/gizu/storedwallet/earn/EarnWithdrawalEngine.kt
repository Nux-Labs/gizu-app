package io.gizu.storedwallet

import java.security.SecureRandom
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.*

internal interface NativeWithdrawalSigner : AutoCloseable {
  fun prepare(
    revision: ULong,
    credit: NativeEarnReturnedCreditProof,
    quote: NativeEarnWithdrawalQuoteBinding,
    payload: String,
    journal: NativeEarnPayoutJournalEvidence,
  ): String

  fun reviewHash(): String

  fun approve(revision: ULong, hash: String)

  fun sign(revision: ULong, journal: NativeEarnPayoutJournalEvidence): NativeSignedEarnPayout
}

private class RustWithdrawalSigner(p: String, entropy: ByteArray, registry: String) :
  NativeWithdrawalSigner {
  private val core = ConfidentialEarnWithdrawalOperation(p, entropy, registry)

  override fun prepare(
    revision: ULong,
    credit: NativeEarnReturnedCreditProof,
    quote: NativeEarnWithdrawalQuoteBinding,
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

private fun withdrawalIdentities(record: WalletRecord, index: Int): PayoutIdentities {
  check(index >= 3)
  val cycles = JSONArray(record.earnCycles)
  val cycle =
    (0 until cycles.length()).map(cycles::getJSONObject).single {
      it.getInt("cycleIndex") == record.earnCycleIndex
    }
  check(cycle.getInt("withdrawalIndex") == index)
  return PayoutIdentities(
    cycleAddresses(record)[1],
    cycleConfidential(record),
    publicAccountAddress(record, index),
  )
}

internal fun nativeWithdrawalSource(
  op: JSONObject,
  revision: Int,
  invest: String,
  confidential: String,
  profile: Int,
  cycle: Int,
): JSONObject {
  check(
    op.getInt("revision") == revision &&
      op.getString("status") == "finalized" &&
      (op.has("signedUserOperation") || op.has("raw"))
  )
  val p = op.getJSONObject("proposal")
  val kind = p.getString("kind")
  check(kind in setOf("returnUsdc", "returnEth", "hoodTokenReturn"))
  check(
    p.getInt("chainId") == profile &&
      p.optInt("profileChainId", p.getInt("chainId")) == profile &&
      p.optInt("cycleIndex", 0) == cycle
  )
  check(
    p.getString("expectedFrom").equals(invest, true) &&
      p.getString("confidentialAccount").equals(confidential, true)
  )
  val source = sponsoredSettlementExpected(op)
  val settlement = op.getJSONObject("settlement")
  validateSponsoredSettlement(
    settlement.toString(),
    JSONObject(source.toString()).put("revision", settlement.getInt("revision")),
    settlement.getLong("timestampMs"),
  )
  check(settlement.getString("status") == "credited" && settlement.getInt("revision") < revision)
  val expected =
    when (kind) {
      "returnEth" -> ETH_NATIVE_ORIGIN_ASSET
      "hoodTokenReturn" -> EARN_HOOD_ASSET
      else -> ETH_USDC_ORIGIN_ASSET
    }
  check(
    source.getString("originAsset") == expected && (kind == "hoodTokenReturn") == (profile == 4663)
  )
  return source
    .put("revision", p.getLong("revision"))
    .put(
      "quoteId",
      op.getJSONObject("stateBinding").getJSONObject("routeProof").getString("quoteId"),
    )
    .put("routeKind", kind)
}

private fun withdrawalSignedData(s: NativeSignedEarnPayout) =
  "{\"standard\":\"erc191\",\"payload\":${JSONObject.quote(s.payload)},\"signature\":${JSONObject.quote(s.signature)}}"

internal class EarnWithdrawalEngine(
  private val store: WalletStore,
  val journal: EarnWithdrawalJournal,
  private val destinationRpc: TransferRpc,
  private val gateway: WithdrawalGateway = NativeWithdrawalGateway(),
  private val sourceReader: suspend (String, Int) -> JSONObject,
  private val readAuth: suspend () -> EarnReadAuthentication,
  private val signerFactory: (String, ByteArray, String) -> NativeWithdrawalSigner =
    ::RustWithdrawalSigner,
  private val identities: (WalletRecord, Int) -> PayoutIdentities = ::withdrawalIdentities,
  private val now: () -> Long = System::currentTimeMillis,
  private val eventTopic: (String) -> String = ::earnEventTopic,
) : AutoCloseable {
  private var signer: NativeWithdrawalSigner? = null
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
      val pair = identities(record, proposal.getInt("recipientIndex"))
      check(
        proposal.getString("expectedSigner").equals(pair.confidential, true) &&
          proposal.getString("expectedRecipient").equals(pair.recipient, true)
      )
    }
  }

  suspend fun create(request: Map<String, Any?>): JSONObject {
    check(
      request.keys == setOf("walletId", "returnOperationId", "revision") &&
        request["walletId"] == journal.walletId
    )
    val id = request["returnOperationId"] as? String ?: error("Missing returned child")
    check(id.matches(Regex("[-a-zA-Z0-9_]{1,128}")))
    val requested = request["revision"] as? Number ?: error("Missing returned revision")
    check(requested.toDouble() == requested.toInt().toDouble() && requested.toInt() > 0)
    val returned = sourceReader(id, requested.toInt())
    check(returned.getString("operationId") == id)
    val recipientIndex =
      store.load().use { record ->
        walletCheck(record)
        nativeWithdrawalSource(
          returned,
          returned.getInt("revision"),
          cycleAddresses(record)[1],
          cycleConfidential(record),
          record.earnChain,
          record.earnCycleIndex,
        )
        store.reserveEarnWithdrawal(record)
      }
    val pair =
      store.load().use { record ->
        walletCheck(record)
        identities(record, recipientIndex)
      }
    val source =
      store.load().use { record ->
        walletCheck(record)
        nativeWithdrawalSource(
          returned,
          returned.getInt("revision"),
          pair.source,
          pair.confidential,
          record.earnChain,
          record.earnCycleIndex,
        )
      }
    val operation = "withdraw_" + java.util.UUID.randomUUID().toString().replace("-", "")
    val sourceRequest =
      store.load().use { record ->
        walletCheck(record)
        JSONObject()
          .put("operationId", operation)
          .put("revision", 1)
          .put("profileChainId", record.earnChain)
          .put("cycleIndex", record.earnCycleIndex)
          .put("recipient", pair.recipient)
          .put("source", source)
      }
    val auth = readAuth()
    currentCoroutineContext().ensureActive()
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
    val c = prepared.credit.credit
    val q = prepared.quote.quote
    val credited = returned.getJSONObject("settlement").getString("creditedAtoms")
    check(
      prepared.credit.returnOperationId == id &&
        c.operationId == operation &&
        c.revision == 1uL &&
        c.creditedAtoms == credited &&
        c.sourceOwner.equals(pair.source, true) &&
        c.confidentialAccount.equals(pair.confidential, true) &&
        c.sourceTransactionHash.equals(source.getString("transactionHash"), true) &&
        c.sourceQuoteId == source.getString("quoteId")
    )
    check(
      q.operationId == operation &&
        q.revision == 1uL &&
        q.leg == "withdrawal" &&
        q.amountAtoms == credited &&
        q.destinationRecipient.equals(pair.recipient, true) &&
        q.confidentialAccount.equals(pair.confidential, true)
    )
    val p =
      JSONObject()
        .put("kind", "confidentialWithdrawal")
        .put("operationId", operation)
        .put("revision", 1)
        .put("profileChainId", q.profileChainId.toLong())
        .put("cycleIndex", sourceRequest.getInt("cycleIndex"))
        .put("recipientIndex", recipientIndex)
        .put("expectedSigner", pair.confidential)
        .put("expectedRecipient", pair.recipient)
        .put("returnOperationId", id)
        .put("returnQuoteId", c.sourceQuoteId)
        .put("returnTransactionHash", c.sourceTransactionHash)
        .put("returnHistoryId", c.sourceHistoryId)
        .put("creditedAtoms", credited)
        .put("amountAtoms", credited)
        .put("quoteId", q.quoteId)
        .put("minimumDestinationAtoms", q.minimumDestinationAtoms)
        .put("deadlineMs", q.deadlineMs.toLong())
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
    val saved = gateway.decode(op.getString("preparedText"), false)
    if (
      op.getString("status") == "cancelled" ||
        saved.credit.credit.expiresAtMs.toLong() <= now() ||
        now() - saved.credit.credit.observedAtMs.toLong() > 60000 ||
        saved.quote.quote.expiresAtMs.toLong() <= now()
    ) {
      op = refreshUnsigned(id, revision)
      p = op.getJSONObject("proposal")
    }
    val currentRevision = op.getInt("revision")
    val prepared = gateway.decode(op.getString("preparedText"))
    val evidence = journal.evidence(id, "withdrawal", currentRevision, now())
    signer?.close()
    signer =
      store.load().use { record ->
        walletCheck(record, p)
        signerFactory(p.toString(), record.entropy, record.roleRegistry)
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
    val old = gateway.decode(op.getString("preparedText"), false)
    val expired = old.quote.quote.expiresAtMs.toLong() <= now() || p.getLong("deadlineMs") <= now()
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
    val c = fresh.credit.credit
    val q = fresh.quote.quote
    check(fresh.credit.returnOperationId == p.getString("returnOperationId"))
    check(
      c.operationId == p.getString("operationId") &&
        c.revision == p.getLong("revision").toULong() &&
        c.creditedAtoms == p.getString("creditedAtoms") &&
        c.sourceQuoteId == p.getString("returnQuoteId") &&
        c.sourceTransactionHash.equals(p.getString("returnTransactionHash"), true) &&
        c.sourceHistoryId == p.getString("returnHistoryId") &&
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
        q.leg == "withdrawal" &&
        q.amountAtoms == p.getString("amountAtoms") &&
        q.confidentialAccount.equals(p.getString("expectedSigner"), true) &&
        q.destinationRecipient.equals(p.getString("expectedRecipient"), true)
    )
    if (!expired)
      check(
        q.quoteId == old.quote.quote.quoteId &&
          fresh.payload == old.payload &&
          fresh.nonce == old.nonce &&
          q.deadlineMs == old.quote.quote.deadlineMs &&
          q.minimumDestinationAtoms == old.quote.quote.minimumDestinationAtoms
      )
    else check(q.quoteId != old.quote.quote.quoteId && fresh.nonce != old.nonce)
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
    val leg = "withdrawal"
    check(op.getInt("revision") == review.revision && p.getLong("deadlineMs") > now())
    authority()
    currentCoroutineContext().ensureActive()
    store.load().use { walletCheck(it, p) }
    if (!review.retry) {
      val core = checkNotNull(signer)
      val evidence = journal.evidence(review.id, leg, review.revision, now())
      check(core.reviewHash() == review.hash)
      authority()
      core.approve(review.coreRevision, review.hash)
      op =
        journal.update(review.id, leg, review.revision) {
          check(!it.has("signedData") && !it.optBoolean("signingAuthorizationPending", false))
          it.put("signingAuthorizationPending", true)
        }
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
          op.getInt("revision"),
          withdrawalSignedData(signed),
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
      .put("leg", "withdrawal")
      .put("quoteId", p.getString("quoteId"))
      .put("signedData", signedData)
  }

  private fun validateResponseIdentity(row: JSONObject, p: JSONObject) {
    check(
      row.getString("operationId") == p.getString("operationId") &&
        row.getLong("revision") == p.getLong("revision") &&
        row.getString("leg") == "withdrawal" &&
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
    validateSettlement(row, p)
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
        validateSettlement(row, p)
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
      return journal.update(id, "withdrawal", revision) {
        it
          .put("status", "paid")
          .put("receivedAtoms", row.getString("receivedAtoms"))
          .put("destinationTransactionHash", receipt.getString("transactionHash"))
          .put("settlement", JSONObject(row.toString()))
          .put("receipt", receipt)
      }
    }
    return journal.update(id, "withdrawal", revision) {
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

  private fun validateSettlement(row: JSONObject, p: JSONObject) {
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
        row.getLong("destinationChainId") == 143L &&
        row.getString("destinationRecipient").equals(p.getString("expectedRecipient"), true)
    )
    check(
      row.getString("destinationToken").equals(MONAD_EARN_USDC, true) &&
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
