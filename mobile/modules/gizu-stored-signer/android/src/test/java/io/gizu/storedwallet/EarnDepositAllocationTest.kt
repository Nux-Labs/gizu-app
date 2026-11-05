package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test

class EarnDepositAllocationTest {
  private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

  private fun store() =
    WalletStore(
        DepositMemoryFile(),
        object : WalletKeys {
          override fun existing() = key

          override fun create() = key

          override fun reset() = key
        },
      )
      .also { s -> DepositFixtures.record().use { s.create(it) } }

  @Test
  fun distributionIsPersistedBeforeQuotesAndNeverRerolledOnRetry() {
    val store = store()
    val id = store.load().use { store.prepareEarnDepositCycle(it, 4663, null, "100000000") }
    val original = store.load().use { savedCycleDistribution(it)!!.toString() }
    val addresses = store.load().use { cycleAddresses(it) }
    store.load().use { originalRecord ->
      val encrypted = BackupCodec.encrypt(originalRecord, ByteArray(32) { 7 })
      BackupCodec.decrypt(encrypted, ByteArray(32) { 7 }).use { restored ->
        assertEquals(originalRecord.earnCycles, restored.earnCycles)
        assertEquals(addresses, cycleAddresses(restored))
      }
    }
    assertEquals(id, store.load().use { store.prepareEarnDepositCycle(it, 4663, id, "100000000") })
    assertThrows(IllegalStateException::class.java) {
      store.load().use { store.prepareEarnDepositCycle(it, 4663, id, "2000000") }
    }
    store.load().use {
      assertEquals(original, savedCycleDistribution(it)!!.toString())
      assertEquals(addresses, cycleAddresses(it))
      assertEquals(distributionWeights(savedCycleDistribution(it)!!).size, addresses.size)
      assertNotEquals(cycleConfidential(it), addresses.first())
    }
    val withdrawals = mutableListOf<Int>()
    for (slot in addresses.indices) {
      store.selectEarnInvestmentSlot(1, slot)
      store.load().use {
        assertEquals(addresses[slot], cycleInvestmentAddress(it))
        val p =
          org.json
            .JSONObject()
            .put("cycleIndex", 1)
            .put("kind", "vaultDeposit")
            .put("expectedFrom", addresses[slot])
        attachInvestmentSlot(it, p)
        requireActiveEarnCycle(it, p)
        assertEquals(slot, p.getInt("investmentSlot"))
        if (addresses.size > 1) {
          val wrong =
            org.json.JSONObject(p.toString()).put("investmentSlot", (slot + 1) % addresses.size)
          assertThrows(IllegalStateException::class.java) { requireActiveEarnCycle(it, wrong) }
        }
        val missing = org.json.JSONObject(p.toString()).also { row -> row.remove("investmentSlot") }
        assertThrows(IllegalStateException::class.java) { requireActiveEarnCycle(it, missing) }
        withdrawals.add(store.reserveEarnWithdrawal(it))
      }
      assertEquals(withdrawals.last(), store.load().use { store.reserveEarnWithdrawal(it) })
    }
    assertEquals(addresses.size, withdrawals.distinct().size)
    store.load().use { assertEquals(withdrawals.toSet(), earnWithdrawalIndices(it)) }
  }

  @Test
  fun discardedUnsignedIdentityCannotBeReusedAndNewBudgetGetsNewCycle() {
    val store = store()
    val id = store.load().use { store.prepareEarnDepositCycle(it, 4663, null, "1000000") }
    val original = store.load().use { cycleAddresses(it) }
    store.load().use {
      assertThrows(IllegalStateException::class.java) { requireDistributionBudget(it, "2000000") }
      requireDistributionBudget(it, "1000000")
      store.completeEarnDepositCycle(it, id, abandoned = true)
    }
    assertThrows(IllegalStateException::class.java) {
      store.load().use { store.prepareEarnDepositCycle(it, 4663, id, "1000000") }
    }
    store.load().use {
      assertThrows(IllegalStateException::class.java) { requireDistributionBudget(it, "1000000") }
      val old = org.json.JSONObject().put("journeyId", id).put("phase", "paused")
      assertTrue(activeDepositDrafts(it, listOf(old)).isEmpty())
    }
    val next = store.load().use { store.prepareEarnDepositCycle(it, 4663, null, "2000000") }
    assertNotEquals(id, next)
    store.load().use {
      assertNotEquals(original, cycleAddresses(it))
      assertEquals("2000000", savedEarnCycle(it)!!.getString("distributionBudgetAtoms"))
      assertEquals(3, JSONArray(it.earnCycles).length())
    }
  }

  @Test
  fun allocationPersistsIdentityBeforeJourneyWriteAndReusesOnlyUnsignedDraft() {
    val store = store()
    val id = store.load().use { store.prepareEarnDepositCycle(it, 4663, null) }
    val pair =
      store.load().use { r ->
        assertEquals(1, r.earnCycleIndex)
        assertEquals(
          id,
          JSONArray(r.earnCycles)
            .objects()
            .single { it.getInt("cycleIndex") == 1 }
            .getString("depositJourneyId"),
        )
        cycleAddresses(r)
      }
    // Simulate death before the journal's initial atomic write.
    assertEquals(id, store.load().use { store.prepareEarnDepositCycle(it, 4663, null) })
    val j = testDepositJournal()
    val row = store.load().use { j.loadOrCreate(it, 4663, id) }
    assertEquals(id, row.getString("journeyId"))
    assertEquals(pair, store.load().use { cycleAddresses(it) })
    assertEquals(id, store.load().use { store.prepareEarnDepositCycle(it, 4663, id) })
    store.load().use { store.completeEarnDepositCycle(it, id) }
    val next = store.load().use { store.prepareEarnDepositCycle(it, 4663, null) }
    assertNotEquals(id, next)
    store.load().use {
      assertEquals(2, it.earnCycleIndex)
      assertNotEquals(pair, cycleAddresses(it))
    }
    try {
      store.load().use { store.prepareEarnDepositCycle(it, 4663, "unallocated") }
      fail("Invented allocation accepted")
    } catch (_: IllegalStateException) {}
  }
}
