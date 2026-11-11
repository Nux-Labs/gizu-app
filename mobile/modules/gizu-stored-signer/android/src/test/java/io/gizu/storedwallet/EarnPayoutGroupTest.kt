package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnPayoutGroupTest {
  private val recipient = "0x" + "2".repeat(40)
  private val topic = "0x" + "d".repeat(64)

  private fun hash(d: String) = "0x" + d.repeat(64)

  private val distribution =
    JSONObject().put("version", 1).put("weightsBps", JSONArray(listOf(10000)))

  private fun group() =
    JSONObject()
      .put("version", 1)
      .put("journeyId", "journey1")
      .put("cycleIndex", 0)
      .put("distribution", distribution)
      .put("recipients", JSONArray().put(recipient))
      .put(
        "members",
        JSONArray(
          (0..2).map { i ->
            JSONObject()
              .put("operationId", "source$i")
              .put("leg", "invest:0")
              .put("kind", if (i == 2) "funded" else "private")
              .put("recipient", recipient)
          }
        ),
      )

  private fun quote() =
    JSONObject()
      .put("destinationChainId", 4663)
      .put("destinationToken", HOOD_EARN_USDG)
      .put("destinationRecipient", recipient)
      .put("referenceBlock", "10")
      .put("referenceHash", hash("a"))
      .put("observedAtMs", 1000000)
      .put("minimumDestinationAtoms", "100")

  private fun children() =
    (0..2).map { i ->
      val p =
        JSONObject()
          .put("kind", if (i == 2) "earnPayout" else "privateEarnPayout")
          .put("operationId", "source$i")
          .put("revision", if (i == 2) 7 else 1)
          .put("profileChainId", 4663)
          .put("cycleIndex", 0)
          .put("distribution", distribution)
          .put("leg", "invest:0")
          .put("expectedSigner", "0x" + (i + 3).toString().repeat(40))
          .put("expectedRecipient", recipient)
          .put("amountAtoms", "110")
          .put("minimumDestinationAtoms", "100")
      JSONObject()
        .put("operationId", "child$i")
        .put("revision", 20)
        .put("leg", "invest:0")
        .put("proposal", p)
        .put(
          "preparedText",
          (if (i == 2) JSONObject().put("quote", quote()) else quote())
            .put("recoveryEnvelope", "v1.saved$i")
            .put("intent", JSONObject().put("standard", "erc191").put("payload", "saved$i"))
            .toString(),
        )
        .put(
          "signedData",
          JSONObject()
            .put("standard", "erc191")
            .put("payload", "saved$i")
            .put("signature", "sig$i")
            .toString(),
        )
        .put("status", "submitted")
        .put("receivedAtoms", "0")
    }

  private fun log(d: String, amount: String, index: Int) =
    JSONObject()
      .put("address", HOOD_EARN_USDG)
      .put("topics", JSONArray().put(topic).put(hash("0")).put("0x" + earnAddressWord(recipient)))
      .put("data", "0x" + earnNumberWord(amount))
      .put("transactionHash", hash(d))
      .put("blockNumber", "0xb")
      .put("blockHash", hash("e"))
      .put("logIndex", "0x" + index.toString(16))
      .put("removed", false)

  private inner class Rpc(val logs: List<JSONObject>) : TransferRpc {
    var reorg = false
    var reorgBlock: Int? = null
    var head = 11
    val tags = mutableListOf<String>()

    override suspend fun call(method: String, params: JSONArray): Any =
      when (method) {
        "eth_chainId" -> "0x1237"
        "eth_getBlockByNumber" -> {
          val tag = params.getString(0)
          tags.add(tag)
          check(tag != "finalized") { "Robinhood group must use canonical receipt policy" }
          val n = if (tag == "latest") head else tag.removePrefix("0x").toInt(16)
          JSONObject()
            .put("number", "0x" + n.toString(16))
            .put("hash", hash(if (n == 10) "a" else if (reorg || n == reorgBlock) "f" else "e"))
            .put("timestamp", "0x3e8")
        }
        "eth_getLogs" -> JSONArray(logs)
        "eth_getTransactionReceipt" ->
          JSONObject()
            .put("status", "0x1")
            .put("transactionHash", params.getString(0))
            .put(
              "blockNumber",
              logs
                .first { it.getString("transactionHash") == params.getString(0) }
                .getString("blockNumber"),
            )
            .put(
              "blockHash",
              logs
                .first { it.getString("transactionHash") == params.getString(0) }
                .getString("blockHash"),
            )
            .put(
              "logs",
              JSONArray(logs.filter { it.getString("transactionHash") == params.getString(0) }),
            )
        else -> error(method)
      }
  }

  private fun proof(group: JSONObject, logs: List<JSONObject>) =
    JSONObject()
      .put("groupId", depositDigest(depositCanonical(group)))
      .put("verification", "signed-route-receipt-group-v1")
      .put("authenticated", true)
      .put("operationScoped", true)
      .put("observedAtMs", 1000000)
      .put("status", "paid")
      .put(
        "routes",
        JSONArray((0..2).map { JSONObject().put("index", it).put("status", "SUCCESS") }),
      )
      .put(
        "slots",
        JSONArray()
          .put(
            JSONObject()
              .put("slot", 0)
              .put("destinationRecipient", recipient)
              .put("minimumDestinationAtoms", "300")
              .put("receivedAtoms", "321")
              .put(
                "receipts",
                JSONArray(
                  logs.map {
                    JSONObject()
                      .put("transactionHash", it.getString("transactionHash"))
                      .put("logIndex", quantity(it.getString("logIndex")).toInt())
                      .put(
                        "receivedAtoms",
                        it.getString("data").removePrefix("0x").toBigInteger(16).toString(),
                      )
                      .put("blockNumber", quantity(it.getString("blockNumber")).toString())
                      .put("blockHash", it.getString("blockHash"))
                  }
                ),
              )
          ),
      )

  private fun gateway(rpc: Rpc, mutate: (JSONObject) -> Unit = {}) =
    EarnPayoutGroupGateway(
      rpc,
      owners = { JSONArray() },
      post = { request ->
        val result = proof(request.getJSONObject("group"), rpc.logs)
        if (request.getJSONArray("destinationTransactionHashes").getJSONArray(0).length() == 0)
          result.put("status", "awaitingReceipt").remove("slots")
        else mutate(result)
        result
      },
      topic = { topic },
      now = { 1000000 },
    )

  @Test
  fun mixedSourcesAndMultipleSameTransactionEventsVerifyWholeRecipientWithoutAttribution() =
    runBlocking {
      val logs = listOf(log("1", "180", 0), log("1", "41", 1), log("2", "100", 0))
      val rpc = Rpc(logs)
      val result = gateway(rpc).status(group(), children(), JSONObject())
      assertEquals("paid", result.getString("status"))
      assertEquals(
        3,
        result.getJSONArray("slots").getJSONObject(0).getJSONArray("receipts").length(),
      )
      assertTrue(rpc.tags.contains("latest"))
      assertFalse(result.has("destinationTransactionHash"))
    }

  @Test
  fun nativeRejectsBackendAmountMutationDuplicateAndCanonicalReorg() = runBlocking {
    val logs = listOf(log("1", "221", 0), log("2", "100", 0))
    for (mutation in
      listOf<(JSONObject) -> Unit>(
        { it.getJSONArray("slots").getJSONObject(0).put("receivedAtoms", "322") },
        {
          val receipts = it.getJSONArray("slots").getJSONObject(0).getJSONArray("receipts")
          receipts.put(receipts.getJSONObject(0))
        },
        { it.put("groupId", hash("f")) },
        { it.getJSONArray("routes").getJSONObject(0).put("status", "PENDING") },
      )) {
      try {
        gateway(Rpc(logs), mutation).status(group(), children(), JSONObject())
        fail("mutation accepted")
      } catch (_: IllegalStateException) {}
    }
    val rpc = Rpc(logs).also { it.reorg = true }
    try {
      gateway(rpc).status(group(), children(), JSONObject())
      fail("reorg accepted")
    } catch (_: IllegalStateException) {}
  }

  @Test
  fun guidedGroupOwnershipPreservesEthereumAndStandaloneLegacyEngines() {
    val row = children()[2]
    val review =
      JSONObject()
        .put(
          "review",
          JSONObject()
            .put("cycleIndex", 0)
            .put("distribution", distribution)
            .put("sources", JSONArray().put(JSONObject().put("operationId", "source2"))),
        )
    assertTrue(isGuidedEarnPayout(row, listOf(review)))
    assertFalse(isGuidedEarnPayout(row, emptyList()))
    row.getJSONObject("proposal").put("profileChainId", 1)
    assertFalse(isGuidedEarnPayout(row, listOf(review)))
  }

  @Test
  fun savedPayloadAndRecipientMutationsAreRejectedWithoutReceiptAuthority() = runBlocking {
    val rows = children()
    rows[0].put(
      "signedData",
      JSONObject(rows[0].getString("signedData")).put("payload", "changed").toString(),
    )
    try {
      gateway(Rpc(listOf(log("1", "321", 0)))).status(group(), rows, JSONObject())
      fail("changed saved payload accepted")
    } catch (_: IllegalStateException) {}
    val changed = children()
    changed[0].getJSONObject("proposal").put("expectedRecipient", "0x" + "9".repeat(40))
    assertThrows(IllegalStateException::class.java) { earnPayoutGroupChildren(group(), changed) }
    Unit
  }

  @Test
  fun receiptCandidatesAreDurableBeforeBackendFreezeAndLostResponseReusesExactSet() = runBlocking {
    val logs = mutableListOf(log("1", "221", 0), log("2", "100", 0))
    val rpc = Rpc(logs)
    var durable: JSONObject? = null
    var posts = 0
    var loseResponse = true
    val gateway =
      EarnPayoutGroupGateway(
        rpc,
        { JSONArray() },
        { request ->
          val hashes = request.getJSONArray("destinationTransactionHashes").getJSONArray(0)
          val result = proof(request.getJSONObject("group"), logs.take(2))
          if (hashes.length() == 0)
            result.put("status", "awaitingReceipt").also { it.remove("slots") }
          else {
            posts++
            assertNotNull("Must durably retain candidates before backend can bind them", durable)
            assertEquals(2, hashes.length())
            if (loseResponse) {
              loseResponse = false
              error("lost response after backend accepted")
            }
            result
          }
        },
        { topic },
        { 1000000 },
        persistCandidates = { durable = JSONObject(it.toString()) },
      )
    try {
      gateway.status(group(), children(), JSONObject())
      fail("expected lost response")
    } catch (_: IllegalStateException) {}
    assertNotNull(durable)
    logs.add(log("3", "999", 0).put("blockNumber", "0xc"))
    rpc.head = 12
    val result = gateway.status(group(), children(), durable!!)
    assertEquals("paid", result.getString("status"))
    assertEquals("321", result.getJSONArray("slots").getJSONObject(0).getString("receivedAtoms"))
    assertEquals(2, posts)
  }

  @Test
  fun insufficientFixedAmountsNeverReachBackendCandidateFreeze() = runBlocking {
    val logs = listOf(log("1", "221", 0), log("2", "100", 0))
    val rows = children()
    rows[0]
      .put("status", "paid")
      .put("receivedAtoms", "221")
      .put(
        "receipt",
        JSONObject()
          .put("transactionHash", hash("1"))
          .put("logIndex", 0)
          .put("receivedAtoms", "221"),
      )
    var candidates = 0
    val gateway =
      EarnPayoutGroupGateway(
        Rpc(logs),
        { JSONArray() },
        { request ->
          if (request.getJSONArray("destinationTransactionHashes").getJSONArray(0).length() > 0)
            candidates++
          proof(request.getJSONObject("group"), logs).put("status", "awaitingReceipt").also {
            it.remove("slots")
          }
        },
        { topic },
        { 1000000 },
      )
    assertEquals("awaitingReceipt", gateway.status(group(), rows, JSONObject()).getString("status"))
    assertEquals(0, candidates)
  }

  @Test
  fun rechecksEverySavedAnchorAfterBackendReplyBeforeAcceptingPaidGroup() = runBlocking {
    val logs =
      listOf(
        log("1", "221", 0).put("blockNumber", "0xc"),
        log("2", "100", 0).put("blockNumber", "0xc"),
      )
    val rows = children()
    val prepared = JSONObject(rows[2].getString("preparedText"))
    prepared.getJSONObject("quote").put("referenceBlock", "11").put("referenceHash", hash("e"))
    rows[2].put("preparedText", prepared.toString())
    val rpc = Rpc(logs).also { it.head = 12 }
    val gateway =
      EarnPayoutGroupGateway(
        rpc,
        { JSONArray() },
        { request ->
          val result = proof(request.getJSONObject("group"), logs)
          if (request.getJSONArray("destinationTransactionHashes").getJSONArray(0).length() == 0)
            result.put("status", "awaitingReceipt").also { it.remove("slots") }
          else {
            rpc.reorgBlock = 11
            result
          }
        },
        { topic },
        { 1000000 },
      )
    try {
      gateway.status(group(), rows, JSONObject())
      fail("newer saved anchor reorg accepted")
    } catch (_: IllegalStateException) {}
  }

  @Test
  fun failedPortableCandidateSyncRetriesBeforeAnyCandidatePost() = runBlocking {
    val rpc = Rpc(listOf(log("1", "321", 0)))
    var saved = JSONObject()
    var syncs = 0
    var posts = 0
    val gateway =
      EarnPayoutGroupGateway(
        rpc,
        { JSONArray() },
        { request ->
          val result = proof(request.getJSONObject("group"), rpc.logs)
          if (request.getJSONArray("destinationTransactionHashes").getJSONArray(0).length() == 0)
            result.put("status", "awaitingReceipt").also { it.remove("slots") }
          else {
            posts++
            result
          }
        },
        { topic },
        { 1000000 },
        persistCandidates = { saved = JSONObject(it.toString()) },
        beforeCandidatePost = {
          syncs++
          if (syncs == 1) throw RpcFailure(RpcFailureCode.NETWORK)
        },
      )
    try {
      gateway.status(group(), children(), JSONObject())
      fail("expected sync failure")
    } catch (_: RpcFailure) {}
    assertEquals(0, posts)
    assertTrue(saved.getBoolean("candidateFrozen"))
    assertEquals("paid", gateway.status(group(), children(), saved).getString("status"))
    assertEquals(2, syncs)
    assertEquals(1, posts)
  }

  @Test
  fun affirmativeFrozenCandidateForkCanRecoverUnacceptedSetButConflictRetainsOriginal() =
    runBlocking {
      for (accepted in listOf(false, true)) {
        val logs = mutableListOf(log("1", "321", 0))
        val rpc = Rpc(logs)
        var saved = JSONObject()
        var first = true
        var temporaryPending = false
        val gateway =
          EarnPayoutGroupGateway(
            rpc,
            { JSONArray() },
            { request ->
              val result = proof(request.getJSONObject("group"), logs)
              if (temporaryPending) result.put("status", "pending")
              else if (
                request.getJSONArray("destinationTransactionHashes").getJSONArray(0).length() == 0
              )
                result.put("status", "awaitingReceipt").also { it.remove("slots") }
              else if (first) {
                first = false
                throw RpcFailure(RpcFailureCode.NETWORK)
              } else if (accepted)
                throw EarnGatewayFailure("EARN_COORDINATION_CONFLICT", "immutable proof conflict")
              else result
            },
            { topic },
            { 1000000 },
            persistCandidates = { saved = JSONObject(it.toString()) },
          )
        try {
          gateway.status(group(), children(), JSONObject())
          fail("expected lost response")
        } catch (_: RpcFailure) {}
        assertEquals(
          hash("e"),
          saved.getJSONArray("candidateBlocks").getJSONObject(0).getString("blockHash"),
        )
        temporaryPending = true
        saved = gateway.status(group(), children(), saved)
        temporaryPending = false
        assertTrue(saved.has("candidateBlocks"))
        logs.clear()
        logs.add(log("2", "321", 0).put("blockHash", hash("f")))
        rpc.reorgBlock = 11
        if (accepted) {
          try {
            gateway.status(group(), children(), saved)
            fail("expected recovery conflict")
          } catch (_: EarnGroupRecoveryRequired) {}
          assertTrue(saved.getBoolean("recoveryRequired"))
          assertEquals(
            hash("1"),
            saved
              .getJSONArray("groupScan")
              .getJSONObject(0)
              .getJSONArray("transactionHashes")
              .getString(0),
          )
        } else {
          val result = gateway.status(group(), children(), saved)
          assertEquals("paid", result.getString("status"))
          assertEquals(
            hash("2"),
            saved
              .getJSONArray("groupScan")
              .getJSONObject(0)
              .getJSONArray("transactionHashes")
              .getString(0),
          )
          assertEquals(1, saved.getJSONArray("candidateHistory").length())
        }
      }
    }

  @Test
  fun partiallySignedGroupRetainsExactCoreRevisionAndAllowsRemainingApproval() = runBlocking {
    val rows = children().mapIndexed { i, row -> if (i == 0) null else row }
    val rpc = Rpc(emptyList())
    val gateway =
      EarnPayoutGroupGateway(
        rpc,
        { JSONArray() },
        { request ->
          val signed = request.getJSONArray("children")
          assertTrue(signed.isNull(0))
          assertEquals(1, signed.getJSONObject(1).getInt("revision"))
          assertEquals(7, signed.getJSONObject(2).getInt("revision"))
          assertEquals(
            "saved2",
            signed.getJSONObject(2).getJSONObject("submittedIntent").getString("payload"),
          )
          proof(request.getJSONObject("group"), emptyList())
            .put("status", "pending")
            .put(
              "routes",
              JSONArray()
                .put(JSONObject().put("index", 1).put("status", "SUCCESS"))
                .put(JSONObject().put("index", 2).put("status", "PROCESSING")),
            )
        },
        { topic },
        { 1000000 },
      )
    assertEquals("pending", gateway.status(group(), rows, JSONObject()).getString("status"))
    assertTrue(rpc.tags.isEmpty())
  }

  @Test
  fun unsignedMemberCannotBePaid() = runBlocking {
    val rows = children()
    rows[0].remove("signedData")
    val rpc = Rpc(listOf(log("1", "321", 0)))
    val bad =
      EarnPayoutGroupGateway(
        rpc,
        { JSONArray() },
        { proof(it.getJSONObject("group"), rpc.logs) },
        { topic },
        { 1000000 },
      )
    try {
      bad.status(group(), rows, JSONObject())
      fail("unsigned group paid")
    } catch (_: IllegalStateException) {}
  }

  @Test
  fun legacyPaidAmountsRequireExactSavedEventsAndRemainingMinima() = runBlocking {
    val logs = listOf(log("1", "221", 0), log("2", "100", 0))
    val rows = children()
    rows[0]
      .put("status", "paid")
      .put("receivedAtoms", "100")
      .put(
        "receipt",
        JSONObject()
          .put("transactionHash", hash("1"))
          .put("logIndex", 0)
          .put("receivedAtoms", "100"),
      )
    try {
      gateway(Rpc(logs)).status(group(), rows, JSONObject())
      fail("legacy receipt mutation accepted")
    } catch (_: IllegalStateException) {}
    rows[0].put("receivedAtoms", "221").getJSONObject("receipt").put("receivedAtoms", "221")
    assertEquals(
      "awaitingReceipt",
      gateway(Rpc(logs)).status(group(), rows, JSONObject()).getString("status"),
    )
  }

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

  @Test
  fun nativeJournalRejectsReusingCanonicalEventAcrossDifferentApprovedGroups() {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val journal = EarnPayoutJournal(file, { key }, "wallet", "generation")
    fun create(suffix: String) =
      children().mapIndexed { index, row ->
        val p =
          JSONObject(row.getJSONObject("proposal").toString())
            .put("operationId", "source$index$suffix")
        val saved =
          journal.create(
            p,
            row.getString("preparedText"),
            "nonce$index$suffix",
            hash("a"),
            hash("b"),
          )
        journal.saveSigned(
          saved.getString("operationId"),
          "invest:0",
          1,
          row.getString("signedData"),
          "review",
          hash("c"),
        )
      }
    val first = create("")
    val g = group()
    journal.saveGroup(g, first, proof(g, listOf(log("1", "321", 0))))
    val second = create("other")
    val next = group().put("journeyId", "anotherjourney")
    next.getJSONArray("members").objects().forEachIndexed { index, member ->
      member.put("operationId", "source${index}other")
    }
    val before = file.read()
    assertThrows(IllegalStateException::class.java) {
      journal.saveGroup(next, second, proof(next, listOf(log("1", "321", 0))))
    }
    assertArrayEquals(before, file.read())
  }

  @Test
  fun atomicGroupWriteSurvivesFailureRestartAndFreezesProofAgainstLaterGifts() {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    fun journal() = EarnPayoutJournal(file, { key }, "wallet", "generation")
    val j = journal()
    val rows =
      children().mapIndexed { i, row ->
        val created =
          j.create(
            row.getJSONObject("proposal"),
            row.getString("preparedText"),
            "nonce$i",
            hash("a"),
            hash("b"),
          )
        j.saveSigned(
          created.getString("operationId"),
          "invest:0",
          1,
          row.getString("signedData"),
          "review",
          hash("c"),
        )
      }
    val g = group()
    val result = proof(g, listOf(log("1", "321", 0)))
    file.fail = true
    assertThrows(IllegalStateException::class.java) { j.saveGroup(g, rows, result) }
    assertNull(journal().group(depositDigest(depositCanonical(g))))
    assertTrue(journal().all().all { it.getString("status") == "submissionUnknown" })
    file.fail = false
    j.saveGroup(g, rows, result)
    val restarted = journal()
    assertTrue(restarted.storageBytes() > JSONArray(restarted.all()).toString().toByteArray().size)
    assertTrue(restarted.groupGrowthBytes(0) < EARN_PAYOUT_GROUP_STORAGE_BYTES)
    val saved = restarted.all()
    assertEquals(listOf("100", "100", "121"), saved.map { it.getString("receivedAtoms") })
    assertEquals(rows.map { it.getString("signedData") }, saved.map { it.getString("signedData") })
    assertTrue(
      saved.all { it.has("groupId") && !it.has("destinationTransactionHash") && !it.has("slots") }
    )
    val recoveredFile = File().also { it.write(file.read()) }
    assertEquals(
      depositCanonical(restarted.group(depositDigest(depositCanonical(g)))),
      depositCanonical(
        EarnPayoutJournal(recoveredFile, { key }, "wallet", "generation")
          .group(depositDigest(depositCanonical(g)))
      ),
    )
    val unrelated =
      j.create(
        children()[0]
          .getJSONObject("proposal")
          .put("operationId", "another")
          .put("expectedSigner", "0x" + "9".repeat(40)),
        "body",
        "another",
        hash("a"),
        hash("b"),
      )
    j.update(unrelated.getString("operationId"), "invest:0", 1) { it.put("status", "cancelled") }
    assertEquals("paid", journal().group(depositDigest(depositCanonical(g)))!!.getString("status"))
    val old = file.read()
    assertThrows(IllegalStateException::class.java) {
      restarted.saveGroup(
        g,
        saved,
        JSONObject(result.toString()).also {
          it.getJSONArray("slots").getJSONObject(0).put("receivedAtoms", "999")
        },
      )
    }
    assertArrayEquals(old, file.read())
  }
}
