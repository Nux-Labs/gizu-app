package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnMinimumReturnTest {
  private val f = EarnPayoutFixtures

  private fun returned(kind: String = "returnUsdc"): JSONObject {
    val op = withdrawalReturn().put("walletId", f.wallet)
    op.remove("settlement")
    op.getJSONObject("proposal").put("kind", kind).put("nonce", "0x0")
    op
      .getJSONObject("stateBinding")
      .put("privateBaseline", JSONObject().put("baselineEnvelope", "baseline"))
      .getJSONObject("routeProof")
      .put("recoveryEnvelope", "quote")
      .put("maximumCreditAtoms", "1000010")
    return op
  }

  private fun receipt(op: JSONObject): JSONObject =
    JSONObject()
      .put("operationId", op.getString("operationId"))
      .put("revision", op.getInt("revision") - 1)
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
      .put("minimumReturnEnvelope", "minimum-purpose-envelope")

  private fun boundReceipt(op: JSONObject): JSONObject =
    bindMinimumReturnReceipt(op, receipt(op), f.wallet, "generation")

  @Test
  fun returnReadsOptIntoHistoricalRecoveryWithoutChangingTheMinimumProofContract() {
    val headers = sponsoredSettlementRequestHeaders(returned())
    assertEquals("minimum-return-v1", headers["x-gizu-settlement-proof"])
    assertEquals("v1", headers["x-gizu-return-history-recovery"])
    assertFalse(
      sponsoredSettlementRequestHeaders(null).containsKey("x-gizu-return-history-recovery")
    )
  }

  @Test
  fun historicalObservationCanReplayWithFreshResponseButNeverBecomesExact() {
    val op = returned()
    val expected = sponsoredSettlementExpected(op).put("revision", 10)
    val proof = validateMinimumReturnReceipt(receipt(op).toString(), expected, "returnUsdc", f.now)
    assertEquals(1L, proof.getLong("observedAtMs"))
    assertThrows(Exception::class.java) {
      validateSponsoredSettlement(proof.toString(), expected, f.now)
    }
    assertThrows(Exception::class.java) {
      validateMinimumReturnReceipt(proof.toString(), expected, "sourceFunding", f.now)
    }
  }

  @Test
  fun allReturnAssetsRequireTheirSavedOriginAndNativeSignedOperation() {
    for ((kind, origin) in
      listOf(
        "returnUsdc" to ETH_USDC_ORIGIN_ASSET,
        "returnEth" to ETH_NATIVE_ORIGIN_ASSET,
        "hoodTokenReturn" to EARN_HOOD_ASSET,
      )) {
      val op = returned(kind)
      op.getJSONObject("stateBinding").getJSONObject("routeProof").put("originAsset", origin)
      if (kind == "hoodTokenReturn") {
        op.getJSONObject("proposal").put("chainId", 4663)
        op.put("signedUserOperation", "signed")
      }
      val expected = sponsoredSettlementExpected(op).put("revision", 10)
      validateMinimumReturnReceipt(receipt(op).toString(), expected, kind, f.now)
      val bound = boundReceipt(op)
      op.put("minimumReturnReceipt", bound)
      assertNotNull(savedMinimumReturnReceipt(op, f.wallet, "generation"))
      assertThrows(Exception::class.java) {
        validateMinimumReturnReceipt(
          receipt(op).toString(),
          expected.put("originAsset", EARN_MONAD_ASSET),
          kind,
          f.now,
        )
      }
    }
  }

  @Test
  fun malformedMinimumProofCannotCompleteReturn() {
    val op = returned()
    val expected = sponsoredSettlementExpected(op).put("revision", 10)
    for ((field, value) in
      listOf(
        "operationId" to "other",
        "revision" to 9,
        "revision" to "10",
        "confidentialAddress" to f.owner,
        "assetId" to ETH_USDC_ORIGIN_ASSET,
        "depositAddress" to f.owner,
        "transactionHash" to f.nativeHash,
        "verifiedMinimumAtoms" to "999999",
        "verifiedMinimumAtoms" to "1000001",
        "verification" to "minimum-return-v2",
        "status" to "credited",
        "authenticated" to false,
        "authenticated" to "true",
        "operationScoped" to false,
        "spendingAuthorized" to true,
        "exactAmountKnown" to true,
        "minimumReturnEnvelope" to "",
        "creditedAtoms" to "1000000",
        "settlementEnvelope" to "source-credit",
        "sourceCreditEnvelope" to "source-credit",
        "observedAtMs" to -1,
        "observedAtMs" to f.now + 5001,
        "timestampMs" to f.now - 60001,
      )) assertThrows("field $field", Exception::class.java) {
      validateMinimumReturnReceipt(
        receipt(op).put(field, value).toString(),
        expected,
        "returnUsdc",
        f.now,
      )
    }
    for (missing in listOf("spendingAuthorized", "exactAmountKnown", "minimumReturnEnvelope")) {
      val proof = receipt(op).also { it.remove(missing) }
      assertThrows(Exception::class.java) {
        validateMinimumReturnReceipt(proof.toString(), expected, "returnUsdc", f.now)
      }
    }
  }

  @Test
  fun committedMinimumRequiresUnchangedSavedQuoteBaselineWalletAndCanonicalOrigin() {
    for (variant in 0..9) {
      val op = returned().also { it.put("minimumReturnReceipt", boundReceipt(it)) }
      when (variant) {
        0 -> op.put("walletId", "another-wallet")
        1 -> op.getJSONObject("proposal").put("kind", "sourceFunding")
        2 -> op.getJSONObject("proposal").put("investmentSlot", 2)
        3 ->
          op
            .getJSONObject("stateBinding")
            .getJSONObject("privateBaseline")
            .put("baselineEnvelope", "other")
        4 ->
          op
            .getJSONObject("stateBinding")
            .getJSONObject("routeProof")
            .put("recoveryEnvelope", "other")
        5 -> op.put("transactionHash", f.nativeHash)
        6 -> op.put("revision", 10)
        7 -> op.put("status", "pending")
        8 -> op.getJSONObject("minimumReturnReceipt").put("verifiedMinimumAtoms", "1000001")
        9 -> op.remove("raw")
      }
      assertThrows(Exception::class.java) { savedMinimumReturnReceipt(op, f.wallet, "generation") }
    }
    val op = returned().also { it.put("minimumReturnReceipt", boundReceipt(it)) }
    assertNotNull(savedMinimumReturnReceipt(op, f.wallet, "generation"))
    assertThrows(Exception::class.java) {
      savedMinimumReturnReceipt(op, f.wallet, "new-generation")
    }
    op.put("revision", 20)
    assertNotNull(savedMinimumReturnReceipt(op, f.wallet, "generation"))
  }

  @Test
  fun sequentialSlotsAcceptOnlyCommittedValidReturnsAndNeverCreatePayoutCredit() {
    val first = returned().also { it.put("minimumReturnReceipt", boundReceipt(it)) }
    val current =
      JSONObject()
        .put("operationId", "next")
        .put(
          "proposal",
          JSONObject()
            .put("kind", "returnEth")
            .put("investmentSlot", 1)
            .put("confidentialAccount", f.C),
        )
    requireSequentialSourceCredit(listOf(first), current, f.wallet, "generation")
    assertThrows(Exception::class.java) { requireSequentialSourceCredit(listOf(first), current) }
    val otherSlot = returned().put("operationId", "slot-1")
    otherSlot
      .getJSONObject("proposal")
      .put("operationId", "slot-1")
      .put("investmentSlot", 1)
      .put("recipient", f.recipient)
    otherSlot
      .getJSONObject("stateBinding")
      .getJSONObject("routeProof")
      .put("operationId", "slot-1")
      .put("recipient", f.recipient)
    otherSlot.put("minimumReturnReceipt", boundReceipt(otherSlot))
    requireSequentialSourceCredit(listOf(first, otherSlot), current, f.wallet, "generation")
    otherSlot.remove("minimumReturnReceipt")
    assertThrows(Exception::class.java) {
      requireSequentialSourceCredit(listOf(first, otherSlot), current, f.wallet, "generation")
    }
    val second = JSONObject(first.toString()).put("operationId", "other")
    assertThrows(Exception::class.java) {
      requireSequentialSourceCredit(listOf(first, second), current, f.wallet, "generation")
    }
    assertThrows(Exception::class.java) { nativeWithdrawalSource(first, 11, f.owner, f.C, 1, 2) }
    first
      .getJSONObject("proposal")
      .put("kind", "sourceFunding")
      .put("chainId", 143)
      .put("profileChainId", 1)
    first.put("signedUserOperation", "original signed source")
    assertThrows(Exception::class.java) {
      nativePayoutSource(first, 11, PayoutIdentities(f.owner, f.C, f.recipient), 1)
    }
    assertThrows(Exception::class.java) {
      requireSequentialSourceCredit(listOf(first), current, f.wallet, "generation")
    }
  }

  private fun memoryFile(): WalletFile =
    object : WalletFile {
      var bytes: ByteArray? = null

      override fun exists() = bytes != null

      override fun read() = bytes!!.copyOf()

      override fun write(bytes: ByteArray) {
        this.bytes = bytes.copyOf()
      }
    }

  @Test
  fun minimumProofCannotBeRelabelledAsAnExactCredit() {
    val op = returned()
    val aliased =
      receipt(op)
        .put("status", "credited")
        .put("creditedAtoms", "1000000")
        .put("verification", "operation-history-v1")
        .put("settlementEnvelope", "exact-credit")
    assertThrows(Exception::class.java) {
      validateSponsoredSettlement(
        aliased.toString(),
        sponsoredSettlementExpected(op).put("revision", 10),
        f.now,
      )
    }
  }

  @Test
  fun minimumConfirmationInvalidatesTheWholeOwnedAssetSetAndPendingDoesNot() {
    val op = returned()
    val proof = receipt(op).put("revision", op.getInt("revision"))
    val targets = earnPrivateCreditInvalidationTargets(op, proof)!!
    assertEquals(1L, targets.first)
    assertEquals(setOf(ETH_EARN_USDC, ETH_EARN_VAULT, ETH_EARN_WETH, "native"), targets.second)
    proof.put("status", "awaitingSettlement").put("verifiedMinimumAtoms", "0")
    proof.remove("minimumReturnEnvelope")
    assertNull(earnPrivateCreditInvalidationTargets(op, proof))
    proof
      .put("status", "minimumReceived")
      .put("verifiedMinimumAtoms", "1000001")
      .put("minimumReturnEnvelope", "minimum")
    assertThrows(Exception::class.java) { earnPrivateCreditInvalidationTargets(op, proof) }
  }

  @Test
  fun minimumCapabilityDoesNotChangeExactFundingOrPreviouslyCreditedReturns() {
    assertEquals("minimum-return-v1", sponsoredSettlementCapability(returned()))
    assertEquals("operation-history-v1", sponsoredSettlementCapability(f.source()))
    assertEquals("operation-history-v1", sponsoredSettlementCapability(withdrawalReturn()))
    assertEquals("operation-history-v1", sponsoredSettlementCapability(null))
    for (kind in listOf("returnUsdc", "returnEth", "hoodTokenReturn")) {
      assertEquals("minimum-return-v1", sponsoredSettlementCapability(returned(kind)))
    }
  }

  @Test
  fun pendingMinimumPersistsWithoutCompletionThenReplayKeepsOriginalObservation() {
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val journal = EarnLiquidityJournal(memoryFile(), { key }, f.wallet, "generation")
    val original = returned()
    journal.create(original.getJSONObject("proposal"))
    journal.update("funding1", 1) { saved ->
      for (field in listOf("status", "raw", "transactionHash", "stateBinding")) saved.put(
        field,
        original.get(field),
      )
    }
    val pending =
      receipt(journal.get("funding1"))
        .put("revision", 2)
        .put("status", "awaitingSettlement")
        .put("verifiedMinimumAtoms", "0")
    pending.remove("minimumReturnEnvelope")
    val checked =
      validateMinimumReturnObservation(
        pending.toString(),
        sponsoredSettlementExpected(journal.get("funding1")),
        "returnUsdc",
        f.now,
      )
    val first =
      journal.update("funding1", 2) { saveSponsoredSettlement(it, checked, f.wallet, "generation") }
    assertFalse(first.has("minimumReturnReceipt"))
    assertFalse(first.has("settlement"))
    assertEquals("awaitingSettlement", journal.public(first)["status"])
    assertFalse(journal.public(first).containsKey("minimumReturnReceipt"))
    val complete = receipt(first).put("revision", 3)
    val committed =
      journal.update("funding1", 3) {
        saveSponsoredSettlement(it, complete, f.wallet, "generation")
      }
    assertEquals(4, committed.getInt("revision"))
    assertEquals(
      1L,
      savedMinimumReturnReceipt(committed, f.wallet, "generation")!!.getLong("observedAtMs"),
    )
    val restored = journal.get("funding1")
    val replay = receipt(restored).put("revision", 4).put("timestampMs", f.now + 1000000)
    validateMinimumReturnReceipt(
      replay.toString(),
      sponsoredSettlementExpected(restored),
      "returnUsdc",
      f.now + 1000000,
    )
    val replayed =
      journal.update("funding1", 4) { saveSponsoredSettlement(it, replay, f.wallet, "generation") }
    assertEquals(
      1L,
      savedMinimumReturnReceipt(replayed, f.wallet, "generation")!!.getLong("observedAtMs"),
    )
    assertFalse(replayed.has("settlement"))
    assertFalse(journal.public(replayed).containsKey("creditedAtoms"))
    assertThrows(Exception::class.java) {
      journal.update("funding1", 4) { saveSponsoredSettlement(it, replay, f.wallet, "generation") }
    }
    val stale = JSONObject(replayed.toString()).put("status", "pending")
    assertFalse(journal.public(stale).containsKey("minimumReturnReceipt"))
  }

  @Test
  fun bothJournalsExposeMinimumWithoutExactCreditOrPrivateEnvelope() {
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val op = returned().also { it.put("minimumReturnReceipt", boundReceipt(it)) }
    val ethereum = EarnLiquidityJournal(memoryFile(), { key }, f.wallet, "generation")
    val eth = ethereum.public(op)
    assertEquals("minimumReceived", eth["status"])
    assertEquals("1000000", eth["verifiedMinimumAtoms"])
    assertTrue(eth.containsKey("minimumReturnReceipt"))
    assertFalse(eth.containsKey("creditedAtoms"))
    assertFalse(eth.containsKey("settlement"))
    assertFalse(eth.toString().contains("minimum-purpose-envelope"))
    op.getJSONObject("proposal").put("kind", "hoodTokenReturn").put("chainId", 4663)
    op.getJSONObject("stateBinding").getJSONObject("routeProof").put("originAsset", EARN_HOOD_ASSET)
    op.put("signedUserOperation", "signed")
    op.put("minimumReturnReceipt", boundReceipt(op))
    val sponsored = EarnSponsoredJournal(memoryFile(), { key }, f.wallet, "generation")
    val hood = sponsored.public(op)
    assertEquals("minimumReceived", hood["status"])
    assertEquals("1000000", hood["verifiedMinimumAtoms"])
    assertFalse(hood.containsKey("creditedAtoms"))
    assertFalse(hood.containsKey("settlement"))
    assertFalse(hood.toString().contains("minimum-purpose-envelope"))
  }
}
