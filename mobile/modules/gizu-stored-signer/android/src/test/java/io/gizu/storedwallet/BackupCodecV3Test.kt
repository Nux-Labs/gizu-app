package io.gizu.storedwallet

import java.util.Base64
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class BackupCodecV3Test {
  private val prf = ByteArray(32) { 7 }

  private fun fixture() =
    checkNotNull(javaClass.getResourceAsStream("/android-compatible-backup-v3.json")).use {
      it.readBytes()
    }

  private class File : WalletFile {
    var bytes: ByteArray? = null

    override fun exists() = bytes != null

    override fun read() = bytes!!.copyOf()

    override fun write(bytes: ByteArray) {
      this.bytes = bytes.copyOf()
    }
  }

  private class Keys : WalletKeys {
    var value: SecretKey? = null

    override fun existing() = value

    override fun create() =
      value ?: KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also { value = it }

    override fun reset(): SecretKey {
      value = null
      return create()
    }
  }

  @Test
  fun swiftFixtureRestoresEveryNativeCatalogueFieldWithoutPublishingThem() {
    BackupCodec.decrypt(fixture(), prf).use { record ->
      assertArrayEquals(ByteArray(32), record.entropy)
      assertEquals(7, JSONObject(record.roleRegistry).getInt("nextRecipient"))
      assertEquals(1, record.earnChain)
      assertFalse(record.earnRecoveryRequired)
      assertEquals(2, record.earnCycleIndex)
      val rows = JSONArray(record.earnCycles)
      assertEquals(2, rows.length())
      assertEquals(4663, rows.getJSONObject(0).getInt("chainId"))
      assertEquals(3, rows.getJSONObject(0).getInt("withdrawalIndex"))
      assertEquals(1, rows.getJSONObject(1).getInt("chainId"))
      assertEquals(6, rows.getJSONObject(1).getInt("withdrawalIndex"))
      val encoded = BackupCodec.encrypt(record, prf)
      val header = JSONObject(String(encoded))
      assertEquals(3, header.getInt("version"))
      for (field in
        listOf(
          "entropy",
          "roleRegistry",
          "earnChain",
          "earnRecoveryRequired",
          "earnCycleIndex",
          "earnCycles",
        )) assertFalse(header.has(field))
      assertFalse(String(encoded).contains("nextRecipient"))
      assertFalse(String(encoded).contains("withdrawalIndex"))
      BackupCodec.decrypt(encoded, prf).use { copy ->
        assertEquals(record.roleRegistry, copy.roleRegistry)
        assertEquals(record.earnCycles, copy.earnCycles)
        assertEquals(record.earnCycleIndex, copy.earnCycleIndex)
      }
      assertThrows(Exception::class.java) { BackupCodec.decrypt(encoded, ByteArray(32) { 8 }) }
    }
  }

  @Test
  fun restorePreservesCatalogueButRequiresReconciliationBeforeAnotherCycle() {
    val store = WalletStore(File(), Keys())
    BackupCodec.decrypt(fixture(), prf).use { record ->
      store.restore(record)
      store.load().use { restored ->
        assertEquals(record.roleRegistry, restored.roleRegistry)
        assertEquals(record.earnCycles, restored.earnCycles)
        assertEquals(record.earnCycleIndex, restored.earnCycleIndex)
        assertEquals(record.earnChain, restored.earnChain)
        assertTrue(restored.verified)
        assertTrue(restored.earnRecoveryRequired)
        assertNotEquals(record.journalId, restored.journalId)
        assertThrows(IllegalStateException::class.java) { store.allocateEarnCycle(restored, 1) }
        assertThrows(IllegalStateException::class.java) { store.reserveEarnWithdrawal(restored) }
        assertEquals(setOf("status", "walletId"), restored.publicState().keys)
      }
    }
  }

  @Test
  fun distributionBackupRestoresEveryCycleSlotBudgetAndWithdrawalReceiverIntoFreshStorage() {
    BackupCodec.decrypt(fixture(), prf).use { legacy ->
      val cycles = JSONArray(legacy.earnCycles)
      fun distributionCycle(index: Int, chain: Int, weights: List<Int>, slot: Int) =
        JSONObject()
          .put("cycleIndex", index)
          .put("chainId", chain)
          .put("intentId", "distribution-$index")
          .put("distribution", JSONObject().put("version", 1).put("weightsBps", JSONArray(weights)))
          .put("investmentSlot", slot)
          .put("distributionBudgetAtoms", "100000000")
      cycles.put(
        distributionCycle(3, 1, listOf(1000, 1500, 2000, 2500, 3000), 4)
          .put(
            "withdrawalIndices",
            JSONObject().put("0", 7).put("1", 8).put("2", 9).put("3", 10).put("4", 11),
          )
      )
      cycles.put(distributionCycle(4, 4663, listOf(10000), 0))
      cycles.put(distributionCycle(5, 1, listOf(4600, 5400), 1))
      WalletRecord(
          legacy.id,
          legacy.credential,
          legacy.entropy.copyOf(),
          true,
          legacy.journalId,
          """{"version":1,"nextRecipient":12}""",
          1,
          false,
          5,
          cycles.toString(),
        )
        .use { original ->
          fun catalogue(record: WalletRecord) =
            JSONArray(record.earnCycles).objects().associate { row ->
              row.getInt("cycleIndex") to
                recordForCycle(record, row).use { cycleAddresses(it) to cycleConfidential(it) }
            }
          val expected = catalogue(original)
          val envelope = BackupCodec.encrypt(original, prf)
          val encoded = String(envelope)
          for (privateField in
            listOf(
              "distribution",
              "weightsBps",
              "withdrawalIndices",
              "distributionBudgetAtoms",
            )) assertFalse(encoded.contains(privateField))
          val destination = WalletStore(File(), Keys())
          BackupCodec.decrypt(envelope, prf).use { decoded -> destination.restore(decoded) }
          destination.load().use { restored ->
            assertEquals(original.earnCycles, restored.earnCycles)
            assertEquals(original.roleRegistry, restored.roleRegistry)
            assertNotEquals(original.journalId, restored.journalId)
            assertTrue(restored.earnRecoveryRequired)
            assertEquals(expected, catalogue(restored))
            assertEquals(listOf(5, 1, 2), listOf(3, 4, 5).map { expected.getValue(it).first.size })
            assertEquals(setOf(3, 6, 7, 8, 9, 10, 11), earnWithdrawalIndices(restored))
            for (index in 7..11) assertEquals(
              publicAccountAddress(original, index),
              publicAccountAddress(restored, index),
            )
            assertThrows(IllegalStateException::class.java) {
              destination.reserveEarnWithdrawal(restored)
            }
          }
          // Read-only selection remains available while restored spending requires reconciliation.
          destination.selectEarnInvestmentSlot(3, 4)
          destination.load().use { selected ->
            assertEquals(expected.getValue(3).first[4], cycleInvestmentAddress(selected))
            assertEquals(
              "100000000",
              savedEarnCycle(selected)!!.getString("distributionBudgetAtoms"),
            )
            assertEquals(
              11,
              savedEarnCycle(selected)!!.getJSONObject("withdrawalIndices").getInt("4"),
            )
          }
        }
    }
  }

  @Test
  fun historicalV2RegistryRemainsAuthenticatedAndEarnMetadataDefaultsToLegacy() {
    val header =
      JSONObject(String(fixture()))
        .put("version", 2)
        .put("roleRegistry", """{"version":1,"nextRecipient":9}""")
    val fields =
      listOf(
        "gizu-stored-wallet",
        "2",
        "gizu.io",
        "gizu-stored-evm-v1",
        header.getString("walletId"),
        header.getString("credentialId"),
        header.getString("x"),
        header.getString("y"),
        header.getString("roleRegistry"),
      )
    header.put(
      "envelope",
      Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(
          CryptoEnvelope.encrypt(
            SecretKeySpec(prf, "AES"),
            ByteArray(32),
            fields.joinToString(":").toByteArray(),
          )
        ),
    )
    BackupCodec.decrypt(header.toString().toByteArray(), prf).use { record ->
      assertEquals(9, JSONObject(record.roleRegistry).getInt("nextRecipient"))
      assertEquals(0, record.earnChain)
      assertEquals(0, record.earnCycleIndex)
      assertEquals("[]", record.earnCycles)
    }
    header.put("roleRegistry", """{"version":1,"nextRecipient":10}""")
    assertThrows(Exception::class.java) {
      BackupCodec.decrypt(header.toString().toByteArray(), prf)
    }
  }
}
