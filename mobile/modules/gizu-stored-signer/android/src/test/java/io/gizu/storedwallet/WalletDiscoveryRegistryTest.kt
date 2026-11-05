package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import uniffi.gizu_stored_signer_core.walletDiscoveryCandidates

class WalletDiscoveryRegistryTest {
  private class MemoryFile : WalletFile {
    var bytes: ByteArray? = null

    override fun exists() = bytes != null

    override fun read() = bytes!!.copyOf()

    override fun write(bytes: ByteArray) {
      this.bytes = bytes.copyOf()
    }
  }

  @Test
  fun savedDistributionTracksEverySelectedSlotAndSharedConfidentialIdentityOnly() {
    DistributionDepositFixtures.record(listOf(1000, 1500, 2000, 2500, 3000)).use { record ->
      fun descriptor(derivation: String, role: String, slot: Int? = null) =
        JSONObject()
          .put("chainId", record.earnChain)
          .put("cycleIndex", record.earnCycleIndex)
          .put("derivation", derivation)
          .put("role", role)
          .also { if (slot != null) it.put("slot", slot) }
      val owners =
        (0..4).map { descriptor("distribution-v1", "invest", it) } +
          descriptor("legacy", "confidential")
      assertTrue(discoveredMetadataResolved(record, owners))
      assertFalse(discoveredMetadataResolved(record, owners + descriptor("legacy", "invest")))
      assertFalse(
        discoveredMetadataResolved(record, listOf(descriptor("distribution-v1", "invest", 5)))
      )
      val wrongCycle = JSONObject(owners[0].toString()).put("cycleIndex", record.earnCycleIndex + 1)
      assertFalse(discoveredMetadataResolved(record, listOf(wrongCycle)))
    }
    DistributionDepositFixtures.record(listOf(10000)).use { record ->
      val extra =
        JSONObject()
          .put("chainId", record.earnChain)
          .put("cycleIndex", record.earnCycleIndex)
          .put("derivation", "distribution-v1")
          .put("role", "invest")
          .put("slot", 1)
      assertFalse(discoveredMetadataResolved(record, listOf(extra)))
    }
  }

  @Test
  fun boundedScanContinuationPromptsOnceAndRevokesOnPauseExpiryOrLargerBound() {
    val consent = WalletDiscoveryConsent()
    var prompts = 0
    fun batch(bound: Int, now: Long) {
      if (!consent.permits("wallet", "generation", bound, now)) {
        prompts++
        consent.approve("wallet", "generation", bound, now)
      }
    }
    repeat(4) { batch(3, 1000L + it) }
    assertEquals(1, prompts)
    batch(4, 2000)
    assertEquals(2, prompts)
    consent.clear()
    batch(4, 2001)
    assertEquals(3, prompts)
    batch(4, 902002)
    assertEquals(4, prompts)
    assertFalse(consent.permits("wallet", "other-generation", 4, 902003))
  }

  @Test
  fun encryptedDescriptorsResumePerCandidateAndExposeReadOnlyDistributionOwners() {
    val file = MemoryFile()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    WalletRecord(
        "7aafcc2e-0891-4e31-a7d4-03780d7b4f12",
        StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
        ByteArray(32) { it.toByte() },
      )
      .use { record ->
        val registry = WalletDiscoveryRegistry(file, { key }, record)
        val candidate =
          JSONArray(walletDiscoveryCandidates(record.entropy, 4663u, 7u)).getJSONObject(6)
        registry.observed(4663, 7, 5, 1, candidate, true)
        registry.observed(4663, 7, 6, 1, null, false)
        val reopened = WalletDiscoveryRegistry(file, { key }, record)
        assertEquals(6 to 1, reopened.progress(4663, 7))
        assertEquals(0 to 0, reopened.progress(4663, 8))
        assertEquals(1, reopened.count())
        val descriptor = reopened.descriptors().single()
        assertEquals("distribution-v1", descriptor.getString("derivation"))
        assertEquals(3, descriptor.getInt("slot"))
        assertFalse(descriptor.has("address"))
        assertFalse(descriptor.has("weights"))
        assertFalse(String(file.read()).contains(candidate.getString("address")))
        val owner = reopened.owners(4663, false).single()
        assertEquals(candidate.getString("address").lowercase(), owner.second)
        assertEquals(emptyList<Pair<JSONObject, String>>(), reopened.owners(4663, true))
        assertEquals("[]", record.earnCycles)
      }
  }

  @Test
  fun allNativeFinancialSubmitRoutesRequireRecoveryAndReadRoutesDoNot() {
    for (path in
      listOf(
        "/v1/earn/native/payout/submit",
        "/v1/swap/monad/submit",
        "/v1/swap/aurora/submit-intent",
        "/v1/swap/fusion/submit",
      )) assertTrue(requiresRecoveryPersistence("https://gizu-app.onrender.com$path", "{}"))
    for (method in listOf("eth_sendRawTransaction", "eth_sendUserOperation")) assertTrue(
      requiresRecoveryPersistence(
        "https://rpc.monad.xyz",
        JSONObject().put("method", method).toString(),
      )
    )
    for (path in listOf("/quote", "/status", "/private-balance", "/settlement")) assertFalse(
      requiresRecoveryPersistence("https://gizu-app.onrender.com$path", "{}")
    )
    assertFalse(
      requiresRecoveryPersistence(
        "https://rpc.monad.xyz",
        "{\"method\":\"eth_getTransactionReceipt\"}",
      )
    )
  }
}
