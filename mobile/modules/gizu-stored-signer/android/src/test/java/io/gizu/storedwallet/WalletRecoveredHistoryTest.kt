package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class WalletRecoveredHistoryTest {
  @Test
  fun ownerCompletionRestoresAsLifecycleMetadataWithoutCreatingMinimumCredit() {
    val original = confirmedMinimumReturn("hoodTokenReturn")
    original.remove("minimumReturnReceipt")
    original.put(
      "returnFlowCompletion",
      ownerReceivedReturnRecord(original, wallet, old, 1, "SUCCESS", false),
    )
    val domain = "gizu-earn-sponsored"
    val root =
      JSONObject()
        .put("version", 1)
        .put("walletId", wallet)
        .put("operations", JSONArray().put(original))
    importer().import(JSONArray().put(row(domain, root)))
    val restored = JSONObject(read(domain)).getJSONArray("operations").getJSONObject(0)
    assertTrue(ownerReportedReturnCompleted(restored, wallet, current))
    assertNull(savedMinimumReturnReceipt(restored, wallet, current))
    assertEquals(
      "owner-confirmed",
      restored.getJSONObject("returnFlowCompletion").getString("source"),
    )
    assertFalse(restored.has("settlement"))
    assertThrows(Exception::class.java) { ownerReportedReturnCompleted(restored, wallet, old) }
  }

  @Test
  fun terminalRefundRestoresWithoutReopeningItsOriginOrSpendingAuthority() = runBlocking {
    val original = confirmedMinimumReturn("hoodTokenReturn")
    original.remove("minimumReturnReceipt")
    original.put(
      "returnRouteProgress",
      JSONObject()
        .put("version", 1)
        .put("providerRouteStatus", "REFUNDED")
        .put("observedAtMs", 1)
        .put("publicUsdgAtoms", "1502133")
        .put("spendingAuthorized", false)
        .put("nativeBinding", returnCompletionBinding(original, wallet, old)),
    )
    val domain = "gizu-earn-sponsored"
    val root =
      JSONObject()
        .put("version", 1)
        .put("walletId", wallet)
        .put("operations", JSONArray().put(original))
    importer().import(JSONArray().put(row(domain, root)))
    val restored = JSONObject(read(domain)).getJSONArray("operations").getJSONObject(0)
    assertTrue(refundedSponsoredReturn(restored, wallet, current))
    assertThrows(Exception::class.java) { refundedSponsoredReturn(restored, wallet, old) }
    assertTrue(
      nativeJsonEqual(original.getJSONObject("proposal"), restored.getJSONObject("proposal"))
    )
    assertTrue(
      nativeJsonEqual(
        original.getJSONObject("stateBinding"),
        restored.getJSONObject("stateBinding"),
      )
    )
    assertEquals(original.getString("transactionHash"), restored.getString("transactionHash"))
    assertFalse(restored.has("minimumReturnReceipt"))
    assertFalse(restored.has("settlement"))
    val journal =
      EarnSponsoredJournal(files.getValue("$domain-$current.enc"), { key }, wallet, current)
    val next =
      JSONObject()
        .put("operationId", "next")
        .put("proposal", JSONObject().put("confidentialAccount", EarnPayoutFixtures.C))
    requireSequentialSourceCredit(listOf(restored), next, wallet, current)
    val unavailable =
      object : TransferRpc {
        override suspend fun call(method: String, params: JSONArray): Any =
          error("Do not reopen a restored terminal refund")
      }
    reconcileEarnSponsoredOperations(journal, unavailable, unavailable)
    val rpc =
      object : TransferRpc {
        override suspend fun call(method: String, params: JSONArray): Any {
          check(method == "eth_call")
          return "0x" + 1502133.toString(16).padStart(64, '0')
        }
      }
    refreshSponsoredReturnProgress(
      journal,
      setOf(restored.getString("operationId")),
      rpc,
      { JSONObject().put("status", "REFUNDED") },
      1000,
    )
    val checked = journal.get(restored.getString("operationId"))
    assertTrue(refundedSponsoredReturn(checked, wallet, current))
    assertFalse(completedReturnLifecycle(checked, wallet, current))
    requireSequentialSourceCredit(listOf(checked), next, wallet, current)
    Unit
  }

  private val wallet = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12"
  private val old = "d450c45a-7d4d-4ce9-bbbd-3437c6ba6cb8"
  private val current = "2793c0c2-62a5-4539-bc25-18893b8fc8c2"

  private class MemoryFile : WalletFile {
    var value: ByteArray? = null
    var failWrites = false

    override fun exists() = value != null

    override fun read() = value!!.copyOf()

    override fun write(bytes: ByteArray) {
      check(!failWrites)
      value = bytes.copyOf()
    }
  }

  private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
  private val files = mutableMapOf<String, MemoryFile>()

  private fun importer() =
    RecoveredHistoryImporter(wallet, current, key) { files.getOrPut(it) { MemoryFile() } }

  private fun operation(revision: Int, raw: String? = "0x1234") =
    JSONObject()
      .put("operationId", "op1")
      .put("revision", revision)
      .put("cancelled", false)
      .put("proposal", JSONObject().put("expectedFrom", "0xowner"))
      .put(
        "steps",
        JSONArray()
          .put(
            JSONObject()
              .put("index", 0)
              .put("status", if (revision == 1) "unknown" else "finalized")
              .also {
                if (raw != null)
                  it.put("raw", raw).put("transactionHash", "0xhash").put("nonce", "4")
              }
          ),
      )

  private fun row(
    domain: String = "gizu-earn-vault",
    data: Any =
      JSONObject()
        .put("version", 1)
        .put("walletId", wallet)
        .put("operations", JSONArray().put(operation(1))),
  ) =
    JSONObject()
      .put("domain", domain)
      .put("generation", old)
      .put("name", "$domain-$old.enc")
      .put("data", data.toString())

  private fun read(prefix: String): String =
    String(
      CryptoEnvelope.decrypt(
        key,
        files.getValue("$prefix-$current.enc").read(),
        "$prefix:v1:$wallet:$current".toByteArray(),
      )
    )

  @Test
  fun restoredGuidedReviewRebindsOnlyAuthenticatedSourceGeneration() {
    val journey =
      JSONObject()
        .put("journeyId", "journey")
        .put("walletId", wallet)
        .put("generation", old)
        .put("review", JSONObject().put("generation", old))
    val snapshot =
      JSONObject()
        .put("version", 1)
        .put("walletId", wallet)
        .put("generation", old)
        .put("journeys", JSONArray().put(journey))
    importer().import(JSONArray().put(row("gizu-earn-deposit", snapshot)))
    assertEquals(
      current,
      JSONObject(read("gizu-earn-deposit"))
        .getJSONArray("journeys")
        .getJSONObject(0)
        .getJSONObject("review")
        .getString("generation"),
    )
    journey.getJSONObject("review").put("generation", "unrelated")
    assertThrows(IllegalStateException::class.java) {
      importer().import(JSONArray().put(row("gizu-earn-deposit", snapshot)))
    }
  }

  @Test
  fun frozenPendingPayoutCandidateSurvivesArchiveOrderAndRejectsDifferentFrozenSet() {
    val id = "0x" + "a".repeat(64)
    val group = JSONObject().put("version", 1).put("journeyId", "journey")
    fun snapshot(frozen: Boolean, hash: String = "0x" + "b".repeat(64)): JSONObject {
      val proof =
        JSONObject()
          .put("groupId", id)
          .put("status", "awaitingReceipt")
          .put(
            "groupScan",
            JSONArray()
              .put(
                JSONObject()
                  .put("complete", true)
                  .put("nextScanBlock", "12")
                  .put("transactionHashes", JSONArray().put(hash))
              ),
          )
      if (frozen) proof.put("candidateFrozen", true)
      return JSONObject()
        .put("version", 1)
        .put("walletId", wallet)
        .put("operations", JSONArray())
        .put("groups", JSONObject().put(id, JSONObject().put("group", group).put("proof", proof)))
    }
    for (order in listOf(listOf(false, true, false), listOf(true, false, false))) {
      files.clear()
      for (frozen in order) importer()
        .import(JSONArray().put(row("gizu-earn-payout", snapshot(frozen))))
      val proof =
        JSONObject(read("gizu-earn-payout"))
          .getJSONObject("groups")
          .getJSONObject(id)
          .getJSONObject("proof")
      assertTrue(proof.getBoolean("candidateFrozen"))
      assertEquals(
        "0x" + "b".repeat(64),
        proof
          .getJSONArray("groupScan")
          .getJSONObject(0)
          .getJSONArray("transactionHashes")
          .getString(0),
      )
      val before = files.getValue("gizu-earn-payout-$current.enc").read()
      assertThrows(IllegalStateException::class.java) {
        importer()
          .import(JSONArray().put(row("gizu-earn-payout", snapshot(true, "0x" + "c".repeat(64)))))
      }
      assertArrayEquals(before, files.getValue("gizu-earn-payout-$current.enc").read())
    }
  }

  @Test
  fun authenticatedForkCandidateLineageMergesInEitherArchiveOrder() {
    val id = "0x" + "a".repeat(64)
    val group = JSONObject().put("version", 1).put("journeyId", "journey")
    fun proof(hash: String) =
      JSONObject()
        .put("groupId", id)
        .put("status", "awaitingReceipt")
        .put("candidateFrozen", true)
        .put(
          "candidateBlocks",
          JSONArray()
            .put(JSONObject().put("blockNumber", "11").put("blockHash", "0x" + "d".repeat(64))),
        )
        .put(
          "groupScan",
          JSONArray()
            .put(
              JSONObject()
                .put("complete", true)
                .put("nextScanBlock", "12")
                .put("transactionHashes", JSONArray().put(hash))
            ),
        )
    val original = proof("0x" + "b".repeat(64))
    val next =
      proof("0x" + "c".repeat(64))
        .put("candidateHistory", JSONArray().put(earnGroupCandidateSnapshot(original)))
        .put(
          "forkEvidence",
          JSONArray()
            .put(
              JSONObject()
                .put("blockNumber", "11")
                .put("previousBlockHash", "0x" + "d".repeat(64))
                .put("canonicalBlockHash", "0x" + "e".repeat(64))
            ),
        )
    fun snapshot(p: JSONObject) =
      JSONObject()
        .put("version", 1)
        .put("walletId", wallet)
        .put("operations", JSONArray())
        .put("groups", JSONObject().put(id, JSONObject().put("group", group).put("proof", p)))
    for (order in listOf(listOf(original, next, original), listOf(next, original, next))) {
      files.clear()
      for (p in order) importer().import(JSONArray().put(row("gizu-earn-payout", snapshot(p))))
      val saved =
        JSONObject(read("gizu-earn-payout"))
          .getJSONObject("groups")
          .getJSONObject(id)
          .getJSONObject("proof")
      assertEquals(
        "0x" + "c".repeat(64),
        saved
          .getJSONArray("groupScan")
          .getJSONObject(0)
          .getJSONArray("transactionHashes")
          .getString(0),
      )
    }
  }

  @Test
  fun payoutGroupProofFromNewerSnapshotSurvivesImportMergeAndOrdinaryJournalWrites() {
    val id = "0x" + "a".repeat(64)
    val before =
      JSONObject()
        .put("version", 1)
        .put("walletId", wallet)
        .put(
          "operations",
          JSONArray()
            .put(
              operation(1, null)
                .put("signedData", "exact signed payout")
                .put("status", "submitted")
                .put("leg", "invest:0")
            ),
        )
    before
      .getJSONArray("operations")
      .getJSONObject(0)
      .getJSONObject("proposal")
      .put("operationId", "source1")
      .put("cycleIndex", 0)
      .put("leg", "invest:0")
      .put("minimumDestinationAtoms", "100")
      .put("expectedRecipient", "recipient")
    val group =
      JSONObject()
        .put("version", 1)
        .put("journeyId", "journey")
        .put("cycleIndex", 0)
        .put("recipients", JSONArray().put("recipient"))
        .put(
          "members",
          JSONArray()
            .put(
              JSONObject()
                .put("operationId", "source1")
                .put("leg", "invest:0")
                .put("recipient", "recipient")
            ),
        )
    val proof =
      JSONObject()
        .put("groupId", id)
        .put("status", "paid")
        .put(
          "slots",
          JSONArray()
            .put(
              JSONObject()
                .put("slot", 0)
                .put("receivedAtoms", "100")
                .put("minimumDestinationAtoms", "100")
                .put("destinationRecipient", "recipient")
            ),
        )
    val after =
      JSONObject(before.toString())
        .put("groups", JSONObject().put(id, JSONObject().put("group", group).put("proof", proof)))
    after
      .getJSONArray("operations")
      .getJSONObject(0)
      .put("revision", 2)
      .put("groupId", id)
      .put("status", "paid")
      .put("receivedAtoms", "100")
      .put("receipt", JSONObject().put("groupId", id).put("slot", 0))
    importer()
      .import(JSONArray().put(row("gizu-earn-payout", before)).put(row("gizu-earn-payout", after)))
    val restored = JSONObject(read("gizu-earn-payout"))
    assertEquals(
      "exact signed payout",
      restored.getJSONArray("operations").getJSONObject(0).getString("signedData"),
    )
    assertEquals(
      depositCanonical(proof),
      depositCanonical(restored.getJSONObject("groups").getJSONObject(id).getJSONObject("proof")),
    )
    importer().import(JSONArray().put(row("gizu-earn-payout", before)))
    assertEquals(
      "paid",
      JSONObject(read("gizu-earn-payout"))
        .getJSONObject("groups")
        .getJSONObject(id)
        .getJSONObject("proof")
        .getString("status"),
    )
    val unsigned = JSONObject(before.toString())
    unsigned.getJSONArray("operations").getJSONObject(0).remove("signedData")
    unsigned
      .getJSONArray("operations")
      .getJSONObject(0)
      .getJSONObject("proposal")
      .put("deadlineMs", 1)
    importer().import(JSONArray().put(row("gizu-earn-payout", unsigned)))
    assertEquals(
      "paid",
      JSONObject(read("gizu-earn-payout"))
        .getJSONArray("operations")
        .getJSONObject(0)
        .getString("status"),
    )
    before.getJSONArray("operations").getJSONObject(0).put("revision", 99)
    importer().import(JSONArray().put(row("gizu-earn-payout", before)))
    val merged = JSONObject(read("gizu-earn-payout")).getJSONArray("operations").getJSONObject(0)
    assertEquals("paid", merged.getString("status"))
    assertEquals("100", merged.getString("receivedAtoms"))
    assertTrue(merged.getInt("revision") >= 99)
    before.getJSONArray("operations").getJSONObject(0).put("signedData", "substituted signature")
    assertThrows(IllegalStateException::class.java) {
      importer().import(JSONArray().put(row("gizu-earn-payout", before)))
    }
  }

  @Test
  fun importsIntoCurrentGenerationAndExistingJournalCanReadExactSignedBytes() {
    importer().import(JSONArray().put(row()))
    val journal =
      EarnVaultJournal(files.getValue("gizu-earn-vault-$current.enc"), { key }, wallet, current)
    assertEquals("0x1234", journal.get("op1").steps().single().getString("raw"))
    assertEquals("unknown", journal.get("op1").steps().single().getString("status"))
  }

  @Test
  fun importsNewestRevisionWithoutDroppingAnOlderSignedRecordAndIsIdempotent() {
    val older = row()
    val newer =
      row(
        data =
          JSONObject()
            .put("version", 1)
            .put("walletId", wallet)
            .put("operations", JSONArray().put(operation(3)))
      )
    importer().import(JSONArray().put(newer).put(older))
    importer().import(JSONArray().put(older))
    val result = JSONObject(read("gizu-earn-vault")).getJSONArray("operations")
    assertEquals(1, result.length())
    assertEquals(3, result.getJSONObject(0).getInt("revision"))
    assertEquals("0x1234", result.getJSONObject(0).steps().single().getString("raw"))
  }

  @Test
  fun conflictingSignedBytesOrRemovedSignedFieldsNeverReplaceCommittedEvidence() {
    importer().import(JSONArray().put(row()))
    val before = files.values.single().read()
    for (raw in listOf("0xffff", null)) {
      val conflict =
        row(
          data =
            JSONObject()
              .put("version", 1)
              .put("walletId", wallet)
              .put("operations", JSONArray().put(operation(2, raw)))
        )
      assertThrows(Exception::class.java) { importer().import(JSONArray().put(conflict)) }
      assertArrayEquals(before, files.values.single().read())
    }
  }

  @Test
  fun validatesEveryEnvelopeBeforeWritingAndRejectsFilenameOrWalletSubstitution() {
    for (bad in
      listOf(
        row().put("name", "../../wallet.enc"),
        row()
          .put(
            "data",
            JSONObject()
              .put("version", 1)
              .put("walletId", old)
              .put("operations", JSONArray())
              .toString(),
          ),
        row("unknown"),
      )) {
      assertThrows(Exception::class.java) { importer().import(JSONArray().put(row()).put(bad)) }
      assertTrue(files.values.none { it.exists() })
    }
  }

  @Test
  fun quotesAndDepositIdentityAreReboundWithoutRewritingSignedPayloadStrings() {
    val quote =
      JSONObject().put("operationId", "op1").put("revision", 1).put("recoveryEnvelope", "opaque")
    val quotes = row("gizu-earn-quotes", JSONArray().put(quote))
    val journey =
      JSONObject()
        .put("journeyId", "journey1")
        .put("walletId", wallet)
        .put("generation", old)
        .put("revision", 1)
        .put("phase", "draft")
    val deposit =
      row(
        "gizu-earn-deposit",
        JSONObject()
          .put("version", 1)
          .put("walletId", wallet)
          .put("generation", old)
          .put("journeys", JSONArray().put(journey)),
      )
    importer().import(JSONArray().put(quotes).put(deposit))
    assertEquals(
      "opaque",
      JSONArray(read("gizu-earn-quotes")).getJSONObject(0).getString("recoveryEnvelope"),
    )
    val restored = JSONObject(read("gizu-earn-deposit"))
    assertEquals(current, restored.getString("generation"))
    assertEquals(
      current,
      restored.getJSONArray("journeys").getJSONObject(0).getString("generation"),
    )
  }

  private fun confirmedMinimumReturn(kind: String): JSONObject {
    val f = EarnPayoutFixtures
    val op = withdrawalReturn().put("walletId", wallet)
    op.remove("settlement")
    val sponsored = kind == "hoodTokenReturn"
    op
      .getJSONObject("proposal")
      .put("kind", kind)
      .put("chainId", if (sponsored) 4663 else 1)
      .put("nonce", "0x0")
    if (sponsored) op.put("signedUserOperation", "original signed UserOperation")
    op
      .getJSONObject("stateBinding")
      .put("privateBaseline", JSONObject().put("baselineEnvelope", "original-baseline"))
      .getJSONObject("routeProof")
      .put("originAsset", if (sponsored) EARN_HOOD_ASSET else ETH_USDC_ORIGIN_ASSET)
      .put("recoveryEnvelope", "original-quote")
      .put("maximumCreditAtoms", "1000010")
    val receipt =
      JSONObject()
        .put("operationId", op.getString("operationId"))
        .put("revision", 10)
        .put("confidentialAddress", f.C)
        .put("assetId", EARN_MONAD_ASSET)
        .put("depositAddress", op.getJSONObject("proposal").getString("recipient"))
        .put("transactionHash", f.hash)
        .put("verifiedMinimumAtoms", "1000000")
        .put("timestampMs", f.now)
        .put("observedAtMs", 1)
        .put("authenticated", true)
        .put("operationScoped", true)
        .put("spendingAuthorized", false)
        .put("exactAmountKnown", false)
        .put("status", "minimumReceived")
        .put("verification", "minimum-return-v1")
        .put("minimumReturnEnvelope", "original-minimum-envelope")
    op.put("minimumReturnReceipt", bindMinimumReturnReceipt(op, receipt, wallet, old))
    return op
  }

  @Test
  fun restoredMinimumReturnsRemainReadableAndSequentialAcrossBothJournalsAndAnotherRestore() {
    val nextGeneration = "fa1a6a80-80f0-45b8-8ad2-a5a09f762f2a"
    for ((domain, kind) in
      listOf("gizu-earn-sponsored" to "hoodTokenReturn", "gizu-earn-liquidity" to "returnUsdc")) {
      files.clear()
      val original = confirmedMinimumReturn(kind)
      val root =
        JSONObject()
          .put("version", 1)
          .put("walletId", wallet)
          .put("operations", JSONArray().put(original))
      val archive = JSONArray().put(row(domain, root))
      importer().import(archive)
      importer().import(archive)
      val restored = JSONObject(read(domain)).getJSONArray("operations").getJSONObject(0)
      assertNotNull(savedMinimumReturnReceipt(restored, wallet, current))
      val public =
        if (kind == "hoodTokenReturn") {
          val journal =
            EarnSponsoredJournal(files.getValue("$domain-$current.enc"), { key }, wallet, current)
          journal.all().map(journal::public).single()
        } else {
          val journal =
            EarnLiquidityJournal(files.getValue("$domain-$current.enc"), { key }, wallet, current)
          journal.all().map(journal::public).single()
        }
      assertEquals("minimumReceived", public["status"])
      assertEquals("1000000", public["verifiedMinimumAtoms"])
      assertFalse(public.containsKey("creditedAtoms"))
      assertEquals(
        "original-minimum-envelope",
        restored.getJSONObject("minimumReturnReceipt").getString("minimumReturnEnvelope"),
      )
      assertEquals(1L, restored.getJSONObject("minimumReturnReceipt").getLong("observedAtMs"))
      assertEquals(original.getString("raw"), restored.getString("raw"))
      if (kind == "hoodTokenReturn")
        assertEquals(
          original.getString("signedUserOperation"),
          restored.getString("signedUserOperation"),
        )
      val expected = JSONObject(original.toString())
      expected
        .getJSONObject("minimumReturnReceipt")
        .getJSONObject("nativeBinding")
        .put("generation", current)
      assertTrue(nativeJsonEqual(expected, restored))
      val next =
        JSONObject()
          .put("operationId", "next-slot")
          .put(
            "proposal",
            JSONObject().put("kind", kind).put("confidentialAccount", EarnPayoutFixtures.C),
          )
      requireSequentialSourceCredit(listOf(restored), next, wallet, current)
      val secondArchive =
        row(domain, read(domain)).put("generation", current).put("name", "$domain-$current.enc")
      RecoveredHistoryImporter(wallet, nextGeneration, key) { files.getOrPut(it) { MemoryFile() } }
        .import(JSONArray().put(secondArchive))
      val secondFile = files.getValue("$domain-$nextGeneration.enc")
      val secondJournal =
        if (kind == "hoodTokenReturn")
          EarnSponsoredJournal(secondFile, { key }, wallet, nextGeneration).get("funding1")
        else EarnLiquidityJournal(secondFile, { key }, wallet, nextGeneration).get("funding1")
      assertNotNull(savedMinimumReturnReceipt(secondJournal, wallet, nextGeneration))
      requireSequentialSourceCredit(listOf(secondJournal), next, wallet, nextGeneration)
    }
  }

  @Test
  fun minimumReturnImportRejectsTamperedOriginalBindingsBeforeAnyJournalWrite() {
    for ((domain, kind) in
      listOf("gizu-earn-sponsored" to "hoodTokenReturn", "gizu-earn-liquidity" to "returnUsdc")) {
      for (variant in 0..5) {
        files.clear()
        val invalid = confirmedMinimumReturn(kind)
        val receipt = invalid.getJSONObject("minimumReturnReceipt")
        val binding = receipt.getJSONObject("nativeBinding")
        when (variant) {
          0 -> binding.put("generation", current)
          1 -> binding.put("walletId", old)
          2 ->
            binding
              .getJSONObject("stateBinding")
              .getJSONObject("routeProof")
              .put("recoveryEnvelope", "tampered")
          3 ->
            invalid
              .getJSONObject("proposal")
              .put("confidentialAccount", EarnPayoutFixtures.recipient)
          4 -> receipt.put("verifiedMinimumAtoms", "1000001")
          5 -> invalid.put("transactionHash", EarnPayoutFixtures.nativeHash)
        }
        val invalidRoot =
          JSONObject()
            .put("version", 1)
            .put("walletId", wallet)
            .put("operations", JSONArray().put(invalid))
        assertThrows(Exception::class.java) {
          importer().import(JSONArray().put(row()).put(row(domain, invalidRoot)))
        }
        assertTrue(files.values.none { it.exists() })
      }
    }
  }

  @Test
  fun swapAssetLedgerFollowsTheWalletIntoTheRestoredJournal() {
    val intc = "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681"
    val spcx = "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea"
    // A device that never rewrote its v1 ledger exports it without the wallet binding.
    val legacy =
      JSONObject()
        .put("version", 1)
        .put("tokens", JSONArray().put(intc))
        .put(
          "history",
          JSONObject().put("op1", JSONObject().put("operationId", "op1").put("phase", "COMPLETE")),
        )
    val newer =
      JSONObject()
        .put("version", 2)
        .put("walletId", wallet)
        .put(
          "assets",
          JSONArray()
            .put(
              JSONObject()
                .put("chainId", 4663)
                .put("token", spcx)
                .put("source", "discovered")
                .put("firstSeenAt", 7)
            ),
        )
        .put("history", JSONObject())
        .put("swept", JSONObject().put("4663", 7))
    importer()
      .import(JSONArray().put(row("gizu-holdings", legacy)).put(row("gizu-holdings", newer)))
    val restored = JSONObject(read("gizu-holdings"))
    assertEquals(2, restored.getInt("version"))
    assertEquals(wallet, restored.getString("walletId"))
    val assets = restored.getJSONArray("assets")
    assertEquals(
      listOf(intc, spcx),
      (0 until assets.length()).map { assets.getJSONObject(it).getString("token") },
    )
    assertTrue(restored.getJSONObject("history").has("op1"))
    // The restored wallet sweeps its chains again rather than trusting the old device's schedule.
    assertEquals(0, restored.getJSONObject("swept").length())
    val foreign = JSONObject(newer.toString()).put("walletId", "someone-else")
    assertThrows(Exception::class.java) {
      importer().import(JSONArray().put(row("gizu-holdings", foreign)))
    }
  }

  @Test
  fun newerSnapshotProvenanceSelectsNonRevisionedSwapWithoutTrustingArrayOrder() {
    fun swap(revision: Int, state: String) =
      row(
          "gizu-swap",
          JSONObject()
            .put("version", 1)
            .put("walletId", wallet)
            .put("operationId", "swap1")
            .put("state", state),
        )
        .put("snapshotRevision", revision)
    importer().import(JSONArray().put(swap(5, "newest")).put(swap(3, "older")))
    assertEquals("newest", JSONObject(read("gizu-swap")).getString("state"))
    assertThrows(Exception::class.java) {
      importer().import(JSONArray().put(swap(5, "conflicting")))
    }
    assertEquals("newest", JSONObject(read("gizu-swap")).getString("state"))
  }

  @Test
  fun importedSignedButUnbroadcastTransferIsReadOnlyReconciledAndRemainsResumable() = runBlocking {
    val op = operation(1)
    op.steps().single().put("from", "0xowner").put("to", "0xtarget")
    val envelope =
      row(
          data =
            JSONObject()
              .put("version", 1)
              .put("walletId", wallet)
              .put("operations", JSONArray().put(op))
        )
        .put("domain", "gizu-stored-operations")
        .put("name", "gizu-operations-$old.enc")
    importer().import(JSONArray().put(envelope))
    val journal =
      OperationJournal(files.getValue("gizu-operations-$current.enc"), { key }, wallet, current) {
        _,
        _ ->
        fail("Reconciliation cannot archive or submit")
      }
    val methods = mutableListOf<String>()
    val rpc =
      object : TransferRpc {
        override suspend fun call(method: String, params: JSONArray): Any {
          methods.add(method)
          return when (method) {
            "eth_chainId" -> "0x279f"
            "eth_getTransactionReceipt",
            "eth_getTransactionByHash" -> JSONObject.NULL
            "eth_getTransactionCount" -> "0x4"
            else -> error("Unexpected non-read RPC $method")
          }
        }
      }
    reconcileOperations(journal, rpc)
    val restored = journal.get("op1")
    assertEquals("signed", restored.steps().single().getString("status"))
    assertEquals("0x1234", restored.steps().single().getString("raw"))
    assertTrue(restored.resumable())
    assertTrue(restored.blocked())
    assertFalse(methods.any { it.startsWith("eth_send") })
  }

  private fun rolloverOperation(index: Int, settled: Boolean = index !in setOf(1, 257)) =
    operation(if (settled) 2 else 1, "0x" + index.toString(16).padStart(8, '0'))
      .put("operationId", "op$index")

  private fun transferEnvelope(indices: Iterable<Int>, allUncertain: Boolean = false) =
    row(
        data =
          JSONObject()
            .put("version", 1)
            .put("walletId", wallet)
            .put(
              "operations",
              JSONArray(
                indices.map { rolloverOperation(it, !allUncertain && it !in setOf(1, 257)) }
              ),
            )
      )
      .put("domain", "gizu-stored-operations")
      .put("name", "gizu-operations-$old.enc")

  private fun transferJournal(name: String = "gizu-operations-$current.enc") =
    OperationJournal(files.getValue(name), { key }, wallet, current) { _, _ ->
      fail("Only the importer owns restore compaction")
    }

  @Test
  fun transferRolloverRestoreArchivesSettledOverflowAndKeepsBothUncertainSignaturesActive() {
    importer().import(JSONArray().put(transferEnvelope(1..256)))
    assertEquals(256, transferJournal().all().size)
    val afterRollover = listOf(1) + (3..257)
    importer().import(JSONArray().put(transferEnvelope(afterRollover)))
    val active = transferJournal().all()
    assertEquals(256, active.size)
    assertEquals("0x00000001", transferJournal().get("op1").steps().single().getString("raw"))
    assertEquals("0x00000101", transferJournal().get("op257").steps().single().getString("raw"))
    val archived = transferJournal("gizu-operations-$current-archive-op2.enc").get("op2")
    assertEquals("0x00000002", archived.steps().single().getString("raw"))
    val all = active + archived
    assertEquals((1..257).map { "op$it" }.toSet(), all.map { it.getString("operationId") }.toSet())
    for (op in all) assertEquals(
      rolloverOperation(op.getString("operationId").removePrefix("op").toInt()).toString(),
      op.toString(),
    )
  }

  @Test
  fun interruptedRolloverCommitsArchiveBeforeActiveRootAndRetriesWithoutLosingSignedBytes() {
    importer().import(JSONArray().put(transferEnvelope(1..256)))
    val activeFile = files.getValue("gizu-operations-$current.enc")
    val before = activeFile.read()
    activeFile.failWrites = true
    val next = JSONArray().put(transferEnvelope(listOf(1) + (3..257)))
    assertThrows(Exception::class.java) { importer().import(next) }
    assertArrayEquals(before, activeFile.read())
    assertEquals(
      "0x00000002",
      transferJournal("gizu-operations-$current-archive-op2.enc")
        .get("op2")
        .steps()
        .single()
        .getString("raw"),
    )
    activeFile.failWrites = false
    importer().import(next)
    importer().import(next)
    assertEquals(256, transferJournal().all().size)
    assertEquals("0x00000101", transferJournal().get("op257").steps().single().getString("raw"))
    assertEquals(1, transferJournal("gizu-operations-$current-archive-op2.enc").all().size)
  }

  @Test
  fun moreThan256UncertainSignedTransfersFailBeforeAnyCommit() {
    importer().import(JSONArray().put(transferEnvelope(1..256, allUncertain = true)))
    val before = files.getValue("gizu-operations-$current.enc").read()
    assertThrows(Exception::class.java) {
      importer().import(JSONArray().put(transferEnvelope(2..257, allUncertain = true)))
    }
    assertArrayEquals(before, files.getValue("gizu-operations-$current.enc").read())
    assertTrue(files.filterKeys { "-archive-" in it }.values.none { it.exists() })
    assertEquals(256, transferJournal().all().size)
  }

  private fun refreshedSponsored(kind: String = "sourceFunding"): Pair<JSONObject, JSONObject> {
    val source = MemoryFile()
    val journal = EarnSponsoredJournal(source, { key }, wallet, old)
    val proposal =
      JSONObject()
        .put("kind", kind)
        .put("operationId", "source1")
        .put("revision", 7)
        .put("chainId", if (kind == "sourceFunding") 143 else 4663)
        .put("profileChainId", 4663)
        .put("cycleIndex", 2)
        .put("investmentSlot", 1)
        .put("sourceAccountIndex", 3)
        .put("fundingBatchId", "batch1")
        .put("fundingBatchSize", 1)
        .put("expectedFrom", "0x" + "1".repeat(40))
        .put("token", "0x" + "2".repeat(40))
        .put("confidentialAccount", "0x" + "3".repeat(40))
        .put("refundOwner", "0x" + "1".repeat(40))
        .put("budgetAtoms", "1000000")
        .put("withdrawalReserveAtoms", "2000")
        .put("slippageBps", 50)
        .put("vault", "0x" + "4".repeat(40))
        .put("router", "0x" + "5".repeat(40))
        .put("quoteId", "old")
        .put("deadline", 1)
    val unsigned =
      JSONObject().put("sender", proposal.getString("expectedFrom")).put("signature", "0x")
    journal.create(proposal, unsigned)
    journal.saveAuthorization(
      "source1",
      1,
      JSONObject().put("r", "exact-r").put("s", "exact-s").put("nonce", 4),
      "review",
      "hash",
    )
    fun capture(): JSONObject {
      val clear =
        CryptoEnvelope.decrypt(
          key,
          source.read(),
          "gizu-earn-sponsored:v1:$wallet:$old".toByteArray(),
        )
      return try {
        row("gizu-earn-sponsored", String(clear))
      } finally {
        clear.fill(0)
      }
    }
    val before = capture()
    val next =
      JSONObject(proposal.toString()).put("revision", 8).put("quoteId", "new").put("deadline", 999)
    if (kind == "hoodDeposit") {
      next.put("budgetAtoms", "900000")
      journal.refreshUnsignedDeposit("source1", 2, next, unsigned)
    } else journal.refreshUnsignedSource("source1", 2, next, unsigned)
    return before to capture()
  }

  @Test
  fun authorizedUnsignedSponsoredRefreshesMergeWithoutLosingExactDelegationBytes() {
    for (kind in listOf("sourceFunding", "hoodDeposit")) {
      val (before, after) = refreshedSponsored(kind)
      files.clear()
      importer().import(JSONArray().put(after).put(before))
      val journal =
        EarnSponsoredJournal(
          files.getValue("gizu-earn-sponsored-$current.enc"),
          { key },
          wallet,
          current,
        )
      assertEquals("new", journal.get("source1").getJSONObject("proposal").getString("quoteId"))
      assertEquals("exact-r", journal.get("source1").getJSONObject("authorization").getString("r"))
      assertEquals("authorizationSaved", journal.get("source1").getString("status"))
      assertFalse(journal.get("source1").sponsoredSpendSaved())
    }
  }

  @Test
  fun sponsoredRefreshCannotChangeDelegationAllocationOrAlreadySignedSpendingProposal() {
    val (before, after) = refreshedSponsored()
    for (field in
      listOf(
        "expectedFrom",
        "cycleIndex",
        "investmentSlot",
        "budgetAtoms",
        "authorization",
        "signedUserOperation",
      )) {
      files.clear()
      val original = JSONObject(before.toString())
      val newer = JSONObject(after.toString())
      val currentRoot = JSONObject(newer.getString("data"))
      val currentOp = currentRoot.getJSONArray("operations").getJSONObject(0)
      when (field) {
        "authorization" -> currentOp.getJSONObject("authorization").put("r", "substituted")
        "signedUserOperation" -> {
          val oldRoot = JSONObject(original.getString("data"))
          oldRoot
            .getJSONArray("operations")
            .getJSONObject(0)
            .put("signedUserOperation", "exact-spending-bytes")
          original.put("data", oldRoot.toString())
          currentOp.put("signedUserOperation", "exact-spending-bytes")
        }
        "cycleIndex",
        "investmentSlot" -> currentOp.getJSONObject("proposal").put(field, 3)
        else ->
          currentOp
            .getJSONObject("proposal")
            .put(field, if (field == "budgetAtoms") "1000001" else "foreign-owner")
      }
      newer.put("data", currentRoot.toString())
      assertThrows(Exception::class.java) {
        importer().import(JSONArray().put(original).put(newer))
      }
      assertTrue(files.values.none { it.exists() })
    }
  }
}
