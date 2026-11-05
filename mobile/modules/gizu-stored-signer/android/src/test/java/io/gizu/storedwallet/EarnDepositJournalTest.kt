package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnDepositJournalTest {
  @Test
  fun distributionJournalPersistsSlotsAndAllowsOnlyTheirIndependentChildren() {
    distributionDepositRecord().use { record ->
      val file = File()
      val journal = journal(file)
      val first = journal.loadOrCreate(record, 4663, null)
      val id = first.getString("journeyId")
      assertEquals(listOf(2500, 7500), distributionWeights(first.getJSONObject("distribution")))
      assertEquals(
        listOf(0, 1),
        first.getJSONArray("destinations").objects().map { it.getInt("slot") },
      )
      assertTrue(
        first.getJSONArray("destinations").objects().all { it.getString("role") == "invest" }
      )
      val public = JSONObject(journal.publicSnapshot(id))
      assertEquals(
        listOf("pending", "pending"),
        public.getJSONArray("investments").objects().map { it.getString("status") },
      )
      for ((stage, child) in
        listOf(
          "invest:0" to "payout0",
          "invest:1" to "payout1",
          "deposit" to "vault0",
          "deposit" to "vault1",
        )) journal.attachChild(id, journal.get(id).getInt("revision"), stage, child)
      assertThrows(IllegalStateException::class.java) {
        journal.attachChild(id, journal.get(id).getInt("revision"), "hold", "legacy")
      }
      assertThrows(IllegalStateException::class.java) {
        journal.attachChild(id, journal.get(id).getInt("revision"), "invest:2", "invalid")
      }
      assertThrows(IllegalStateException::class.java) {
        journal.attachChild(id, journal.get(id).getInt("revision"), "deposit", "extra")
      }
      val restored = journal(file).get(id)
      assertEquals(2, restored.getJSONObject("children").getJSONArray("deposit").length())
      assertEquals(
        first.getJSONObject("distribution").toString(),
        restored.getJSONObject("distribution").toString(),
      )
    }
  }

  @Test
  fun distributionPauseKeepsCompletedReceiptsAndExposesTheOriginalBudget() {
    distributionDepositRecord(budgetAtoms = "1010000").use { record ->
      val journal = journal(File())
      val first = journal.loadOrCreate(record, 4663, null)
      val id = first.getString("journeyId")
      journal.update(id, first.getInt("revision")) {
        val slots = it.getJSONArray("investments")
        slots
          .getJSONObject(0)
          .put("status", "invested")
          .put("receivedAtoms", "247500")
          .put("depositedAtoms", "226500")
          .put("sharesAtoms", "226500")
          .put("transactionHash", "0x" + "a".repeat(64))
          .put("privateProof", "secret")
        slots.getJSONObject(1).put("status", "received").put("receivedAtoms", "742500")
      }
      journal.pause(id, "cancelled")
      val public = JSONObject(journal.publicSnapshot(id))
      assertEquals("1010000", public.getString("distributionBudgetAtoms"))
      val investments = public.getJSONArray("investments")
      assertEquals("invested", investments.getJSONObject(0).getString("status"))
      assertEquals("226500", investments.getJSONObject(0).getString("depositedAtoms"))
      assertEquals("0x" + "a".repeat(64), investments.getJSONObject(0).getString("transactionHash"))
      assertEquals("paused", investments.getJSONObject(1).getString("status"))
      assertEquals("742500", investments.getJSONObject(1).getString("receivedAtoms"))
      assertFalse(public.toString().contains("secret"))
      distributionDepositRecord(listOf(5000, 5000)).use { changed ->
        assertThrows(IllegalStateException::class.java) { journal.loadOrCreate(changed, 4663, id) }
      }
    }
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

  private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

  private fun journal(f: File, generation: String = DepositFixtures.wallet) =
    EarnDepositJournal(f, { key }, DepositFixtures.wallet, generation)

  @Test
  fun draftIdentityReusesAllocationAndPrivateReviewNeverLeaks() {
    val f = File()
    val j = journal(f)
    DepositFixtures.record().use { r ->
      val first = j.loadOrCreate(r, 4663, null)
      assertEquals("earn-v1:${r.id}:robinhood-usdg", first.getString("intentId"))
      val id = first.getString("journeyId")
      assertEquals(id, journal(f).loadOrCreate(r, 4663, id).getString("journeyId"))
      assertEquals(id, j.loadOrCreate(r, 4663, null).getString("journeyId"))
      val review =
        DepositFixtures.review(r).put("journeyId", id).put("privateProof", "secret-native-proof")
      j.saveReview(id, 1, review)
      val public = j.publicSnapshot(id)
      assertEquals("review", public["phase"])
      assertFalse(public.toString().contains("secret-native-proof"))
      assertFalse(public.toString().contains("fundingRows"))
      assertFalse(public.toString().contains("reservation"))
      assertFalse(String(f.bytes!!).contains("secret-native-proof"))
      assertEquals(
        "secret-native-proof",
        journal(f).get(id).getJSONObject("review").getString("privateProof"),
      )
    }
  }

  @Test
  fun childIdentitySurvivesRestartAndCannotBeReplacedOrHiddenByEditing() {
    val f = File()
    val j = journal(f)
    DepositFixtures.record().use { r ->
      val row = j.loadOrCreate(r, 4663, null)
      val id = row.getString("journeyId")
      j.saveReview(id, 1, DepositFixtures.review(r).put("journeyId", id))
      j.attachChild(id, 2, "funding", "source0")
      assertEquals(
        "source0",
        journal(f).get(id).getJSONObject("children").getJSONArray("funding").getString(0),
      )
      assertThrows(IllegalStateException::class.java) {
        j.saveReview(id, 3, DepositFixtures.review(r))
      }
      assertThrows(IllegalStateException::class.java) {
        j.attachChild(id, 2, "funding", "replacement")
      }
    }
  }

  @Test
  fun failedWritesCorruptionAndChangedGenerationFailClosed() {
    val f = File()
    val j = journal(f)
    DepositFixtures.record().use { r ->
      f.fail = true
      assertThrows(IllegalStateException::class.java) { j.loadOrCreate(r, 4663, null) }
      assertFalse(f.exists())
      f.fail = false
      val id = j.loadOrCreate(r, 4663, null).getString("journeyId")
      f.fail = true
      assertThrows(IllegalStateException::class.java) { j.attachChild(id, 1, "funding", "source0") }
      assertEquals(1, journal(f).get(id).getInt("revision"))
      f.fail = false
      assertThrows(Exception::class.java) { journal(f, "another-generation").get(id) }
      f.bytes!![f.bytes!!.lastIndex] = (f.bytes!!.last().toInt() xor 1).toByte()
      assertThrows(Exception::class.java) { journal(f).get(id) }
    }
  }

  @Test
  fun progressAuthorityIsNeverPersistedAndCancellationPreservesChildren() {
    val f = File()
    val j = journal(f)
    DepositFixtures.record().use { r ->
      val id = j.loadOrCreate(r, 4663, null).getString("journeyId")
      j.saveReview(id, 1, DepositFixtures.review(r).put("journeyId", id))
      j.attachChild(id, 2, "funding", "source0")
      j.pause(id, "submissionUnknown")
      assertEquals("paused", journal(f).publicSnapshot(id)["phase"])
      assertEquals("submissionUnknown", j.publicSnapshot(id)["pauseReason"])
      assertFalse(journal(f).get(id).has("approvedAt"))
      assertEquals(1, journal(f).get(id).getJSONObject("children").getJSONArray("funding").length())
    }
  }
}
