package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnSponsoredSettlementTest {
  private val c = "0x" + "1".repeat(40)
  private val deposit = "0x" + "2".repeat(40)
  private val tx = "0x" + "a".repeat(64)

  private fun expected() =
    JSONObject()
      .put("operationId", "fund-1")
      .put("revision", 3)
      .put("confidentialAccount", c)
      .put("depositAddress", deposit)
      .put("transactionHash", tx)
      .put("minimumCreditAtoms", "990000")

  private fun response() =
    JSONObject()
      .put("operationId", "fund-1")
      .put("revision", 3)
      .put("confidentialAddress", c)
      .put("assetId", EARN_MONAD_ASSET)
      .put("depositAddress", deposit)
      .put("transactionHash", tx)
      .put("creditedAtoms", "990000")
      .put("timestampMs", 100000)
      .put("authenticated", true)
      .put("operationScoped", true)
      .put("status", "credited")

  @Test
  fun savedSettlementDiagnosticsContainOnlyFixedFacts() {
    val baseline = JSONObject().put("available", "0")
    val quote =
      JSONObject().put("minimumCreditAtoms", "2435822").put("maximumCreditAtoms", "2435822")
    val op =
      JSONObject()
        .put("stateBinding", JSONObject().put("privateBaseline", baseline).put("routeProof", quote))
    assertEquals(
      "baselinePresent=true baselineZero=true estimateEqualsMinimum=true",
      sponsoredSettlementReadFacts(op),
    )
    baseline.put("available", "private-value-that-must-not-be-logged")
    quote.put("maximumCreditAtoms", "private-value-that-must-not-be-logged")
    assertEquals(
      "baselinePresent=true baselineZero=false estimateEqualsMinimum=false",
      sponsoredSettlementReadFacts(op),
    )
    op.getJSONObject("stateBinding").remove("privateBaseline")
    assertEquals(
      "baselinePresent=false baselineZero=false estimateEqualsMinimum=false",
      sponsoredSettlementReadFacts(op),
    )
  }

  @Test
  fun onlyExactAuthenticatedOperationCreditCanCompleteFunding() {
    val proof = validateSponsoredSettlement(response().toString(), expected(), 100000)
    assertEquals("990000", sponsoredSettlementPublic(proof)["creditedAtoms"])
    for ((field, value) in
      listOf(
        "authenticated" to false,
        "operationScoped" to false,
        "transactionHash" to "0x" + "b".repeat(64),
        "depositAddress" to c,
        "revision" to 4,
        "creditedAtoms" to "989999",
        "timestampMs" to 39000,
      )) {
      assertThrows(Exception::class.java) {
        validateSponsoredSettlement(response().put(field, value).toString(), expected(), 100000)
      }
    }
  }

  @Test
  fun balanceDeltaSettlementRequiresStoredBaselineQuoteAndBoundedCredit() {
    val expected =
      expected()
        .put("baselineEnvelope", "baseline")
        .put("quoteEnvelope", "quote")
        .put("maximumCreditAtoms", "995000")
    val proof =
      response().put("verification", "balance-delta-v1").put("settlementEnvelope", "sealed-credit")
    validateSponsoredSettlement(proof.toString(), expected, 100000)
    assertThrows(Exception::class.java) {
      validateSponsoredSettlement(proof.put("creditedAtoms", "995001").toString(), expected, 100000)
    }
    assertThrows(Exception::class.java) {
      validateSponsoredSettlement(response().toString(), expected, 100000)
    }
    val public =
      sponsoredSettlementPublic(
        response()
          .put("verification", "balance-delta-v1")
          .put("settlementEnvelope", "secret-envelope")
      )
    assertFalse(public.toString().contains("secret-envelope"))
  }

  @Test
  fun aboveEstimateCreditNeedsAnOperationHistoryAttestation() {
    val expected =
      expected()
        .put("baselineEnvelope", "baseline")
        .put("quoteEnvelope", "quote")
        .put("maximumCreditAtoms", "995000")
    val proof =
      response()
        .put("creditedAtoms", "995001")
        .put("verification", "operation-history-v1")
        .put("settlementEnvelope", "sealed-operation-credit")
    assertEquals(
      "995001",
      validateSponsoredSettlement(proof.toString(), expected, 100000).getString("creditedAtoms"),
    )
    for (kind in listOf("balance-delta-v1", "unverified")) {
      assertThrows(Exception::class.java) {
        validateSponsoredSettlement(
          JSONObject(proof.toString()).put("verification", kind).toString(),
          expected,
          100000,
        )
      }
    }
    proof.remove("settlementEnvelope")
    assertThrows(Exception::class.java) {
      validateSponsoredSettlement(proof.toString(), expected, 100000)
    }
  }

  @Test
  fun anotherUncreditedSourceCannotShareTheCycleSnapshot() {
    val proposal = JSONObject().put("confidentialAccount", c).put("kind", "sourceFunding")
    val current = JSONObject().put("operationId", "second").put("proposal", proposal)
    val other =
      JSONObject()
        .put("operationId", "first")
        .put("proposal", proposal)
        .put("signedUserOperation", "saved")
        .put("status", "finalized")
    assertThrows(Exception::class.java) { requireSequentialSourceCredit(listOf(other), current) }
    other.put("settlement", JSONObject().put("status", "credited"))
    requireSequentialSourceCredit(listOf(other), current)
    other.put("status", "pending")
    assertThrows(Exception::class.java) { requireSequentialSourceCredit(listOf(other), current) }
    other.put("status", "reverted")
    requireSequentialSourceCredit(listOf(other), current)
  }

  @Test
  fun pendingStatusNeverEstablishesConfidentialCredit() {
    val pending = response().put("status", "awaitingSettlement").put("creditedAtoms", "0")
    assertEquals(
      "awaitingSettlement",
      validateSponsoredSettlement(pending.toString(), expected(), 100000).getString("status"),
    )
    assertThrows(IllegalStateException::class.java) {
      validateSponsoredSettlement(pending.put("creditedAtoms", "1").toString(), expected(), 100000)
    }
  }

  @Test
  fun publicCreditRequiresFinalOriginAndExactStoredAuthenticatedSettlement() {
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val file =
      object : WalletFile {
        var bytes: ByteArray? = null

        override fun exists() = bytes != null

        override fun read() = bytes!!.copyOf()

        override fun write(bytes: ByteArray) {
          this.bytes = bytes.copyOf()
        }
      }
    val j = EarnSponsoredJournal(file, { key }, "wallet", "generation")
    val p =
      JSONObject()
        .put("operationId", "fund-1")
        .put("kind", "sourceFunding")
        .put("chainId", 143)
        .put("expectedFrom", deposit)
        .put("amountAtoms", "1000000")
        .put("nonce", "0x0")
    j.create(p, JSONObject())
    j.saveSigned("fund-1", 1, tx, "private-signed-operation", "review", tx, JSONObject())
    j.update("fund-1", 2) {
      it
        .put("status", "finalized")
        .put("transactionHash", tx)
        .put("settlement", validateSponsoredSettlement(response().toString(), expected(), 100000))
    }
    val settled = j.public(j.get("fund-1"))
    assertEquals("credited", settled["status"])
    assertEquals("990000", settled["creditedAtoms"])
    assertFalse(settled.toString().contains("private-signed-operation"))
    j.update("fund-1", 3) { it.put("status", "pending") }
    val reorg = j.public(j.get("fund-1"))
    assertEquals("pending", reorg["status"])
    assertFalse(reorg.containsKey("creditedAtoms"))
    assertFalse(reorg.containsKey("settlement"))
    assertEquals(true, reorg["blocked"])
  }
}
