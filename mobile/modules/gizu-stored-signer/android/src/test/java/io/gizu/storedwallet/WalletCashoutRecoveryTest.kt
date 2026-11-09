package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import uniffi.gizu_stored_signer_core.confidentialWithdrawalPlan

class WalletCashoutRecoveryTest {
  private val wallet = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12"
  private val old = "d450c45a-7d4d-4ce9-bbbd-3437c6ba6cb8"
  private val current = "2793c0c2-62a5-4539-bc25-18893b8fc8c2"
  private val domain = "gizu-confidential-withdrawal"
  private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
  private val files = mutableMapOf<String, File>()

  private class File : WalletFile {
    var bytes: ByteArray? = null

    override fun exists() = bytes != null

    override fun read() = bytes!!.copyOf()

    override fun write(bytes: ByteArray) {
      this.bytes = bytes.copyOf()
    }
  }

  private fun source(index: Int, amount: String) =
    JSONObject()
      .put("kind", if (index == 0) "swap" else "earn")
      .put("profileChainId", if (index == 0) 0 else 4663)
      .put("cycleIndex", 0)
      .put("address", "0x" + (index + 1).toString().repeat(40))
      .put("amountAtoms", amount)

  private fun plan() =
    JSONObject(
      confidentialWithdrawalPlan(
        JSONObject()
          .put("operationId", "cashout1")
          .put("amountAtoms", "3000000")
          .put("sources", JSONArray().put(source(0, "1000000")).put(source(1, "2000000")))
          .put("recipientIndices", JSONArray(listOf(3, 4)))
          .put("weightsBps", JSONArray(listOf(5000, 5000)))
          .toString()
      )
    )

  private fun original(paid: Boolean = false): Pair<File, JSONObject> {
    val file = File()
    val journal = ConfidentialWithdrawalJournal(file, { key }, wallet, old)
    journal.create(plan())
    val row =
      journal.update("cashout1", 1) { r ->
        r.getJSONArray("children").objects().forEachIndexed { index, c ->
          val payload =
            JSONObject()
              .put("nonce", "nonce-$index")
              .put(
                "signer_id",
                r.getJSONObject("plan")
                  .getJSONObject("proposal")
                  .getJSONArray("sources")
                  .getJSONObject(c.getInt("source"))
                  .getString("address"),
              )
              .put("intent", "original transfer $index")
              .toString()
          val prepared =
            JSONObject()
              .put("operationId", "cashout1_$index")
              .put("confidentialAccount", JSONObject(payload).getString("signer_id"))
              .put("destinationRecipient", "0x" + (c.getInt("slot") + 6).toString().repeat(40))
              .put("amountAtoms", c.getString("amountAtoms"))
              .put("minimumDestinationAtoms", c.getString("amountAtoms"))
              .put("intent", JSONObject().put("payload", payload))
              .toString()
          c.put("status", if (paid) "paid" else "unknown")
            .put(
              "signedData",
              JSONObject()
                .put("standard", "erc191")
                .put("payload", payload)
                .put("signature", "signature-$index")
                .toString(),
            )
            .put("preparedText", prepared)
            .put("nonce", "nonce-$index")
            .put("payloadHash", utf8EarnHash(payload))
            .put("reservationId", "reservation-$index")
            .put("nonceHistory", JSONArray(listOf("nonce-$index")))
            .put("minimumDestinationAtoms", c.getString("amountAtoms"))
            .put("receivedAtoms", if (paid) c.getString("amountAtoms") else "0")
          if (paid)
            c.put(
              "receipt",
              JSONObject()
                .put("transactionHash", "0x" + (index + 10).toString(16).repeat(64))
                .put("logIndex", index)
                .put("receivedAtoms", c.getString("amountAtoms")),
            )
        }
      }
    return file to row
  }

  private fun envelope(file: File): JSONObject {
    val clear = CryptoEnvelope.decrypt(key, file.read(), "$domain:v1:$wallet:$old".toByteArray())
    return try {
      JSONObject()
        .put("domain", domain)
        .put("generation", old)
        .put("name", "$domain-$old.enc")
        .put("data", String(clear))
    } finally {
      clear.fill(0)
    }
  }

  private fun importer() =
    RecoveredHistoryImporter(wallet, current, key) { files.getOrPut(it) { File() } }

  private fun journal() =
    ConfidentialWithdrawalJournal(files.getValue("$domain-$current.enc"), { key }, wallet, current)

  private fun grouped(): Pair<File, JSONObject> {
    val (file, before) = original()
    val journal = ConfidentialWithdrawalJournal(file, { key }, wallet, old)
    val recipients = JSONArray(listOf("0x" + "6".repeat(40), "0x" + "7".repeat(40)))
    val groupId =
      cashoutGroupIdentity(
        JSONObject().put("plan", before.getJSONObject("plan")).put("recipients", recipients)
      )
    val row =
      journal.update("cashout1", 2) { r ->
        val children = r.getJSONArray("children").objects()
        for ((index, c) in children.withIndex()) {
          val amount =
            (c.getString("amountAtoms").toBigInteger() +
                if (index == 0) java.math.BigInteger.ZERO else 123.toBigInteger())
              .toString()
          c.put("status", "paid").put("receivedAtoms", amount)
          if (index == 0)
            c.put(
              "receipt",
              JSONObject()
                .put("transactionHash", "0x" + "a".repeat(64))
                .put("logIndex", 0)
                .put("receivedAtoms", amount),
            )
          else c.put("deliveryGroupId", groupId)
        }
        val scans =
          JSONArray(
            (0..1).map { slot ->
              JSONObject()
                .put("transactionHashes", JSONArray(listOf("0x" + "b".repeat(64))))
                .put("nextScanBlock", "12")
                .put("complete", true)
            }
          )
        val proof =
          JSONObject()
            .put("operationId", "cashout1")
            .put("groupId", groupId)
            .put("status", "paid")
            .put("verification", "destination-receipt-group-v1")
            .put("authenticated", true)
            .put("operationScoped", true)
            .put("observedAtMs", 1000)
            .put(
              "routes",
              JSONArray(
                children.indices.map { JSONObject().put("index", it).put("status", "SUCCESS") }
              ),
            )
            .put(
              "slots",
              JSONArray(
                (0..1).map { slot ->
                  val selected = children.filter { it.getInt("slot") == slot }
                  JSONObject()
                    .put("slot", slot)
                    .put("destinationRecipient", recipients.getString(slot))
                    .put("minimumDestinationAtoms", selected.sumAtoms("minimumDestinationAtoms"))
                    .put("receivedAtoms", selected.sumAtoms("receivedAtoms"))
                    .put(
                      "receipts",
                      JSONArray(
                        children.mapIndexedNotNull { index, c ->
                          if (c.getInt("slot") != slot) null
                          else
                            (c.optJSONObject("receipt")?.let { JSONObject(it.toString()) }
                                ?: JSONObject()
                                  .put("transactionHash", "0x" + "b".repeat(64))
                                  .put("logIndex", index)
                                  .put("receivedAtoms", c.getString("receivedAtoms")))
                              .put("blockNumber", "11")
                              .put("blockHash", "0x" + "c".repeat(64))
                        }
                      ),
                    )
                }
              ),
            )
            .put("groupScan", scans)
        r.put("groupScan", scans).put("groupReceipt", proof)
      }
    return file to row
  }

  @Test
  fun groupedPaidDeliverySurvivesExportAndRestoreWithoutReassigningLegacyPaidChildren() {
    val (file, original) = grouped()
    val history =
      exportWalletRecoveryHistory(wallet, old, key, listOf("$domain-$old.enc"), JSONArray()) {
        file.read()
      }
    importer().import(history)
    val restored = journal().get("cashout1")
    assertTrue(nativeJsonEqual(original, restored))
    assertTrue(
      nativeJsonEqual(
        original.getJSONObject("groupReceipt"),
        restored.getJSONObject("groupReceipt"),
      )
    )
    assertTrue(
      nativeJsonEqual(original.getJSONArray("groupScan"), restored.getJSONArray("groupScan"))
    )
    assertNull(journal().active())
    assertEquals("3000246", journal().public(restored)["receivedAtoms"])
    val third = "fa1a6a80-80f0-45b8-8ad2-a5a09f762f2a"
    val next =
      exportWalletRecoveryHistory(
        wallet,
        current,
        key,
        listOf("$domain-$current.enc"),
        JSONArray(),
      ) {
        files.getValue(it).read()
      }
    RecoveredHistoryImporter(wallet, third, key) { files.getOrPut(it) { File() } }.import(next)
    val second =
      ConfidentialWithdrawalJournal(files.getValue("$domain-$third.enc"), { key }, wallet, third)
    assertTrue(nativeJsonEqual(original, second.get("cashout1")))
    assertNull(second.active())
  }

  @Test
  fun newerGroupedSuccessPreservesPendingSignaturesAndOldSnapshotsCannotRegressPayment() {
    val (pendingFile, _) = original()
    val (paidFile, paid) = grouped()
    val pending = envelope(pendingFile)
    val complete = envelope(paidFile)
    importer().import(JSONArray().put(complete).put(pending))
    importer().import(JSONArray().put(pending))
    assertTrue(nativeJsonEqual(paid, journal().get("cashout1")))
    val bytes = files.getValue("$domain-$current.enc").read()
    val changed = JSONObject(complete.toString())
    val root = JSONObject(changed.getString("data"))
    root
      .getJSONArray("operations")
      .getJSONObject(0)
      .put("revision", 4)
      .getJSONObject("groupReceipt")
      .put("observedAtMs", 2000)
    changed.put("data", root.toString())
    assertThrows(Exception::class.java) { importer().import(JSONArray().put(changed)) }
    assertArrayEquals(bytes, files.getValue("$domain-$current.enc").read())
  }

  @Test
  fun malformedGroupedDeliveryAndSubstitutedSourceGenerationFailBeforeWriting() {
    val (file, _) = grouped()
    val saved = envelope(file)
    for (variant in 0..6) {
      files.clear()
      val candidate = JSONObject(saved.toString())
      val root = JSONObject(candidate.getString("data"))
      val row = root.getJSONArray("operations").getJSONObject(0)
      val proof = row.getJSONObject("groupReceipt")
      val slot = proof.getJSONArray("slots").getJSONObject(0)
      when (variant) {
        0 -> root.put("generation", current)
        1 -> proof.put("groupId", "f".repeat(64))
        2 -> slot.put("receivedAtoms", "9999999")
        3 -> slot.put("destinationRecipient", "0x" + "9".repeat(40))
        4 ->
          proof
            .getJSONArray("slots")
            .getJSONObject(1)
            .getJSONArray("receipts")
            .put(0, JSONObject(slot.getJSONArray("receipts").getJSONObject(0).toString()))
        5 -> row.put("cancelled", true)
        6 -> row.getJSONArray("children").getJSONObject(1).put("deliveryGroupId", "f".repeat(64))
      }
      candidate.put("data", root.toString())
      assertThrows("variant $variant", Exception::class.java) {
        importer().import(JSONArray().put(candidate))
      }
      assertTrue(files.values.none { it.exists() })
    }
  }

  @Test
  fun portableExportIncludesCashoutOnceAndIgnoresPagedAndUnrelatedFiles() {
    val (file, _) = original()
    val name = "$domain-$old.enc"
    val history =
      exportWalletRecoveryHistory(
        wallet,
        old,
        key,
        listOf(name, "$name.bak", "$domain-$old.page-1.enc", "$domain-$current.enc"),
        JSONArray(),
      ) { selected ->
        assertEquals(name, selected)
        file.read()
      }
    assertEquals(1, history.length())
    assertEquals(domain, history.getJSONObject(0).getString("domain"))
    importer().import(history)
    assertEquals("unknown", journal().public(journal().active()!!)["status"])
  }

  @Test
  fun cashoutPendingAndPaidHistoriesRoundtripWithOriginalSignaturesAndAllocations() {
    for (paid in listOf(false, true)) {
      files.clear()
      val (file, original) = original(paid)
      val history = JSONArray().put(envelope(file))
      importer().import(history)
      importer().import(history)
      val restored = journal().get("cashout1")
      assertTrue(nativeJsonEqual(original, restored))
      assertEquals(if (paid) "paid" else "unknown", journal().public(restored)["status"])
      assertEquals(paid, journal().active() == null)
      if (!paid) {
        assertThrows(Exception::class.java) {
          journal()
            .create(plan().also { it.getJSONObject("proposal").put("operationId", "second") })
        }
        assertThrows(Exception::class.java) { journal().cancel("cashout1") }
      }
    }
  }

  @Test
  fun conflictingPlanSignedTupleAndPaidAllocationsCannotReplaceRestoredEvidence() {
    val (file, _) = original(true)
    val saved = envelope(file)
    importer().import(JSONArray().put(saved))
    val bytes = files.getValue("$domain-$current.enc").read()
    for (variant in 0..7) {
      val candidate = JSONObject(saved.toString())
      val root = JSONObject(candidate.getString("data"))
      val row = root.getJSONArray("operations").getJSONObject(0)
      row.put("revision", 3)
      val child = row.getJSONArray("children").getJSONObject(0)
      when (variant) {
        0 ->
          row
            .getJSONObject("plan")
            .getJSONObject("proposal")
            .getJSONArray("recipientIndices")
            .put(0, 8)
        1 -> child.put("signedData", "substituted signature")
        2 -> child.put("preparedText", "substituted quote")
        3 -> child.put("reservationId", "another-reservation")
        4 -> child.put("receivedAtoms", "1000001")
        5 -> child.getJSONObject("receipt").put("transactionHash", "0x" + "f".repeat(64))
        6 -> child.put("status", "pending")
        7 -> child.put("nonceHistory", JSONArray())
      }
      candidate.put("data", root.toString())
      assertThrows("variant $variant", Exception::class.java) {
        importer().import(JSONArray().put(candidate))
      }
      assertArrayEquals(bytes, files.getValue("$domain-$current.enc").read())
    }
  }
}
