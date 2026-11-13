package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ConfidentialWithdrawalJournalTest {
  private class File : WalletFile {
    var bytes: ByteArray? = null

    override fun exists() = bytes != null

    override fun read() = bytes!!.copyOf()

    override fun write(bytes: ByteArray) {
      this.bytes = bytes.copyOf()
    }
  }

  private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

  private fun plan() =
    JSONObject()
      .put(
        "proposal",
        JSONObject()
          .put("operationId", "cash1")
          .put("amountAtoms", "1000001")
          .put("recipientIndices", JSONArray(listOf(3, 4)))
          .put("weightsBps", JSONArray(listOf(5000, 5000)))
          .put("sources", JSONArray().put(JSONObject().put("address", "private source"))),
      )
      .put(
        "children",
        JSONArray()
          .put(JSONObject().put("source", 0).put("slot", 0).put("amountAtoms", "500000"))
          .put(JSONObject().put("source", 0).put("slot", 1).put("amountAtoms", "500001")),
      )

  @Test
  fun cancelledSerializedLegacySwapCannotReleaseSignedOrSubmittedPrivatePayout() {
    // Actual camelCase Machine/Data/Payout serialization, including nullable signature fields.
    val state =
      JSONObject(
        """{"cancelled":true,"step":{"step":"payoutSubmit","index":0},"data":{"payouts":[{"portion":"0xf4240","request":null,"quote":null,"signed":{"standard":"erc191","payload":"saved transfer","signature":"saved signature"},"intentHash":null,"delivered":"0x0"}]}}"""
      )
    assertThrows(Exception::class.java) { assertSavedSwapPrivateWorkFinished(state) }
    val payout = state.getJSONObject("data").getJSONArray("payouts").getJSONObject(0)
    payout.put("signed", JSONObject.NULL).put("intentHash", "known-or-unknown-submission")
    assertThrows(Exception::class.java) { assertSavedSwapPrivateWorkFinished(state) }
    payout.put("intentHash", JSONObject.NULL)
    assertSavedSwapPrivateWorkFinished(state)
    state.getJSONObject("step").put("step", "done")
    payout.put("signed", JSONObject())
    assertSavedSwapPrivateWorkFinished(state)
  }

  @Test
  fun restartPreservesDistributionAndUnknownSignedBytesCannotBeCancelledOrOverwritten() {
    val file = File()
    val journal = ConfidentialWithdrawalJournal(file, { key }, "wallet", "generation")
    val row = journal.create(plan())
    val id = row.getString("operationId")
    journal.update(id, row.getInt("revision")) {
      it
        .getJSONArray("children")
        .getJSONObject(0)
        .put("signedData", "same signed bytes")
        .put("status", "unknown")
    }
    val restored = ConfidentialWithdrawalJournal(file, { key }, "wallet", "generation")
    assertEquals(
      "same signed bytes",
      restored.active()!!.getJSONArray("children").getJSONObject(0).getString("signedData"),
    )
    assertEquals(plan().toString(), restored.active()!!.getJSONObject("plan").toString())
    assertThrows(Exception::class.java) { restored.cancel(id) }
    assertThrows(Exception::class.java) { restored.create(plan()) }
    assertFalse(String(file.bytes!!).contains("signed bytes"))
  }

  @Test
  fun perReceiverViewConservesExactTotalsAndOnlyAllPaidIsComplete() {
    val journal = ConfidentialWithdrawalJournal(File(), { key }, "wallet", "generation")
    var row = journal.create(plan())
    row =
      journal.update("cash1", row.getInt("revision")) {
        it.getJSONArray("children").objects().forEachIndexed { index, c ->
          c.put("minimumDestinationAtoms", if (index == 0) "490000" else "490001")
            .put("status", if (index == 0) "paid" else "unknown")
            .put("receivedAtoms", if (index == 0) "495000" else "0")
        }
      }
    val view = journal.public(row)
    assertEquals("980001", view["minimumDestinationAtoms"])
    assertEquals("495000", view["receivedAtoms"])
    assertEquals("unknown", view["status"])
    assertEquals(false, view["canCancel"])
    row =
      journal.update("cash1", row.getInt("revision")) {
        it
          .getJSONArray("children")
          .getJSONObject(1)
          .put("status", "paid")
          .put("receivedAtoms", "495001")
      }
    assertEquals("paid", journal.public(row)["status"])
    assertNull(journal.active())
  }

  @Test
  fun realCancelledUnsignedLegacyRowsReleaseExclusionButSignedCancelledRowsDoNot() {
    assertNoPendingPrivateWork(listOf(JSONObject().put("status", "cancelled")), emptyList())
    assertThrows(Exception::class.java) {
      assertNoPendingPrivateWork(
        listOf(JSONObject().put("status", "cancelled").put("signedData", "signed")),
        emptyList(),
      )
    }
    // Native sponsored return journals retain finalized, while their public projections say
    // credited.
    assertNoPendingPrivateWork(
      listOf(
        JSONObject()
          .put("status", "finalized")
          .put("proposal", JSONObject().put("kind", "hoodTokenReturn"))
          .put(
            "settlement",
            JSONObject()
              .put("authenticated", true)
              .put("operationScoped", true)
              .put("status", "credited"),
          )
      ),
      listOf(JSONObject().put("phase", "invested")),
    )
  }

  @Test
  fun storageCapacityFailureRetainsSavedUnknownSignedWork() {
    val file = File()
    val journal = ConfidentialWithdrawalJournal(file, { key }, "wallet", "generation")
    val row = journal.create(plan())
    val updated =
      journal.update("cash1", row.getInt("revision")) {
        it
          .getJSONArray("children")
          .getJSONObject(0)
          .put("status", "unknown")
          .put("signedData", "immutable signature")
      }
    val saved = file.bytes!!.copyOf()
    assertThrows(Exception::class.java) {
      journal.update("cash1", updated.getInt("revision")) {
        it.put("oversized", "x".repeat(8 * 1024 * 1024))
      }
    }
    assertArrayEquals(saved, file.bytes)
    assertEquals(
      "immutable signature",
      journal.active()!!.getJSONArray("children").getJSONObject(0).getString("signedData"),
    )
    assertEquals("unknown", journal.public(journal.active()!!)["status"])
  }

  @Test
  fun unsignedCancellationRetainsRegistryAndPlanButReleasesActiveExclusion() {
    val j = ConfidentialWithdrawalJournal(File(), { key }, "wallet", "generation")
    val row = j.create(plan())
    j.cancel(row.getString("operationId"))
    assertNull(j.active())
  }

  @Test
  fun privateExclusionRejectsUnfinishedAndUnknownWorkButAllowsCompletedAndUnsignedCancelled() {
    assertThrows(Exception::class.java) {
      assertNoPendingPrivateWork(
        listOf(JSONObject().put("status", "unknown").put("signedData", "signed")),
        emptyList(),
      )
    }
    assertNoPendingPrivateWork(emptyList(), listOf(JSONObject().put("phase", "paused")))
    assertNoPendingPrivateWork(emptyList(), listOf(JSONObject().put("phase", "preparing")))
    val open =
      assertThrows(DepositPhaseBlocked::class.java) {
        assertNoPendingPrivateWork(
          emptyList(),
          listOf(
            JSONObject()
              .put("phase", "paused")
              .put("children", JSONObject().put("funding", JSONArray().put("source-1")))
          ),
        )
      }
    assertEquals("paused", open.phase)
    assertThrows(DepositPhaseBlocked::class.java) {
      assertNoPendingPrivateWork(emptyList(), listOf(JSONObject().put("phase", "funding")))
    }
    assertNoPendingPrivateWork(
      listOf(
        JSONObject().put("status", "paid"),
        JSONObject().put("status", "planned").put("cancelled", true),
      ),
      listOf(JSONObject().put("phase", "invested")),
    )
  }

  @Test
  fun expiredExitAndNonceConsumedRedeemDoNotBlockTheNextDeposit() {
    val owner = "0x1111111111111111111111111111111111111111"
    val other = "0x2222222222222222222222222222222222222222"
    assertNoPendingPrivateWork(
      listOf(sponsored("hoodRedeemAll", "expired", owner, "0x1", "redeem-old")),
      emptyList(),
    )
    assertNoPendingPrivateWork(
      listOf(
        sponsored("hoodRedeemAll", "unknown", owner, "0x4", "redeem"),
        sponsored("hoodTokenReturn", "finalized", owner, "0x5", "return"),
      ),
      emptyList(),
    )
    assertThrows(UnfinishedPrivateWork::class.java) {
      assertNoPendingPrivateWork(
        listOf(sponsored("hoodRedeemAll", "unknown", owner, "0x4", "redeem")),
        emptyList(),
      )
    }
    assertThrows(UnfinishedPrivateWork::class.java) {
      assertNoPendingPrivateWork(
        listOf(
          sponsored("hoodRedeemAll", "signed", owner, "0x4", "redeem"),
          sponsored("hoodTokenReturn", "finalized", other, "0x5", "return"),
        ),
        emptyList(),
      )
    }
    val failure =
      assertThrows(UnfinishedPrivateWork::class.java) {
        assertNoPendingPrivateWork(
          listOf(
            sponsored("hoodRedeemAll", "unknown", owner, "0x6", "redeem"),
            sponsored("hoodTokenReturn", "finalized", owner, "0x5", "return"),
          ),
          emptyList(),
        )
      }
    assertEquals("hoodRedeemAll", failure.kind)
    assertEquals("unknown", failure.status)
  }

  private fun sponsored(kind: String, status: String, owner: String, nonce: String, id: String) =
    JSONObject()
      .put("operationId", id)
      .put("status", status)
      .put("signedUserOperation", "signed")
      .put(
        "proposal",
        JSONObject()
          .put("kind", kind)
          .put("expectedFrom", owner)
          .put("chainId", 4663)
          .put("nonce", nonce),
      )
}
