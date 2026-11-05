package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import org.junit.Assert.*
import org.junit.Test

class WalletStoreTest {
  private class File : WalletFile {
    var bytes: ByteArray? = null
    var fail = false

    override fun exists() = bytes != null

    override fun read() = bytes!!.copyOf()

    override fun write(bytes: ByteArray) {
      if (fail) error("disk full")
      this.bytes = bytes.copyOf()
    }
  }

  private class Keys : WalletKeys {
    var key: SecretKey? = null
    var created = 0

    override fun existing() = key

    override fun reset(): SecretKey {
      key = null
      return create()
    }

    override fun create(): SecretKey {
      created++
      return KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also { key = it }
    }
  }

  private fun wallet() =
    WalletRecord(
      "7aafcc2e-0891-4e31-a7d4-03780d7b4f12",
      StoredPasskey(byteArrayOf(1, 2, 3), ByteArray(32) { 3 }, ByteArray(32) { 4 }),
      ByteArray(32) { it.toByte() },
    )

  @Test
  fun catalogueSurvivesMoreThan256CyclesAndRestart() {
    val file = File()
    val keys = Keys()
    val store = WalletStore(file, keys)
    wallet().use {
      store.create(it)
      store.markVerified(it)
    }
    store.load().use { store.bindEarnChain(it, 4663) }
    repeat(300) { store.load().use { store.allocateEarnCycle(it, 4663) } }
    WalletStore(file, keys).load().use {
      assertEquals(300, it.earnCycleIndex)
      assertEquals(301, org.json.JSONArray(it.earnCycles).length())
    }
  }

  @Test
  fun freshCyclesKeepPreviousProfileAndWithdrawalRecipients() {
    val file = File()
    val store = WalletStore(file, Keys())
    wallet().use {
      store.create(it)
      store.markVerified(it)
    }
    store.load().use { store.bindEarnChain(it, 4663) }
    store.load().use { store.allocateEarnCycle(it, 1) }
    store.load().use {
      assertEquals(1, it.earnCycleIndex)
      assertEquals(1, it.earnChain)
      assertEquals(2, org.json.JSONArray(it.earnCycles).length())
      store.reserveEarnWithdrawal(it)
    }
    val first =
      store.load().use {
        org.json.JSONArray(it.earnCycles).getJSONObject(1).getInt("withdrawalIndex")
      }
    store.load().use { store.reserveEarnWithdrawal(it) }
    store.load().use {
      assertEquals(
        first,
        org.json.JSONArray(it.earnCycles).getJSONObject(1).getInt("withdrawalIndex"),
      )
      store.allocateEarnCycle(it, 4663)
    }
    store.load().use {
      assertEquals(2, it.earnCycleIndex)
      store.reserveEarnWithdrawal(it)
    }
    store.load().use {
      assertNotEquals(
        first,
        org.json.JSONArray(it.earnCycles).getJSONObject(2).getInt("withdrawalIndex"),
      )
    }
    store.selectEarnCycle(0)
    store.load().use {
      assertEquals(4663, it.earnChain)
      assertEquals(0, it.earnCycleIndex)
    }
  }

  @Test
  fun earnBindingIsDurableImmutableAndCoveredByExistingEntropy() {
    val file = File()
    val keys = Keys()
    val store = WalletStore(file, keys)
    wallet().use {
      store.create(it)
      store.markVerified(it)
    }
    store.load().use { store.bindEarnChain(it, 1) }
    val reopened = WalletStore(file, keys)
    reopened.load().use {
      assertEquals(1, it.earnChain)
      assertFalse(it.earnRecoveryRequired)
      assertArrayEquals(ByteArray(32) { n -> n.toByte() }, it.entropy)
      reopened.bindEarnChain(it, 1)
      assertThrows(IllegalStateException::class.java) { reopened.bindEarnChain(it, 4663) }
    }
    keys.key = null
    wallet().use { reopened.restore(it) }
    reopened.load().use {
      assertTrue(it.earnRecoveryRequired)
      assertEquals(0, it.earnChain)
      reopened.bindEarnChain(it, 1)
    }
    reopened.load().use {
      assertTrue(it.earnRecoveryRequired)
      assertEquals(1, it.earnChain)
      reopened.bindEarnChain(it, 4663)
    }
    reopened.load().use {
      assertTrue(it.earnRecoveryRequired)
      assertEquals(4663, it.earnChain)
    }
  }

  @Test
  fun earnBindingRequiresVerifiedWalletAndCommittedStorage() {
    val file = File()
    val store = WalletStore(file, Keys())
    wallet().use { store.create(it) }
    store.load().use {
      assertThrows(IllegalStateException::class.java) { store.bindEarnChain(it, 1) }
    }
    wallet().use { store.markVerified(it) }
    store.load().use {
      assertThrows(IllegalArgumentException::class.java) { store.bindEarnChain(it, 143) }
      file.fail = true
      assertThrows(IllegalStateException::class.java) { store.bindEarnChain(it, 1) }
    }
    store.load().use { assertEquals(0, it.earnChain) }
  }

  @Test
  fun roundTripRestartAndPublicStateNeverExposeEntropy() {
    val file = File()
    val keys = Keys()
    val store = WalletStore(file, keys)
    assertEquals("absent", store.state()["status"])
    wallet().use { store.create(it) }
    val reopened = WalletStore(file, keys)
    reopened.load().use { assertArrayEquals(ByteArray(32) { it.toByte() }, it.entropy) }
    assertEquals(setOf("status", "walletId"), reopened.state().keys)
    assertEquals("backupRequired", reopened.state()["status"])
    val record = reopened.load()
    record.close()
    assertTrue(record.entropy.all { it == 0.toByte() })
    assertEquals(1, keys.created)
  }

  @Test
  fun missingKeyOrCorruptionNeverRegeneratesOrOverwrites() {
    val file = File()
    val keys = Keys()
    val store = WalletStore(file, keys)
    wallet().use { store.create(it) }
    val original = file.bytes!!.copyOf()
    keys.key = null
    assertEquals("recoveryRequired", store.state()["status"])
    assertEquals(1, keys.created)
    assertThrows(IllegalStateException::class.java) { wallet().use { store.create(it) } }
    assertArrayEquals(original, file.bytes)
    file.bytes!![10] = (file.bytes!![10].toInt() xor 1).toByte()
    assertEquals("recoveryRequired", store.state()["status"])
  }

  @Test
  fun tamperAndWrongKeyFailClosed() {
    val file = File()
    val keys = Keys()
    val store = WalletStore(file, keys)
    wallet().use { store.create(it) }
    file.bytes!![file.bytes!!.lastIndex] = (file.bytes!!.last().toInt() xor 1).toByte()
    assertEquals("recoveryRequired", store.state()["status"])
    keys.key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    assertEquals("recoveryRequired", store.state()["status"])
  }

  @Test
  fun failedWriteDoesNotReportSuccessfulCreation() {
    val file = File().apply { fail = true }
    val store = WalletStore(file, Keys())
    assertThrows(IllegalStateException::class.java) { wallet().use { store.create(it) } }
    assertEquals("absent", store.state()["status"])
  }

  @Test
  fun verificationPersistsButMismatchCannotUnlockWallet() {
    val file = File()
    val store = WalletStore(file, Keys())
    wallet().use { store.create(it) }
    wallet().use { other ->
      other.entropy[0] = 99
      assertThrows(IllegalStateException::class.java) { store.markVerified(other) }
    }
    assertEquals("backupRequired", store.state()["status"])
    wallet().use { store.markVerified(it) }
    assertEquals("ready", store.state()["status"])
  }

  @Test
  fun restoreRequiresAbsentOrUnreadableStorage() {
    val file = File()
    val keys = Keys()
    val store = WalletStore(file, keys)
    wallet().use { record ->
      store.restore(record)
      assertArrayEquals(ByteArray(32) { it.toByte() }, record.entropy)
      assertEquals("ready", store.state()["status"])
      store.load().use { assertNotEquals(record.journalId, it.journalId) }
      assertThrows(IllegalStateException::class.java) { store.restore(record) }
      keys.key = null
      assertEquals("recoveryRequired", store.state()["status"])
      store.restore(record)
      store.load().use { assertArrayEquals(record.entropy, it.entropy) }
    }
  }

  @Test
  fun failedVerificationWriteLeavesBackupRequired() {
    val file = File()
    val store = WalletStore(file, Keys())
    wallet().use { store.create(it) }
    file.fail = true
    assertThrows(IllegalStateException::class.java) { wallet().use { store.markVerified(it) } }
    assertEquals("backupRequired", store.state()["status"])
  }

  @Test
  fun phaseTwoRecordRemainsSameBackupRequiredWallet() {
    val file = File()
    val keys = Keys()
    val store = WalletStore(file, keys)
    wallet().use { original ->
      val bytes =
        java.io
          .ByteArrayOutputStream()
          .apply {
            java.io.DataOutputStream(this).use { out ->
              out.writeInt(1)
              out.writeUTF(original.id)
              out.writeInt(original.credential.credentialId.size)
              out.write(original.credential.credentialId)
              out.write(original.credential.publicKeyX)
              out.write(original.credential.publicKeyY)
              out.write(original.entropy)
            }
          }
          .toByteArray()
      file.write(
        CryptoEnvelope.encrypt(
          keys.create(),
          bytes,
          "io.gizu.storedwallet.v1:wallet:gizu.io:gizu-stored-evm-v1".toByteArray(),
        )
      )
      bytes.fill(0)
      assertEquals("backupRequired", store.state()["status"])
      store.load().use { assertArrayEquals(original.entropy, it.entropy) }
      store.markVerified(original)
      assertEquals("ready", store.state()["status"])
    }
  }
}
