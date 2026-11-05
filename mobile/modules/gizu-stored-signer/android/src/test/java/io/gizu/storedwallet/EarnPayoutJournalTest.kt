package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnPayoutJournalTest {
  private val wallet = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12"
  private val hash = "0x" + "a".repeat(64)
  private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

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

  private fun proposal(id: String = "source-1", leg: String = "hold") =
    JSONObject()
      .put("operationId", id)
      .put("revision", 7)
      .put("profileChainId", 1)
      .put("leg", leg)
      .put("sourceTransactionHash", hash)
      .put("expectedSigner", "0x" + "1".repeat(40))
      .put("expectedRecipient", "0x" + "2".repeat(40))
      .put("creditedAtoms", "1000000")
      .put("amountAtoms", if (leg == "hold") "100000" else "900000")
      .put("minimumDestinationAtoms", "1")
      .put("deadlineMs", 2000000)

  private fun journal(file: File, generation: String = wallet) =
    EarnPayoutJournal(file, { key }, wallet, generation)

  @Test
  fun siblingInvestmentSlotsReserveIndependentlyAndCannotChangeSavedWeights() {
    val j = journal(File())
    val distribution =
      JSONObject().put("version", 1).put("weightsBps", org.json.JSONArray(listOf(4000, 6000)))
    val a =
      proposal(leg = "invest:0").put("distribution", distribution).put("amountAtoms", "400000")
    val b =
      proposal(leg = "invest:1").put("distribution", distribution).put("amountAtoms", "600000")
    val first = j.create(a, "body", "nonce0", hash, hash)
    j.create(b, "body", "nonce1", hash, hash)
    assertEquals(2, j.all().size)
    assertThrows(IllegalStateException::class.java) { j.create(a, "body", "nonce2", hash, hash) }
    val changed =
      JSONObject(a.toString())
        .put(
          "distribution",
          JSONObject().put("version", 1).put("weightsBps", org.json.JSONArray(listOf(3000, 7000))),
        )
    assertThrows(IllegalStateException::class.java) {
      j.refreshUnsigned(first.getString("operationId"), 1, changed, "body", "nonce0", hash)
    }
    assertEquals(
      listOf(4000, 6000),
      distributionWeights(
        j.get(first.getString("operationId"))
          .getJSONObject("proposal")
          .getJSONObject("distribution")
      ),
    )
  }

  @Test
  fun encryptedSignedBytesRemainPrivateAndImmutableAcrossRestart() {
    val file = File()
    val j = journal(file)
    j.create(proposal(), "private TLS body", "nonce1", hash, hash)
    j.saveSigned("source-1", "hold", 1, "private signed payout", "review", hash)
    assertFalse(String(file.bytes!!).contains("private signed payout"))
    val restarted = journal(file)
    val op = restarted.get("source-1", "hold")
    assertEquals("submissionUnknown", op.getString("status"))
    assertEquals("private signed payout", op.getString("signedData"))
    val public = restarted.public(op).toString()
    assertFalse(public.contains("private"))
    assertFalse(public.contains("nonce1"))
    assertFalse(public.contains(hash))
    assertEquals(true, restarted.public(op)["blocked"])
    assertEquals(true, restarted.public(op)["canResume"])
    assertThrows(Exception::class.java) { journal(file, "restored-generation").all() }
  }

  @Test
  fun immutableRoleAndNonceLocksSurviveRevisionChangesAndChangedFundingAlias() {
    val j = journal(File())
    j.create(proposal(), "body", "nonce1", hash, hash)
    j.update("source-1", "hold", 1) { it.put("status", "planned") }
    assertThrows(IllegalStateException::class.java) {
      j.create(proposal().put("revision", 9), "changed", "nonce2", hash, hash)
    }
    assertThrows(IllegalStateException::class.java) {
      j.create(proposal("source-alias"), "changed", "nonce3", hash, hash)
    }
    assertThrows(IllegalStateException::class.java) {
      j.create(proposal("source-2", "invest"), "body", "nonce1", hash, hash)
    }
    j.create(proposal("source-1", "invest"), "body", "nonce2", hash, hash)
    assertEquals(2, j.all().size)
  }

  @Test
  fun staleReservationsAndFailedPersistenceNeverInventSavedSignatures() {
    val file = File()
    val j = journal(file)
    j.create(proposal(), "body", "nonce1", hash, hash)
    assertTrue(j.evidence("source-1", "hold", 1, 1000000).nonceFirstSeen)
    assertThrows(IllegalStateException::class.java) { j.evidence("source-1", "hold", 2, 1000000) }
    file.fail = true
    assertThrows(IllegalStateException::class.java) {
      j.saveSigned("source-1", "hold", 1, "signed", "review", hash)
    }
    assertFalse(j.get("source-1", "hold").has("signedData"))
    file.fail = false
    j.saveSigned("source-1", "hold", 1, "signed", "review", hash)
    assertThrows(IllegalStateException::class.java) { j.evidence("source-1", "hold", 2, 1000000) }
    assertThrows(IllegalStateException::class.java) {
      j.saveSigned("source-1", "hold", 2, "other", "review", hash)
    }
  }

  @Test
  fun competingNativeJournalInstancesCanReserveOnlyOneChildForOneFundingRole() {
    val file = File()
    val a = journal(file)
    val b = journal(file)
    val start = java.util.concurrent.CountDownLatch(1)
    val accepted = java.util.concurrent.atomic.AtomicInteger()
    val threads =
      listOf(a, b).map { j ->
        Thread {
          start.await()
          try {
            j.create(proposal(), "body", "nonce1", hash, hash)
            accepted.incrementAndGet()
          } catch (_: IllegalStateException) {}
        }
      }
    threads.forEach(Thread::start)
    start.countDown()
    threads.forEach(Thread::join)
    assertEquals(1, accepted.get())
    assertEquals(1, journal(file).all().size)
  }

  @Test
  fun unsignedRefreshPreservesChildRoleAndAllPreviouslySeenNoncesButSignedRefreshAlwaysFails() {
    val j = journal(File())
    val op = j.create(proposal(), "body", "nonce1", hash, hash)
    val id = op.getString("operationId")
    val updated =
      j.refreshUnsigned(
        id,
        1,
        proposal().put("quoteId", hash).put("deadlineMs", 3000000),
        "fresh body",
        "nonce2",
        hash,
      )
    assertEquals(id, updated.getString("operationId"))
    assertEquals(2, updated.getInt("revision"))
    assertEquals(2, updated.getJSONArray("nonceHistory").length())
    assertThrows(IllegalStateException::class.java) {
      j.create(proposal("source-1", "invest"), "body", "nonce1", hash, hash)
    }
    assertThrows(IllegalStateException::class.java) {
      j.refreshUnsigned(id, 1, proposal(), "stale", "nonce3", hash)
    }
    assertThrows(IllegalStateException::class.java) {
      j.refreshUnsigned(id, 2, proposal().put("amountAtoms", "1"), "altered", "nonce3", hash)
    }
    j.saveSigned(id, "hold", 2, "signed", "review", hash)
    assertThrows(IllegalStateException::class.java) {
      j.refreshUnsigned(id, 3, proposal(), "unsigned lie", "nonce3", hash)
    }
    assertEquals("signed", j.get(id).getString("signedData"))
  }

  @Test
  fun cancelledUnsignedChildRecoversWithoutReleasingRoleOrNonceHistory() {
    val file = File()
    val j = journal(file)
    val created =
      j.create(proposal(), "private body", "nonce1", hash, hash, "private exact source tuple")
    val id = created.getString("operationId")
    j.cancelUnsigned(id, 1)
    assertEquals(true, j.public(j.get(id))["canRefreshUnsigned"])
    assertThrows(IllegalStateException::class.java) {
      j.create(proposal(), "duplicate", "nonce2", hash, hash)
    }
    val recovered =
      journal(file).refreshUnsigned(id, 2, proposal(), "fresh authenticated body", "nonce1", hash)
    assertEquals(id, recovered.getString("operationId"))
    assertEquals("planned", recovered.getString("status"))
    assertEquals(hash, recovered.getString("reservationId"))
    assertEquals(1, recovered.getJSONArray("nonceHistory").length())
    assertEquals("private exact source tuple", recovered.getString("sourceRequest"))
    assertEquals(3, recovered.getInt("revision"))
    j.saveSigned(id, "hold", 3, "signed", "review", hash)
    assertThrows(IllegalStateException::class.java) { j.cancelUnsigned(id, 4) }
    assertThrows(IllegalStateException::class.java) {
      j.refreshUnsigned(id, 4, proposal(), "new nonce", "nonce2", hash)
    }
  }

  @Test
  fun pendingNativeAuthorizationCannotBeCancelledOrRefreshed() {
    val j = journal(File())
    val id = j.create(proposal(), "body", "nonce1", hash, hash, "source").getString("operationId")
    j.update(id, "hold", 1) { it.put("signingAuthorizationPending", true) }
    assertEquals(false, j.public(j.get(id))["canRefreshUnsigned"])
    assertThrows(IllegalStateException::class.java) { j.cancelUnsigned(id, 2) }
    assertThrows(IllegalStateException::class.java) {
      j.refreshUnsigned(id, 2, proposal(), "body", "nonce2", hash)
    }
  }

  @Test
  fun distinctNativeSourceDepositsInSameBundlerTransactionRetainSeparatePayoutRoles() {
    val j = journal(File())
    j.create(proposal().put("sourceAccountIndex", 1), "body", "nonce1", hash, hash)
    val second =
      j.create(proposal("source-2").put("sourceAccountIndex", 3), "body", "nonce2", hash, hash)
    assertEquals(2, j.all().size)
    j.refreshUnsigned(
      second.getString("operationId"),
      1,
      second.getJSONObject("proposal"),
      "fresh",
      "nonce2",
      hash,
    )
    assertThrows(IllegalStateException::class.java) {
      j.create(proposal("alias").put("sourceAccountIndex", 3), "body", "nonce3", hash, hash)
    }
  }

  @Test
  fun publicChildIdentifiesSourceAndCycleWhileUnsignedRefreshCannotChangeAllocation() {
    val j = journal(File())
    val p =
      proposal()
        .put("cycleIndex", 2)
        .put("sourceAccountIndex", 4)
        .put("splitOffsetAtoms", "1000009")
        .put("sourceOwner", "0x" + "3".repeat(40))
        .put("fundingBatchId", "batch1")
        .put("fundingBatchSize", 2)
    val op = j.create(p, "private", "nonce1", hash, hash)
    assertEquals("source-1", j.public(op)["sourceOperationId"])
    assertEquals(2, j.public(op)["cycleIndex"])
    for ((field, value) in
      listOf(
        "cycleIndex" to 3,
        "sourceAccountIndex" to 5,
        "splitOffsetAtoms" to "0",
        "sourceOwner" to "changed",
        "fundingBatchId" to "batch2",
        "fundingBatchSize" to 3,
      )) {
      assertThrows(IllegalStateException::class.java) {
        j.refreshUnsigned(
          op.getString("operationId"),
          1,
          JSONObject(p.toString()).put(field, value),
          "changed",
          "nonce1",
          hash,
        )
      }
    }
  }
}
