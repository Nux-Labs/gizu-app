package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import uniffi.gizu_stored_signer_core.deriveAccountAddresses
import uniffi.gizu_stored_signer_core.deriveEarnCycleConfidentialAddress

class SharedEarnPrivateAccountTest {
  @Test
  fun newReturnsUseAccountTwoEvenWhenHistoricalFundingUsedAnotherAccount() {
    DepositFixtures.record().use { record ->
      val old = cycleConfidential(record)
      val shared = deriveAccountAddresses(record.entropy)[2]
      for (kind in listOf("hoodTokenReturn", "returnUsdc", "returnEth")) {
        requireFreshEarnPrivateAccount(record, kind, shared)
        assertThrows(IllegalStateException::class.java) {
          requireFreshEarnPrivateAccount(record, kind, old)
        }
      }
      requireFreshEarnPrivateAccount(record, "sourceFunding", old)
    }
  }

  @Test
  fun unsettledSignedPayoutReservesSharedCashUntilPaid() {
    val shared = "0x" + "2".repeat(40)
    val payout =
      JSONObject()
        .put("status", "submitted")
        .put("signedData", JSONObject())
        .put("proposal", JSONObject().put("expectedSigner", shared))
    assertThrows(IllegalStateException::class.java) {
      requireSettledSharedPayouts(listOf(payout), shared)
    }
    payout.put("status", "paid")
    requireSettledSharedPayouts(listOf(payout), shared)
    payout.put("status", "submitted")
    requireSettledSharedPayouts(listOf(payout), "0x" + "3".repeat(40))
  }

  @Test
  fun cancelledSwapWithSignedUncreditedFundingStillReservesAccountTwo() {
    val state =
      JSONObject()
        .put("cancelled", true)
        .put("step", JSONObject().put("step", "credit"))
        .put(
          "data",
          JSONObject()
            .put("signedOperation", JSONObject().put("signature", "signed"))
            .put("payouts", org.json.JSONArray())
            .put("available", "0"),
        )
    assertThrows(IllegalStateException::class.java) { assertSavedSwapPrivateWorkFinished(state) }
    state.getJSONObject("data").put("creditBasis", "authenticated_balance")
    assertSavedSwapPrivateWorkFinished(state)
  }

  @Test
  fun incomingJournalReadsWorkBeforeEarnAndOnBothProfiles() {
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    for (chain in listOf(0, 1, 4663)) {
      WalletRecord(
          DepositFixtures.wallet,
          StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
          ByteArray(32),
          true,
          earnChain = chain,
        )
        .use { record ->
          val files = mutableMapOf<String, DepositMemoryFile>()
          assertTrue(
            earnPrivateCreditRows(
                record,
                { name -> files.getOrPut(name) { DepositMemoryFile() } },
                { key },
              )
              .isEmpty()
          )
          assertEquals(setOf("sponsored", "liquidity"), files.keys)
        }
    }
  }

  @Test
  fun minedCancellationReleasesSharedCreditButPendingCancellationDoesNot() {
    val shared = "0x" + "2".repeat(40)
    val incoming =
      JSONObject()
        .put("operationId", "new-return")
        .put("proposal", JSONObject().put("confidentialAccount", shared))
    val cancelled =
      JSONObject()
        .put("operationId", "old-return")
        .put("status", "nonceCancelled")
        .put("raw", "saved-signed-transaction")
        .put("proposal", JSONObject().put("kind", "returnUsdc").put("confidentialAccount", shared))
    requireSequentialSourceCredit(listOf(cancelled), incoming)
    assertThrows(IllegalStateException::class.java) {
      requireSequentialSourceCredit(
        listOf(JSONObject(cancelled.toString()).put("status", "cancellationPending")),
        incoming,
      )
    }
  }

  private fun store(): WalletStore {
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    return WalletStore(
        DepositMemoryFile(),
        object : WalletKeys {
          override fun existing() = key

          override fun create() = key

          override fun reset() = key
        },
      )
      .also { store -> DepositFixtures.record().use { store.create(it) } }
  }

  @Test
  fun firstEarnPreparationUsesSharedPrivateCash() {
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val fresh =
      WalletStore(
        DepositMemoryFile(),
        object : WalletKeys {
          override fun existing() = key

          override fun create() = key

          override fun reset() = key
        },
      )
    WalletRecord(
        DepositFixtures.wallet,
        StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
        ByteArray(32),
        true,
      )
      .use { fresh.create(it) }
    fresh.load().use { fresh.bindEarnChain(it, 1) }
    fresh.load().use { record ->
      assertEquals(deriveAccountAddresses(record.entropy)[2], cycleConfidential(record))
    }
  }

  @Test
  fun newInvestmentsShareAccountTwoAndPreserveTheirDestinationsAcrossBackup() {
    val store = store()
    for (chain in listOf(1, 4663)) {
      store.load().use { store.allocateEarnCycle(it, chain, "1000000") }
      store.load().use { record ->
        val shared = deriveAccountAddresses(record.entropy)[2]
        assertEquals(shared, cycleConfidential(record))
        val addresses = cycleAddresses(record)
        assertFalse(addresses.contains(shared))
        val encrypted = BackupCodec.encrypt(record, ByteArray(32) { 7 })
        BackupCodec.decrypt(encrypted, ByteArray(32) { 7 }).use { restored ->
          assertEquals(shared, cycleConfidential(restored))
          assertEquals(addresses, cycleAddresses(restored))
        }
      }
    }
  }

  @Test
  fun guidedDepositUsesAccountTwoAndReadAuthenticationSignsForThatAccount() {
    val store = store()
    store.load().use { store.prepareEarnDepositCycle(it, 4663, null, "1000000") }
    store.load().use { record ->
      val shared = deriveAccountAddresses(record.entropy)[2]
      assertEquals(shared, cycleConfidential(record))
      val now = System.currentTimeMillis().toULong()
      val auth = cycleReadAuth(record, ByteArray(4) { 1 }, ByteArray(7) { 2 }, now, now)
      assertEquals(shared.lowercase(), JSONObject(auth.payload).getString("signer_id"))
      assertEquals(0, JSONObject(auth.payload).getJSONArray("intents").length())
    }
  }

  @Test
  fun recoveryCannotChangeAHistoricalCyclesPrivateIdentity() {
    for (localShared in listOf(false, true)) {
      val store = store()
      store.load().use { store.allocateEarnCycle(it, 4663, "1000000") }
      val metadata =
        store.load().use { record ->
          val cycles = org.json.JSONArray(record.earnCycles)
          val cycle =
            cycles.objects().single { it.getInt("cycleIndex") == if (localShared) 1 else 0 }
          if (localShared) cycle.remove("privateAccount") else cycle.put("privateAccount", "shared")
          JSONObject()
            .put("earnCycles", cycles.toString())
            .put("roleRegistry", record.roleRegistry)
            .put("earnCycleIndex", record.earnCycleIndex)
        }
      assertThrows(IllegalStateException::class.java) { store.mergeRecovery(metadata) }
    }
  }

  @Test
  fun sharedCycleDiscoveryCanAuthenticateItsHistoricalCandidateExplicitly() {
    val store = store()
    store.load().use { store.allocateEarnCycle(it, 4663, "1000000") }
    store.load().use { sharedRecord ->
      for (chain in listOf(1, 4663)) {
        recordForCycle(
            sharedRecord,
            JSONObject().put("chainId", chain).put("cycleIndex", sharedRecord.earnCycleIndex),
          )
          .use { record ->
            val candidate =
              deriveEarnCycleConfidentialAddress(
                record.entropy,
                chain.toULong(),
                record.earnCycleIndex.toUInt(),
              )
            val now = System.currentTimeMillis().toULong()
            val auth =
              cycleReadAuth(record, ByteArray(4) { 1 }, ByteArray(7) { 2 }, now, now, candidate)
            assertEquals(candidate.lowercase(), JSONObject(auth.payload).getString("signer_id"))
          }
      }
    }
  }

  @Test
  fun savedHistoricalInvestmentKeepsItsOriginalFundingIdentity() {
    DepositFixtures.record().use { record ->
      assertEquals(
        deriveEarnCycleConfidentialAddress(record.entropy, 4663uL, 0u),
        cycleConfidential(record),
      )
    }
  }
}
