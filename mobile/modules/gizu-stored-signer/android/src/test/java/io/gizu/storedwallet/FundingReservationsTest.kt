package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class FundingReservationsTest {
  @Test
  fun parentCancellationReleasesOnlyItsUnsignedSourcesAndBindsMembership() {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val ledger = FundingReservations(file, { key }, "wallet", "generation") { 0L }
    val owner = "0x" + "1".repeat(40)
    val legs =
      JSONArray(
        listOf(143, 8453).map { chain ->
          JSONObject()
            .put("sourceChainId", chain)
            .put("token", fundingNetwork(chain).token)
            .put("sourceIndex", 1)
            .put("address", owner)
            .put("budgetAtoms", "100")
            .put("balanceAtoms", "100")
        }
      )
    ledger.reserveBatch("parent", "earn", 0, legs)
    ledger.bind("parent", owner, "signed", "100", 143)
    ledger.bind("parent", owner, "unsigned", "100", 8453)
    ledger.commitBatch("parent")
    ledger.markSigned("signed")
    assertThrows(IllegalStateException::class.java) {
      ledger.cancelParentUnsigned("parent", setOf("signed"))
    }
    assertThrows(IllegalStateException::class.java) { ledger.cancelBatchUnsigned("parent") }
    ledger.cancelParentUnsigned("parent", setOf("signed", "unsigned"))
    assertEquals("100", ledger.reservedAtoms(owner, 143))
    assertEquals("0", ledger.reservedAtoms(owner, 8453))
    assertTrue(ledger.hasUnsettledSigned(owner, 143))
    ledger.complete("signed")
    assertEquals("0", ledger.reservedAtoms(owner, 143))
  }

  @Test
  fun sourceObservationInvalidatesBeforeItsReservationIsReleasedOnlyOnce() {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val ledger = FundingReservations(file, { key }, "wallet", "generation") { 0L }
    val owner = "0x" + "1".repeat(40)
    ledger.reserveOperation("source", "swap", 0, owner, 1, "100", "100", 8453)
    ledger.markSigned("source")
    var invalidations = 0
    ledger.complete("source") {
      assertEquals("100", ledger.reservedAtoms(owner, 8453))
      invalidations++
    }
    assertEquals("0", ledger.reservedAtoms(owner, 8453))
    ledger.complete("source") { invalidations++ }
    assertEquals(1, invalidations)
    ledger.reserveOperation("another", "swap", 0, owner, 1, "100", "100", 8453)
    assertThrows(IllegalStateException::class.java) {
      ledger.complete("another") { error("Observation invalidation failed") }
    }
    assertEquals("100", ledger.reservedAtoms(owner, 8453))
  }

  @Test
  fun sameAddressOnDifferentFundingNetworksDoesNotCollideOrReserveOtherChains() {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val ledger = FundingReservations(file, { key }, "wallet", "generation") { 0L }
    val owner = "0x" + "1".repeat(40)
    fun leg(chain: Int, token: String) =
      JSONObject()
        .put("sourceChainId", chain)
        .put("token", token)
        .put("decimals", 6)
        .put("address", owner)
        .put("sourceIndex", 1)
        .put("budgetAtoms", "5000000")
        .put("balanceAtoms", "5000000")
    val monad = leg(143, "0x754704bc059f8c67012fed69bc8a327a5aafb603")
    val base = leg(8453, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")
    ledger.reserveBatch("combined", "swap", 0, JSONArray().put(monad).put(base))
    assertEquals(2, ledger.batch("combined").getJSONArray("legs").length())
    val restarted = FundingReservations(file, { key }, "wallet", "generation") { 0L }
    assertEquals(2, restarted.batch("combined").getJSONArray("legs").length())
    assertEquals("5000000", restarted.reservedAtoms(owner, 143))
    assertEquals("5000000", restarted.reservedAtoms(owner, 8453))
    assertEquals("0", restarted.reservedAtoms(owner, 42161))
    restarted.bind("combined", owner, "base-source", "5000000", 8453)
    restarted.markSigned("base-source")
    assertTrue(restarted.hasUnsettledSigned(owner, 8453))
    assertFalse(restarted.hasUnsettledSigned(owner, 143))
    assertThrows(IllegalStateException::class.java) {
      restarted.adoptSavedSource("base-source", owner, 1, "5000000", 0, "swap", 143)
    }
    restarted.complete("base-source")
    assertEquals("0", restarted.reservedAtoms(owner, 8453))
    assertEquals("5000000", restarted.reservedAtoms(owner, 143))
  }

  @Test
  fun sameOwnerBudgetOnAnotherChainRemainsAvailable() {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val ledger = FundingReservations(file, { key }, "wallet", "generation") { 0L }
    val owner = "0x" + "1".repeat(40)
    fun leg(chain: Int, token: String) =
      JSONObject()
        .put("sourceChainId", chain)
        .put("token", token)
        .put("decimals", 6)
        .put("address", owner)
        .put("sourceIndex", 1)
        .put("budgetAtoms", "5000000")
        .put("balanceAtoms", "5000000")
    ledger.reserveBatch(
      "base",
      "swap",
      0,
      JSONArray().put(leg(8453, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")),
    )
    ledger.reserveBatch(
      "monad",
      "earn",
      1,
      JSONArray().put(leg(143, "0x754704bc059f8c67012fed69bc8a327a5aafb603")),
    )
    assertEquals(1, ledger.batch("monad").getJSONArray("legs").length())
  }

  @Test
  fun qualifiedReservationRejectsWrongTokenAndNonFundingAccount() {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val ledger = FundingReservations(file, { key }, "wallet", "generation") { 0L }
    val base =
      JSONObject()
        .put("sourceChainId", 8453)
        .put("token", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")
        .put("address", "0x" + "1".repeat(40))
        .put("sourceIndex", 1)
        .put("budgetAtoms", "1")
        .put("balanceAtoms", "10")
    for (changed in
      listOf(
        JSONObject(base.toString()).put("token", "0x754704bc059f8c67012fed69bc8a327a5aafb603"),
        JSONObject(base.toString()).put("sourceIndex", 3),
        JSONObject(base.toString()).put("decimals", 18),
        JSONObject(base.toString()).put("sourceChainId", 196),
      )) assertThrows(IllegalStateException::class.java) {
      ledger.reserveBatch("bad", "swap", 0, JSONArray().put(changed))
    }
  }

  private class File : WalletFile {
    var data: ByteArray? = null

    override fun exists() = data != null

    override fun read() = data!!.copyOf()

    override fun write(bytes: ByteArray) {
      data = bytes.copyOf()
    }
  }

  @Test
  fun operationIdentityCannotAliasAnotherFeatureOrRecoveredOwner() {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val ledger = FundingReservations(file, { key }, "wallet", "generation") { 0L }
    val a = "0x" + "1".repeat(40)
    val b = "0x" + "2".repeat(40)
    fun leg(address: String, index: Int) =
      JSONObject()
        .put("address", address)
        .put("sourceIndex", index)
        .put("budgetAtoms", "1000000")
        .put("balanceAtoms", "3000000")
    ledger.reserveBatch("earn", "earn", 1, JSONArray().put(leg(a, 0)))
    ledger.reserveBatch("swap", "swap", 1, JSONArray().put(leg(b, 1)))
    ledger.bind("earn", a, "same", "1000000")
    ledger.bind("earn", a, "same", "1000000")
    assertThrows(IllegalStateException::class.java) { ledger.bind("swap", b, "same", "1000000") }
    assertThrows(IllegalStateException::class.java) {
      ledger.adoptSavedSource("same", b, 1, "1000000", 1, "swap")
    }
    ledger.markSigned("same")
    assertTrue(ledger.hasUnsettledSigned(a))
    assertFalse(ledger.hasUnsettledSigned(b))
  }

  @Test
  fun previouslyAliasedOperationCannotBypassAuthorityOrReleaseLocks() {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val ledger = FundingReservations(file, { key }, "wallet", "generation") { 0L }
    val a = "0x" + "1".repeat(40)
    val b = "0x" + "2".repeat(40)
    fun leg(address: String, index: Int) =
      JSONObject()
        .put("address", address)
        .put("sourceIndex", index)
        .put("budgetAtoms", "1000000")
        .put("balanceAtoms", "3000000")
    ledger.reserveBatch("earn", "earn", 1, JSONArray().put(leg(a, 0)))
    ledger.bind("earn", a, "same", "1000000")
    ledger.reserveBatch("swap", "swap", 1, JSONArray().put(leg(b, 1)))
    ledger.bind("swap", b, "different", "1000000")
    val aad = "gizu-funding-reservations:v1:wallet:generation".toByteArray()
    val saved = JSONObject(String(CryptoEnvelope.decrypt(key, file.read(), aad), Charsets.UTF_8))
    saved
      .getJSONArray("batches")
      .getJSONObject(1)
      .getJSONArray("legs")
      .getJSONObject(0)
      .put("operationId", "same")
    file.write(CryptoEnvelope.encrypt(key, saved.toString().toByteArray(), aad))
    assertThrows(IllegalStateException::class.java) { ledger.assertActive("same") }
    assertThrows(IllegalStateException::class.java) { ledger.markSigned("same") }
    assertThrows(IllegalStateException::class.java) { ledger.complete("same") }
    assertThrows(IllegalStateException::class.java) {
      ledger.adoptSavedSource("same", a, 0, "1000000", 1)
    }
    assertEquals("1000000", ledger.reservedAtoms(a))
    assertEquals("1000000", ledger.reservedAtoms(b))
  }

  @Test
  fun swapAndEarnCannotReserveTheSameFundsAndSignedReservationSurvivesRestart() {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    var now = 0L
    val ledger = FundingReservations(file, { key }, "wallet", "generation") { now }
    val address = "0x" + "1".repeat(40)
    fun leg(budget: String) =
      JSONObject()
        .put("address", address)
        .put("sourceIndex", 0)
        .put("budgetAtoms", budget)
        .put("balanceAtoms", "7000000")
    ledger.reserveBatch("earn", "earn", 0, JSONArray().put(leg("5000000")))
    assertEquals("5000000", ledger.reservedAtoms(address))
    assertThrows(IllegalStateException::class.java) {
      ledger.reserveBatch("swap", "swap", 0, JSONArray().put(leg("3000000")))
    }
    ledger.bind("earn", address, "source_1", "5000000")
    ledger.markSigned("source_1")
    now = 300000
    assertEquals(
      "5000000",
      FundingReservations(file, { key }, "wallet", "generation") { now }.reservedAtoms(address),
    )
    assertThrows(IllegalStateException::class.java) { ledger.cancelUnsigned("source_1") }
    ledger.complete("source_1")
    assertEquals("0", ledger.reservedAtoms(address))
  }

  @Test
  fun unsignedReviewExpiryReleasesOnlyUnsignedReservations() {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    var now = 0L
    val ledger = FundingReservations(file, { key }, "wallet", "generation") { now }
    val address = "0x" + "2".repeat(40)
    ledger.reserveBatch(
      "review",
      "earn",
      0,
      JSONArray()
        .put(
          JSONObject()
            .put("address", address)
            .put("sourceIndex", 1)
            .put("budgetAtoms", "1000000")
            .put("balanceAtoms", "1000000")
        ),
    )
    now = 300000
    assertEquals("0", ledger.reservedAtoms(address))
  }

  @Test
  fun incompleteBatchCannotAuthorizeAndAnotherSignedNonceBlocksTheOwner() {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val ledger = FundingReservations(file, { key }, "wallet", "generation") { 0L }
    val a = "0x" + "1".repeat(40)
    val b = "0x" + "2".repeat(40)
    fun leg(address: String) =
      JSONObject()
        .put("address", address)
        .put("sourceIndex", 0)
        .put("budgetAtoms", "1000000")
        .put("balanceAtoms", "3000000")
    ledger.reserveBatch("batch", "earn", 1, JSONArray().put(leg(a)).put(leg(b)))
    ledger.bind("batch", a, "one", "1000000")
    assertThrows(IllegalStateException::class.java) { ledger.assertActive("one") }
    assertThrows(IllegalStateException::class.java) { ledger.commitBatch("batch") }
    ledger.bind("batch", b, "two", "1000000")
    ledger.commitBatch("batch")
    ledger.assertActive("one")
    ledger.reserveBatch("swap", "swap", 1, JSONArray().put(leg(a)))
    ledger.bind("swap", a, "swap-one", "1000000")
    ledger.markSigned("one")
    assertThrows(IllegalStateException::class.java) { ledger.assertActive("swap-one") }
    ledger.complete("one")
    ledger.assertActive("swap-one")
  }

  @Test
  fun startedEarnBatchCannotDiscardUnsignedSiblingEvenAfterFirstCreditAndRestart() {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val ledger = FundingReservations(file, { key }, "wallet", "generation") { 0L }
    val a = "0x" + "1".repeat(40)
    val b = "0x" + "2".repeat(40)
    fun leg(address: String, index: Int) =
      JSONObject()
        .put("address", address)
        .put("sourceIndex", index)
        .put("budgetAtoms", "1000000")
        .put("balanceAtoms", "3000000")
    ledger.reserveBatch("batch", "earn", 1, JSONArray().put(leg(a, 1)).put(leg(b, 3)))
    ledger.bind("batch", a, "one", "1000000")
    ledger.bind("batch", b, "two", "1000000")
    ledger.commitBatch("batch")
    ledger.assertCancellationAllowed("two")
    ledger.markSigned("one")
    ledger.complete("one")
    val recovered = FundingReservations(file, { key }, "wallet", "generation") { 300000L }
    assertThrows(IllegalStateException::class.java) { recovered.assertCancellationAllowed("two") }
    assertThrows(IllegalStateException::class.java) { recovered.cancelUnsigned("two") }
    recovered.assertActive("two")
    assertFalse(
      recovered.batch("batch").getJSONArray("legs").getJSONObject(1).optBoolean("cancelled")
    )
  }

  @Test
  fun importedSavedAuthorityAlsoBlocksAnAlreadyRegisteredOtherFeature() {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val ledger = FundingReservations(file, { key }, "wallet", "generation") { 0L }
    val a = "0x" + "1".repeat(40)
    ledger.reserveBatch(
      "swap",
      "swap",
      0,
      JSONArray()
        .put(
          JSONObject()
            .put("address", a)
            .put("sourceIndex", 0)
            .put("budgetAtoms", "1000000")
            .put("balanceAtoms", "3000000")
        ),
    )
    ledger.bind("swap", a, "queued-swap", "1000000")
    ledger.adoptSavedSource("legacy-source", a, 0, "1000000", 0)
    assertThrows(IllegalStateException::class.java) { ledger.assertActive("queued-swap") }
    assertTrue(
      FundingReservations(file, { key }, "wallet", "generation") { 999999L }.hasUnsettledSigned(a)
    )
    ledger.complete("legacy-source")
    ledger.assertActive("queued-swap")
  }

  @Test
  fun swapRecoveryIsIndependentOfTheSelectedEarnCycleButEarnBindingIsImmutable() {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val ledger = FundingReservations(file, { key }, "wallet", "generation") { 0L }
    val a = "0x" + "1".repeat(40)
    fun leg() =
      JSONObject()
        .put("address", a)
        .put("sourceIndex", 1)
        .put("budgetAtoms", "1000000")
        .put("balanceAtoms", "3000000")
    ledger.reserveBatch("swap", "swap", 2, JSONArray().put(leg()))
    ledger.bind("swap", a, "swap-source", "1000000")
    ledger.adoptSavedSource("swap-source", a, 1, "1000000", 0, "swap")
    assertTrue(ledger.hasUnsettledSigned(a))
    ledger.reserveBatch("earn", "earn", 2, JSONArray().put(leg()))
    ledger.bind("earn", a, "earn-source", "1000000")
    assertThrows(IllegalStateException::class.java) {
      ledger.adoptSavedSource("earn-source", a, 1, "1000000", 3)
    }
  }
}
