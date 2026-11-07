package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import uniffi.gizu_stored_signer_core.*

class EarnPayoutEngineTest {
  private val f = EarnPayoutFixtures
  private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

  private class File : WalletFile {
    var bytes: ByteArray? = null
    var fail = false

    override fun exists() = bytes != null

    override fun read() = bytes!!.copyOf()

    override fun write(bytes: ByteArray) {
      check(!fail)
      this.bytes = bytes.copyOf()
    }
  }

  private fun store(recovery: Boolean = false): WalletStore =
    WalletStore(
        File(),
        object : WalletKeys {
          override fun existing() = key

          override fun create() = key

          override fun reset() = key
        },
      )
      .also { s ->
        WalletRecord(
            f.wallet,
            StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
            ByteArray(32),
            true,
            f.wallet,
            earnChain = 1,
            earnRecoveryRequired = recovery,
          )
          .use(s::create)
      }

  private val rpc =
    object : TransferRpc {
      override suspend fun call(method: String, params: org.json.JSONArray): Any =
        error("No chain request expected: $method")
    }
  private var signed = 0
  private var sends = 0
  private var readAuthentications = 0
  private val bodies = mutableListOf<String>()
  private var privateRequest: JSONObject? = null

  private fun gateway(
    settlement: JSONObject? = null,
    clock: () -> Long = { f.now },
    prepared: () -> JSONObject = { f.prepared() },
  ): NativePayoutGateway =
    NativePayoutGateway(
      post = { endpoint, body ->
        when (endpoint) {
          "prepare" -> {
            privateRequest = JSONObject(body)
            prepared().toString()
          }
          "submit" -> {
            sends++
            bodies.add(body)
            error("lost submission response")
          }
          "settlement" -> checkNotNull(settlement).toString()
          else -> error("Unexpected $endpoint")
        }
      },
      bodyHash = { f.nativeHash },
      now = clock,
    )

  private inner class Signer(private val proposal: JSONObject) : NativePayoutSigner {
    private var payload = ""

    override fun prepare(
      revision: ULong,
      credit: NativeEarnSourceCreditProof,
      quote: NativeEarnPayoutQuoteBinding,
      payload: String,
      journal: NativeEarnPayoutJournalEvidence,
    ): String {
      this.payload = payload
      assertTrue(journal.nonceFirstSeen)
      assertTrue(journal.roleReserved)
      return "exact native payout review"
    }

    override fun reviewHash() = f.hash

    override fun approve(revision: ULong, hash: String) {}

    override fun sign(
      revision: ULong,
      journal: NativeEarnPayoutJournalEvidence,
    ): NativeSignedEarnPayout {
      signed++
      return NativeSignedEarnPayout(
        "funding1",
        revision,
        1uL,
        "hold",
        proposal.getString("quoteId"),
        "erc191",
        payload,
        "secp256k1:private-signature",
        f.nativeHash,
        f.hash,
        f.nonce,
      )
    }

    override fun close() {}
  }

  private fun engine(
    j: EarnPayoutJournal,
    recovery: Boolean = false,
    signer: (String, ByteArray) -> NativePayoutSigner = { p, _ -> Signer(JSONObject(p)) },
    settlement: JSONObject? = null,
    chainRpc: TransferRpc = rpc,
    clock: () -> Long = { f.now },
    prepared: () -> JSONObject = { f.prepared() },
    source: () -> JSONObject = { f.source() },
    batch: (suspend (String) -> List<JSONObject>)? = null,
  ) =
    EarnPayoutEngine(
      store(recovery),
      j,
      chainRpc,
      gateway(settlement, clock, prepared),
      sourceReader = { id, revision ->
        assertEquals("funding1", id)
        assertEquals(11, revision)
        source()
      },
      readAuth = {
        readAuthentications++
        EarnReadAuthentication("read-only empty intents", "native read signature")
      },
      signerFactory = signer,
      identities = { _, _ -> PayoutIdentities(f.owner, f.C, f.recipient) },
      sourceIdentity = { _, _ -> f.owner },
      sourceBatchReader = batch,
      now = clock,
      eventTopic = { f.nativeHash },
    )

  private fun request() =
    mapOf<String, Any?>(
      "walletId" to f.wallet,
      "sourceOperationId" to "funding1",
      "sourceRevision" to 11,
      "leg" to "hold",
    )

  @Test
  fun reservationBeforeReviewAndFailedSignatureCommitNeverSubmits() = runBlocking {
    val file = File()
    val j = EarnPayoutJournal(file, { key }, f.wallet, f.wallet)
    engine(j).use { e ->
      val op = e.create(request())
      val review = e.prepare(op.getString("operationId"), 1)
      assertEquals(0, signed)
      assertEquals(0, sends)
      assertEquals(f.recipient, privateRequest!!.getString("recipient"))
      assertFalse(privateRequest!!.has("destinations"))
      assertEquals(7, privateRequest!!.getJSONObject("source").getInt("revision"))
      file.fail = true
      try {
        e.execute(review) {}
        fail("Commit must fail")
      } catch (_: IllegalStateException) {}
    }
    assertEquals(0, sends)
    assertFalse(j.all()[0].has("signedData"))
  }

  @Test
  fun unknownSubmissionRestartsWithIdenticalSavedBytesAndNeverSignsAgain() = runBlocking {
    val j = EarnPayoutJournal(File(), { key }, f.wallet, f.wallet)
    var id = ""
    engine(j).use { e ->
      val op = e.create(request())
      id = op.getString("operationId")
      val review = e.prepare(id, 1)
      try {
        e.execute(review) {}
        fail("Lost send")
      } catch (_: IllegalStateException) {}
    }
    assertEquals(1, signed)
    assertEquals(1, sends)
    assertEquals("submissionUnknown", j.get(id).getString("status"))
    engine(j, signer = { _, _ -> error("A retry cannot reach the signer") }).use { e ->
      val review = e.prepare(id, j.get(id).getInt("revision"))
      assertTrue(review.retry)
      try {
        e.execute(review) { error("No passkey") }
        fail("Authority required")
      } catch (_: IllegalStateException) {}
      assertEquals(1, sends)
      try {
        e.execute(review) {}
        fail("Lost retry")
      } catch (_: IllegalStateException) {}
    }
    assertEquals(1, signed)
    assertEquals(2, sends)
    assertEquals(bodies[0], bodies[1])
    assertFalse(j.public(j.get(id)).toString().contains("private-signature"))
    assertEquals("unknown", j.public(j.get(id))["status"])
  }

  @Test
  fun recoveredOrUnverifiedWalletCannotReachPrivatePreparationOrSigner() = runBlocking {
    val j = EarnPayoutJournal(File(), { key }, f.wallet, f.wallet)
    engine(j, true).use { e ->
      try {
        e.create(request())
        fail("Restore gate")
      } catch (_: IllegalStateException) {}
    }
    assertNull(privateRequest)
    assertEquals(0, sends)
    assertEquals(0, signed)
  }

  @Test
  fun exactHistoryCreditRemainsAllocatableAboveTheOriginalQuoteEstimate() {
    val op = f.source()
    op
      .getJSONObject("stateBinding")
      .put("privateBaseline", JSONObject().put("baselineEnvelope", "baseline"))
      .getJSONObject("routeProof")
      .put("recoveryEnvelope", "quote")
      .put("maximumCreditAtoms", "1000000")
    op
      .getJSONObject("settlement")
      .put("verification", "operation-history-v1")
      .put("settlementEnvelope", "authenticated-source-credit")
    val source = nativePayoutSource(op, 11, PayoutIdentities(f.owner, f.C, f.recipient), 1)
    assertEquals("1000000", source.getString("maximumCreditAtoms"))
    assertEquals("authenticated-source-credit", source.getString("settlementEnvelope"))
    assertFalse(source.has("allowOperationHistory"))
  }

  @Test
  fun onlyActualAuthenticatedCreditFromMatchingNativeOriginIsAllocatable() {
    val pair = PayoutIdentities(f.owner, f.C, f.recipient)
    val source = nativePayoutSource(f.source(), 11, pair, 1)
    assertEquals(7, source.getInt("revision"))
    assertEquals("1000000", source.getString("minimumCreditAtoms"))
    for (variant in 0..5) {
      val op = f.source()
      when (variant) {
        0 -> op.put("revision", 12)
        1 -> op.put("status", "submitted")
        2 -> op.getJSONObject("proposal").put("expectedFrom", f.recipient)
        3 -> op.getJSONObject("settlement").put("authenticated", false)
        4 -> op.getJSONObject("settlement").put("creditedAtoms", "999999")
        5 -> op.getJSONObject("settlement").put("transactionHash", f.nativeHash)
      }
      try {
        nativePayoutSource(op, 11, pair, 1)
        fail("Invalid source $variant")
      } catch (_: IllegalStateException) {}
    }
  }

  private fun delivered() =
    JSONObject()
      .put("operationId", "funding1")
      .put("revision", 7)
      .put("leg", "hold")
      .put("quoteId", f.hash)
      .put("authenticated", true)
      .put("operationScoped", true)
      .put("observedAtMs", f.now)
      .put("expiresAtMs", f.now + 60000)
      .put("confidentialAccount", f.C)
      .put("destinationChainId", 1)
      .put("destinationRecipient", f.recipient)
      .put("destinationToken", ETH_EARN_USDC)
      .put("minimumDestinationAtoms", "1")
      .put("receivedAtoms", "100")
      .put("status", "delivered")
      .put("destinationTransactionHash", f.hash)

  private fun paidRpc(value: String = "100", finalized: String = "0xc"): TransferRpc =
    object : TransferRpc {
      override suspend fun call(method: String, params: org.json.JSONArray): Any =
        when (method) {
          "eth_chainId" -> "0x1"
          "eth_getBlockByNumber" ->
            when (params.getString(0)) {
              "0xa" -> JSONObject().put("number", "0xa").put("hash", f.hash)
              "0xb" ->
                JSONObject()
                  .put("number", "0xb")
                  .put("hash", f.nativeHash)
                  .put("timestamp", "0x3e8")
              "finalized" -> JSONObject().put("number", finalized).put("hash", f.hash)
              else -> error("Unexpected block")
            }
          "eth_getTransactionReceipt" ->
            JSONObject()
              .put("status", "0x1")
              .put("transactionHash", f.hash)
              .put("blockNumber", "0xb")
              .put("blockHash", f.nativeHash)
              .put(
                "logs",
                org.json
                  .JSONArray()
                  .put(
                    JSONObject()
                      .put("address", ETH_EARN_USDC)
                      .put(
                        "topics",
                        org.json
                          .JSONArray()
                          .put(f.nativeHash)
                          .put("0x" + "0".repeat(64))
                          .put("0x" + earnAddressWord(f.recipient)),
                      )
                      .put("data", "0x" + earnNumberWord(value))
                  ),
              )
          else -> error("Unexpected $method")
        }
    }

  @Test
  fun paidRequiresAuthenticatedHistoryAndNativeFinalExactReceipt() = runBlocking {
    val j = EarnPayoutJournal(File(), { key }, f.wallet, f.wallet)
    engine(j, settlement = delivered(), chainRpc = paidRpc()).use { e ->
      val op = e.create(request())
      val id = op.getString("operationId")
      try {
        e.execute(e.prepare(id, 1)) {}
        fail("Lost response")
      } catch (_: IllegalStateException) {}
      val paid = e.reconcile(id, j.get(id).getInt("revision"))
      val public = j.public(paid)
      assertEquals("paid", public["status"])
      assertEquals("100", public["receivedAtoms"])
      assertEquals(false, public["blocked"])
      assertEquals(f.hash, public["destinationTransactionHash"])
      assertFalse(public.toString().contains("private-signature"))
      assertEquals("funding1", public["sourceOperationId"])
      assertEquals(0, public["cycleIndex"])
      assertFalse(public.toString().contains(f.C))
    }
  }

  @Test
  fun untrustedHistoryWrongReceiptAndNonfinalDestinationKeepSignedChildLocked() = runBlocking {
    for (variant in 0..3) {
      val j = EarnPayoutJournal(File(), { key }, f.wallet, f.wallet)
      val history = delivered()
      if (variant == 0) history.put("authenticated", false)
      if (variant == 1) history.put("destinationRecipient", f.owner)
      engine(
          j,
          settlement = history,
          chainRpc = paidRpc(if (variant == 2) "99" else "100", if (variant == 3) "0xa" else "0xc"),
        )
        .use { e ->
          val op = e.create(request())
          val id = op.getString("operationId")
          try {
            e.execute(e.prepare(id, 1)) {}
          } catch (_: IllegalStateException) {}
          try {
            e.reconcile(id, j.get(id).getInt("revision"))
            fail("Unproven delivery $variant")
          } catch (_: IllegalStateException) {}
          assertEquals("unknown", j.public(j.get(id))["status"])
          assertEquals("0", j.public(j.get(id))["receivedAtoms"])
          assertTrue(j.get(id).has("signedData"))
        }
    }
  }

  @Test
  fun awaitingHistoryPreservesUnknownSameBytesRetryAndNeverInventsCredit() = runBlocking {
    val history = delivered().put("status", "awaitingSettlement").put("receivedAtoms", "0")
    val j = EarnPayoutJournal(File(), { key }, f.wallet, f.wallet)
    engine(j, settlement = history).use { e ->
      val op = e.create(request())
      val id = op.getString("operationId")
      try {
        e.execute(e.prepare(id, 1)) {}
      } catch (_: IllegalStateException) {}
      val saved = j.get(id).getString("signedData")
      val pending = e.reconcile(id, j.get(id).getInt("revision"))
      assertEquals(saved, pending.getString("signedData"))
      assertEquals("unknown", j.public(pending)["status"])
      assertTrue(e.prepare(id, pending.getInt("revision")).retry)
    }
  }

  private fun freshPrepared(clock: Long, replacement: Boolean): JSONObject {
    val row = f.prepared()
    row.getJSONObject("sourceCredit").put("observedAtMs", clock).put("expiresAtMs", clock + 60000)
    val q = row.getJSONObject("quote").put("observedAtMs", clock)
    if (replacement) {
      q.put("quoteId", f.nativeHash)
        .put("deadlineMs", clock + 240000)
        .put("expiresAtMs", clock + 240000)
        .put("depositId", "new-payout.near")
      val intent = row.getJSONObject("intent")
      val m = JSONObject(intent.getString("payload"))
      m.put("nonce", java.util.Base64.getEncoder().encodeToString(ByteArray(32) { 0x98.toByte() }))
        .put("deadline", java.time.Instant.ofEpochMilli(clock + 240000).toString())
      m.getJSONArray("intents").getJSONObject(0).put("receiver_id", "new-payout.near")
      intent.put("payload", m.toString())
    }
    return row.put("recoveryEnvelope", "v1.fresh-server-envelope")
  }

  @Test
  fun staleUnsignedProofRefreshesOnlySameChildAndUnexpiredExactPayload() = runBlocking {
    val j = EarnPayoutJournal(File(), { key }, f.wallet, f.wallet)
    var clock = f.now
    engine(
        j,
        clock = { clock },
        prepared = { if (clock == f.now) f.prepared() else freshPrepared(clock, false) },
      )
      .use { e ->
        val op = e.create(request())
        val id = op.getString("operationId")
        val old = j.get(id)
        clock += 61000
        val review = e.prepare(id, 1)
        val refreshed = j.get(id)
        assertEquals(id, refreshed.getString("operationId"))
        assertEquals(2, review.revision)
        assertEquals(1, refreshed.getJSONArray("nonceHistory").length())
        assertEquals(old.getString("nonce"), refreshed.getString("nonce"))
        assertEquals(old.getString("reservationId"), refreshed.getString("reservationId"))
        assertEquals("v1.private-server-envelope", privateRequest!!.getString("recoveryEnvelope"))
        assertFalse(privateRequest!!.getBoolean("replaceExpiredUnsigned"))
        assertEquals(true, j.public(refreshed)["canRefreshUnsigned"])
        assertEquals(0, signed)
        assertEquals(0, sends)
      }
  }

  @Test
  fun expiredUnsignedQuoteGetsNewNonceOnSameChildButCannotReuseAnyPriorNonce() = runBlocking {
    val j = EarnPayoutJournal(File(), { key }, f.wallet, f.wallet)
    var clock = f.now
    engine(
        j,
        clock = { clock },
        prepared = { if (clock == f.now) f.prepared() else freshPrepared(clock, true) },
      )
      .use { e ->
        val op = e.create(request())
        val id = op.getString("operationId")
        val originalNonce = j.get(id).getString("nonce")
        clock += 241000
        val review = e.prepare(id, 1)
        val updated = j.get(id)
        assertEquals(id, updated.getString("operationId"))
        assertEquals(2, review.revision)
        assertEquals(2, updated.getJSONArray("nonceHistory").length())
        assertNotEquals(originalNonce, updated.getString("nonce"))
        assertTrue(privateRequest!!.getBoolean("replaceExpiredUnsigned"))
        assertEquals("100000", updated.getJSONObject("proposal").getString("amountAtoms"))
        val malicious = JSONObject(updated.getJSONObject("proposal").toString())
        assertThrows(IllegalStateException::class.java) {
          j.refreshUnsigned(id, 2, malicious, "old nonce", originalNonce, f.nativeHash)
        }
        assertEquals(0, signed)
        assertEquals(0, sends)
      }
  }

  @Test
  fun concurrentSignedPersistenceWinsOverInFlightUnsignedRefresh() = runBlocking {
    val j = EarnPayoutJournal(File(), { key }, f.wallet, f.wallet)
    var clock = f.now
    var id = ""
    engine(
        j,
        clock = { clock },
        prepared = {
          if (clock == f.now) f.prepared()
          else {
            j.saveSigned(id, "hold", 1, "durable exact signed bytes", "review", f.hash)
            freshPrepared(clock, false)
          }
        },
      )
      .use { e ->
        id = e.create(request()).getString("operationId")
        clock += 61000
        try {
          e.prepare(id, 1)
          fail("Unsigned network result cannot replace signed child")
        } catch (_: IllegalStateException) {}
        assertEquals("durable exact signed bytes", j.get(id).getString("signedData"))
        assertEquals(f.nonce, j.get(id).getString("nonce"))
        assertEquals(false, j.public(j.get(id))["canRefreshUnsigned"])
        assertEquals(0, sends)
      }
  }

  @Test
  fun cancelledChildResumeRequiresFreshAccountProofAndFullTransferAuthority() = runBlocking {
    val j = EarnPayoutJournal(File(), { key }, f.wallet, f.wallet)
    var clock = f.now
    engine(
        j,
        clock = { clock },
        prepared = { if (clock == f.now) f.prepared() else freshPrepared(clock, false) },
      )
      .use { e ->
        val id = e.create(request()).getString("operationId")
        val old = j.get(id)
        j.cancelUnsigned(id, 1)
        clock++
        val review = e.prepare(id, 2)
        val recovered = j.get(id)
        assertEquals(2, readAuthentications)
        assertEquals(3, review.revision)
        assertEquals("planned", recovered.getString("status"))
        assertEquals(old.getString("reservationId"), recovered.getString("reservationId"))
        assertEquals(old.getString("nonce"), recovered.getString("nonce"))
        assertEquals(old.getString("operationId"), recovered.getString("operationId"))
        assertEquals(1, j.all().size)
        assertEquals(0, signed)
        assertEquals(0, sends)
        try {
          e.execute(review) { error("Passkey cancelled") }
          fail("Fresh transfer authority required")
        } catch (_: IllegalStateException) {}
        assertEquals(0, signed)
        assertEquals(0, sends)
        try {
          e.execute(review) {}
          fail("Lost submit")
        } catch (_: IllegalStateException) {}
        assertEquals(1, signed)
        assertEquals(1, sends)
      }
  }

  @Test
  fun pendingNativeAuthorityRejectsResumeBeforeFreshProofRequest() = runBlocking {
    val j = EarnPayoutJournal(File(), { key }, f.wallet, f.wallet)
    engine(j).use { e ->
      val id = e.create(request()).getString("operationId")
      j.update(id, "hold", 1) { it.put("signingAuthorizationPending", true) }
      try {
        e.prepare(id, 2)
        fail("Pending native authority")
      } catch (_: IllegalStateException) {}
      assertEquals(1, readAuthentications)
      assertEquals(0, signed)
      assertEquals(0, sends)
    }
  }

  @Test
  fun nativeMissingOrUncreditedBatchStopsBeforePrivatePreparationAndReservation() = runBlocking {
    val selected =
      f.source().also {
        it
          .getJSONObject("proposal")
          .put("fundingBatchId", "batch1")
          .put("fundingBatchSize", 2)
          .put("sourceAccountIndex", 1)
      }
    val pending =
      JSONObject(selected.toString()).put("operationId", "funding2").put("status", "submitted")
    pending.getJSONObject("proposal").put("operationId", "funding2").put("sourceAccountIndex", 3)
    for (reader in
      listOf<(suspend (String) -> List<JSONObject>)?>(
        null,
        { listOf(selected) },
        { listOf(selected, pending) },
      )) {
      val j = EarnPayoutJournal(File(), { key }, f.wallet, f.wallet)
      engine(j, source = { selected }, batch = reader).use { e ->
        try {
          e.create(request())
          fail("Incomplete batch must wait")
        } catch (_: IllegalStateException) {}
      }
      assertTrue(j.all().isEmpty())
      assertNull(privateRequest)
      assertEquals(0, readAuthentications)
      assertEquals(0, signed)
    }
  }

  @Test
  fun nativeBatchUsesSelectedSourceIndexAndWholeBatchRoundingInPrivateRequestAndDurableProposal() =
    runBlocking {
      val selected =
        f.source().also {
          it
            .getJSONObject("proposal")
            .put("fundingBatchId", "batch1")
            .put("fundingBatchSize", 2)
            .put("sourceAccountIndex", 3)
        }
      val prior = f.source().put("operationId", "funding2").put("transactionHash", f.nativeHash)
      prior
        .getJSONObject("proposal")
        .put("operationId", "funding2")
        .put("fundingBatchId", "batch1")
        .put("fundingBatchSize", 2)
        .put("sourceAccountIndex", 1)
      prior.getJSONObject("stateBinding").getJSONObject("routeProof").put("operationId", "funding2")
      prior
        .getJSONObject("settlement")
        .put("operationId", "funding2")
        .put("transactionHash", f.nativeHash)
        .put("creditedAtoms", "1000009")
      val prepared = f.prepared()
      prepared.getJSONObject("quote").put("amountAtoms", "100001")
      val intent = prepared.getJSONObject("intent")
      val payload = JSONObject(intent.getString("payload"))
      val tokens = payload.getJSONArray("intents").getJSONObject(0).getJSONObject("tokens")
      tokens.put(tokens.keys().next(), "100001")
      intent.put("payload", payload.toString())
      val j = EarnPayoutJournal(File(), { key }, f.wallet, f.wallet)
      engine(j, source = { selected }, batch = { listOf(selected, prior) }, prepared = { prepared })
        .use { e ->
          val op = e.create(request())
          val p = op.getJSONObject("proposal")
          assertEquals(3, p.getInt("sourceAccountIndex"))
          assertEquals("1000009", p.getString("splitOffsetAtoms"))
          assertEquals("100001", p.getString("amountAtoms"))
          assertEquals("batch1", p.getString("fundingBatchId"))
          assertEquals(3, privateRequest!!.getInt("sourceAccountIndex"))
          assertEquals(0, privateRequest!!.getInt("cycleIndex"))
          assertEquals("1000009", privateRequest!!.getString("splitOffsetAtoms"))
          val review = e.prepare(op.getString("operationId"), 1)
          assertEquals(0, signed)
          prior.getJSONObject("settlement").put("authenticated", false)
          try {
            e.execute(review) {}
            fail("A changed batch proof cannot sign")
          } catch (_: IllegalStateException) {}
          assertEquals(0, signed)
        }
    }

  private fun batchSource(id: String, index: Int, credit: String): JSONObject {
    val row =
      f.source()
        .put("operationId", id)
        .put("transactionHash", "0x" + index.toString(16).padStart(64, '0'))
    row
      .getJSONObject("proposal")
      .put("operationId", id)
      .put("sourceAccountIndex", index)
      .put("fundingBatchId", "batch1")
      .put("fundingBatchSize", 2)
      .put("cycleIndex", 1)
    row.getJSONObject("settlement").put("operationId", id).put("creditedAtoms", credit)
    return row
  }

  @Test
  fun batchRequiresEveryExactUniqueCreditedChildAndComputesPrefixIndependentOfInputOrder() {
    val a = batchSource("funding-a", 1, "1000009")
    val b = batchSource("funding-b", 3, "1000001")
    val read: (JSONObject) -> JSONObject = { row ->
      check(row.getString("status") == "finalized")
      check(row.getJSONObject("settlement").getBoolean("authenticated"))
      JSONObject()
    }
    assertEquals("0", nativePayoutBatchOffset(a, listOf(b, a), read))
    assertEquals("1000009", nativePayoutBatchOffset(b, listOf(b, a), read))
    assertEquals("100001", nativePayoutAmount("1000001", "1000009", "hold"))
    assertEquals("900000", nativePayoutAmount("1000001", "1000009", "invest"))
    for (rows in
      listOf(
        listOf(a),
        listOf(a, a),
        listOf(
          a,
          JSONObject(b.toString()).also { it.getJSONObject("proposal").put("cycleIndex", 2) },
        ),
        listOf(a, JSONObject(b.toString()).put("status", "submitted")),
        listOf(
          a,
          JSONObject(b.toString()).also {
            it.getJSONObject("settlement").put("authenticated", false)
          },
        ),
      )) {
      assertThrows(IllegalStateException::class.java) { nativePayoutBatchOffset(a, rows, read) }
    }
    val alias = JSONObject(b.toString()).put("transactionHash", a.getString("transactionHash"))
    assertThrows(IllegalStateException::class.java) {
      nativePayoutBatchOffset(a, listOf(a, alias), read)
    }
    alias
      .getJSONObject("proposal")
      .put("expectedFrom", "0x" + "9".repeat(40))
      .put("recipient", "0x" + "8".repeat(40))
    assertEquals("1000009", nativePayoutBatchOffset(alias, listOf(a, alias), read))
  }
}
