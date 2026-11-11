package io.gizu.storedwallet

import io.gizu.storedwallet.portfolio.NativeConfidentialTarget
import java.time.Instant
import java.util.Base64
import javax.crypto.KeyGenerator
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import uniffi.gizu_stored_signer_core.deriveAccountAddresses
import uniffi.gizu_stored_signer_core.deriveEarnCycleConfidentialAddress

class ConfidentialWithdrawalEngineTest {
  private class File : WalletFile {
    var bytes: ByteArray? = null

    override fun exists() = bytes != null

    override fun read() = bytes!!.copyOf()

    override fun write(bytes: ByteArray) {
      this.bytes = bytes.copyOf()
    }
  }

  private class Fixture {
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val wallet = "00000000-0000-4000-8000-000000000001"
    val file = File()
    var approvals = 0
    var invalidations = 0
    var rejectCompeting = false
    var loseFirstResponse = false
    var malformedQuote = false
    var grouped = false
    var groupReady = true
    val store =
      WalletStore(
          File(),
          object : WalletKeys {
            override fun existing() = key

            override fun create() = key

            override fun reset() = key
          },
        )
        .also { s ->
          WalletRecord(
              wallet,
              StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
              ByteArray(32),
              true,
              wallet,
              INITIAL_ROLE_REGISTRY,
              4663,
              false,
              0,
              "[{\"cycleIndex\":0,\"chainId\":4663}]",
            )
            .use(s::create)
        }
    val journal = ConfidentialWithdrawalJournal(file, { key }, wallet, wallet)
    val addresses =
      listOf(
        deriveAccountAddresses(ByteArray(32))[2].lowercase(),
        deriveEarnCycleConfidentialAddress(ByteArray(32), 4663u, 0u).lowercase(),
      )
    val balances = addresses.associateWith { "1500000" }.toMutableMap()
    val submitted = mutableListOf<String>()
    var nonce = 0
    val prepared = mutableMapOf<String, JSONObject>()
    val paid = mutableMapOf<String, JSONObject>()
    val gateway =
      object : CashoutGateway {
        override val groupedReceipts
          get() = grouped

        override suspend fun groupStatus(row: JSONObject, group: JSONObject): JSONObject {
          val children = row.getJSONArray("children").objects()
          val routes =
            JSONArray(
              children.mapIndexedNotNull { index, child ->
                if (!child.has("signedData")) null
                else JSONObject().put("index", index).put("status", "SUCCESS")
              }
            )
          val result =
            JSONObject()
              .put("operationId", row.getString("operationId"))
              .put("authenticated", true)
              .put("operationScoped", true)
              .put("observedAtMs", System.currentTimeMillis())
              .put("verification", "destination-receipt-group-v1")
              .put("groupId", cashoutGroupIdentity(group))
              .put("nativeReceivedAtMs", System.currentTimeMillis())
              .put("routes", routes)
          if (children.any { !it.has("signedData") } || !groupReady)
            return result.put("status", "pending")
          val slots =
            JSONArray(
              (0 until group.getJSONArray("recipients").length()).map { slot ->
                val selected = children.filter { it.getInt("slot") == slot }
                val fullyPaid = selected.all { it.getString("status") == "paid" }
                val total =
                  if (fullyPaid) selected.sumAtoms("receivedAtoms").toBigInteger()
                  else
                    selected.sumAtoms("minimumDestinationAtoms").toBigInteger() + 123.toBigInteger()
                JSONObject()
                  .put("slot", slot)
                  .put("destinationRecipient", group.getJSONArray("recipients").getString(slot))
                  .put("minimumDestinationAtoms", selected.sumAtoms("minimumDestinationAtoms"))
                  .put("receivedAtoms", total.toString())
                  .put(
                    "receipts",
                    JSONArray().also { events ->
                      val alreadyPaid = selected.filter { it.getString("status") == "paid" }
                      alreadyPaid.forEach { c ->
                        events.put(
                          JSONObject(c.getJSONObject("receipt").toString())
                            .put("receivedAtoms", c.getString("receivedAtoms"))
                        )
                      }
                      if (!fullyPaid)
                        events.put(
                          JSONObject()
                            .put("transactionHash", "0x" + "b".repeat(64))
                            .put("logIndex", slot)
                            .put(
                              "receivedAtoms",
                              (selected.sumAtoms("minimumDestinationAtoms").toBigInteger() +
                                  123.toBigInteger() -
                                  alreadyPaid.sumAtoms("receivedAtoms").toBigInteger())
                                .toString(),
                            )
                        )
                    },
                  )
              }
            )
          return result.put("status", "paid").put("slots", slots)
        }

        override suspend fun prepare(
          operationId: String,
          source: JSONObject,
          recipient: String,
          amount: String,
        ): JSONObject {
          val now = System.currentTimeMillis()
          val expiry = now + 45000
          val minimum = (amount.toBigInteger() - 1000.toBigInteger()).toString()
          val C = source.getString("address")
          val token = "imt:" + "a".repeat(64) + ":" + ASSET
          val payload =
            JSONObject()
              .put("signer_id", C)
              .put("verifying_contract", "intents.far")
              .put(
                "nonce",
                Base64.getEncoder().encodeToString(ByteArray(32) { (++nonce).toByte() }),
              )
              .put("deadline", Instant.ofEpochMilli(expiry).toString())
              .put(
                "intents",
                JSONArray()
                  .put(
                    JSONObject()
                      .put("intent", "transfer")
                      .put("receiver_id", "deposit-$operationId")
                      .put("tokens", JSONObject().put(token, amount))
                  ),
              )
              .toString()
          val request =
            JSONObject()
              .put("dry", false)
              .put("swapType", "EXACT_INPUT")
              .put("depositType", "CONFIDENTIAL_INTENTS")
              .put("recipientType", "DESTINATION_CHAIN")
              .put("recipient", recipient)
              .put("refundType", "CONFIDENTIAL_INTENTS")
              .put("refundTo", C)
              .put("originAsset", ASSET)
              .put("destinationAsset", ASSET)
              .put("amount", amount)
              .put("slippageTolerance", 100)
              .put("confidentiality", "advanced")
          return JSONObject()
            .put("operationId", operationId)
            .put("recoveryEnvelope", "sealed-$operationId")
            .put("confidentialAccount", C)
            .put("destinationRecipient", recipient)
            .put("destinationToken", MONAD_EARN_USDC)
            .put("destinationChainId", 143)
            .put("assetId", ASSET)
            .put("amountAtoms", amount)
            .put("minimumDestinationAtoms", minimum)
            .put("observedAtMs", now)
            .put("expiresAtMs", expiry)
            .put("quoteRequest", request)
            .put(
              "quoteResponse",
              JSONObject()
                .put("quoteRequest", request)
                .put("signature", "provider")
                .put(
                  "quote",
                  JSONObject()
                    .put("depositAddress", "deposit-$operationId")
                    .put("amountIn", if (malformedQuote) "1" else amount)
                    .put("amountOut", minimum)
                    .put("minAmountOut", minimum)
                    .put("deadline", Instant.ofEpochMilli(expiry).toString()),
                ),
            )
            .put("intent", JSONObject().put("standard", "erc191").put("payload", payload))
            .also { prepared[payload] = it }
        }

        override suspend fun submit(rawSigned: String): JSONObject {
          val signed = JSONObject(rawSigned)
          assertTrue(approvals > 0)
          val payload = signed.getString("payload")
          val row = journal.active()!!
          assertTrue(
            row.getJSONArray("children").objects().any { it.optString("signedData") == rawSigned }
          )
          submitted.add(rawSigned)
          val q = prepared.getValue(payload)
          val c = q.getString("confidentialAccount")
          balances[c] =
            (balances.getValue(c).toBigInteger() - q.getString("amountAtoms").toBigInteger())
              .toString()
          paid[payload] =
            JSONObject()
              .put("operationId", q.getString("operationId"))
              .put("confidentialAccount", c)
              .put("destinationRecipient", q.getString("destinationRecipient"))
              .put("amountAtoms", q.getString("amountAtoms"))
              .put("minimumDestinationAtoms", q.getString("minimumDestinationAtoms"))
              .put("authenticated", true)
              .put("operationScoped", true)
              .put("observedAtMs", System.currentTimeMillis())
              .put("status", "paid")
              .put("receivedAtoms", q.getString("minimumDestinationAtoms"))
              .put(
                "receipt",
                JSONObject()
                  .put("transactionHash", "0x" + submitted.size.toString(16).padStart(64, '0'))
                  .put("logIndex", 0),
              )
          if (loseFirstResponse) {
            loseFirstResponse = false
            throw IllegalStateException("Network lost after acceptance")
          }
          return JSONObject().put("intentHash", "intent-${submitted.size}")
        }

        override suspend fun status(
          child: JSONObject,
          source: JSONObject,
          usedReceipts: Set<String>,
        ) =
          JSONObject(
              paid
                .getValue(JSONObject(child.getString("signedData")).getString("payload"))
                .toString()
            )
            .put("observedAtMs", System.currentTimeMillis())
      }

    fun engine() =
      ConfidentialWithdrawalEngine(
        store,
        journal,
        gateway,
        { s ->
          mapOf(
            "confidentialAddress" to s.getString("address"),
            "assetId" to ASSET,
            "available" to balances.getValue(s.getString("address")),
            "timestampMs" to System.currentTimeMillis(),
            "authenticated" to true,
            "operationScoped" to false,
          )
        },
        {},
        { r ->
          addresses.mapIndexed { i, a ->
            NativeConfidentialTarget(
              r.id,
              r.journalId,
              a,
              if (i == 0) "swap" else "earn",
              if (i == 0) 0 else 4663,
              0,
            )
          }
        },
        { check(!rejectCompeting) { "Other private execution" } },
        { _, _ -> invalidations++ },
      )
  }

  @Test
  fun twoSlotLegacyRestoreKeepsCompletedSlotFixedThroughLateGroupCompletionAndBackup() =
    runBlocking {
      val f = Fixture()
      val indices =
        f.store.load().use { record ->
          val allocation =
            uniffi.gizu_stored_signer_core.allocateSwapRecipientsN(record.roleRegistry, 2u)
          f.store.persistRegistry(record.id, allocation.registry)
          allocation.indices.map { it.toInt() }
        }
      val sources =
        JSONArray(
          f.addresses.mapIndexed { index, address ->
            JSONObject()
              .put("kind", if (index == 0) "swap" else "earn")
              .put("profileChainId", if (index == 0) 0 else 4663)
              .put("cycleIndex", 0)
              .put("address", address)
              .put("amountAtoms", if (index == 0) "1500000" else "500000")
          }
        )
      val plan =
        JSONObject(
          uniffi.gizu_stored_signer_core.confidentialWithdrawalPlan(
            JSONObject()
              .put("operationId", "cashout_two_slots")
              .put("amountAtoms", "2000000")
              .put("sources", sources)
              .put("recipientIndices", JSONArray(indices))
              .put("weightsBps", JSONArray(listOf(5000, 5000)))
              .toString()
          )
        )
      f.journal.create(plan)
      val prepared = f.engine().prepare("2000000")
      f.loseFirstResponse = true
      val unknown =
        f.engine().execute(prepared["operationId"] as String, prepared["revision"] as Int) { _, _ ->
          f.approvals++
        }
      val legacy =
        f.journal.update(unknown["operationId"] as String, unknown["revision"] as Int) { row ->
          val c = row.getJSONArray("children").getJSONObject(0)
          val proof = f.paid.getValue(JSONObject(c.getString("signedData")).getString("payload"))
          c.put("status", "paid")
            .put("receivedAtoms", proof.getString("receivedAtoms"))
            .put("receipt", proof.getJSONObject("receipt"))
        }
      val fixed = legacy.getJSONArray("children").getJSONObject(0).toString()
      f.grouped = true
      f.groupReady = false
      val waiting =
        f.engine().execute(legacy.getString("operationId"), legacy.getInt("revision")) { _, _ ->
          f.approvals++
        }
      assertEquals("pending", waiting["status"])
      assertEquals("999000", waiting["receivedAtoms"])
      assertEquals(3, f.submitted.size)
      f.groupReady = true
      val complete =
        f.engine().execute(waiting["operationId"] as String, waiting["revision"] as Int) { _, _ ->
          fail("Only read-only completion remains")
        }
      assertEquals("paid", complete["status"])
      assertEquals("1997123", complete["receivedAtoms"])
      val saved = f.journal.get(complete["operationId"] as String)
      assertEquals(fixed, saved.getJSONArray("children").getJSONObject(0).toString())
      assertEquals(
        "999000",
        saved
          .getJSONObject("groupReceipt")
          .getJSONArray("slots")
          .getJSONObject(0)
          .getString("receivedAtoms"),
      )
      val domain = "gizu-confidential-withdrawal"
      val history =
        exportWalletRecoveryHistory(
          f.wallet,
          f.wallet,
          f.key,
          listOf("$domain-${f.wallet}.enc"),
          JSONArray(),
        ) {
          f.file.read()
        }
      val restoredFile = File()
      val generation = "00000000-0000-4000-8000-000000000002"
      RecoveredHistoryImporter(f.wallet, generation, f.key) { restoredFile }.import(history)
      val restored = ConfidentialWithdrawalJournal(restoredFile, { f.key }, f.wallet, generation)
      assertEquals(
        "1997123",
        restored.public(restored.get(complete["operationId"] as String))["receivedAtoms"],
      )
      assertEquals(
        fixed,
        restored
          .get(complete["operationId"] as String)
          .getJSONArray("children")
          .getJSONObject(0)
          .toString(),
      )
      assertTrue(
        nativeJsonEqual(
          saved.getJSONObject("groupReceipt"),
          restored.get(complete["operationId"] as String).getJSONObject("groupReceipt"),
        )
      )
    }

  @Test
  fun groupUpgradePreservesPreviouslyPaidChildAllocationAndCanonicalReceipt() = runBlocking {
    val f = Fixture()
    f.loseFirstResponse = true
    val p = f.engine().prepare("2000000")
    val partial =
      f.engine().execute(p["operationId"] as String, p["revision"] as Int) { _, _ -> f.approvals++ }
    val updated =
      f.journal.update(partial["operationId"] as String, partial["revision"] as Int) { row ->
        val c = row.getJSONArray("children").getJSONObject(0)
        val proof = f.paid.getValue(JSONObject(c.getString("signedData")).getString("payload"))
        c.put("status", "paid")
          .put("receivedAtoms", proof.getString("receivedAtoms"))
          .put("receipt", proof.getJSONObject("receipt"))
      }
    val paidChild = updated.getJSONArray("children").getJSONObject(0).toString()
    f.grouped = true
    val result =
      f.engine().execute(updated.getString("operationId"), updated.getInt("revision")) { _, _ ->
        f.approvals++
      }
    assertEquals("paid", result["status"])
    assertEquals("1998123", result["receivedAtoms"])
    assertEquals(2, f.submitted.size)
    assertEquals(
      paidChild,
      f.journal
        .get(result["operationId"] as String)
        .getJSONArray("children")
        .getJSONObject(0)
        .toString(),
    )
  }

  @Test
  fun groupSubmitsBothUnequalSourcesBeforeWaitingForSharedReceivingSlot() = runBlocking {
    val f = Fixture()
    f.grouped = true
    f.groupReady = false
    val p = f.engine().prepare("2000000")
    val original = f.journal.active()!!.getJSONObject("plan").toString()
    val pending =
      f.engine().execute(p["operationId"] as String, p["revision"] as Int) { _, _ -> f.approvals++ }
    assertEquals(1, pending["walletCount"])
    assertEquals(2, f.submitted.size)
    assertEquals("pending", pending["status"])
    val signatures = f.submitted.toList()
    f.groupReady = true
    val paid =
      f.engine().execute(pending["operationId"] as String, pending["revision"] as Int) { _, _ ->
        fail("Completion must not sign again")
      }
    assertEquals("paid", paid["status"])
    assertEquals("1998123", paid["receivedAtoms"])
    assertEquals(signatures, f.submitted)
    val saved = f.journal.get(paid["operationId"] as String)
    assertEquals(original, saved.getJSONObject("plan").toString())
    assertEquals(
      "1499000",
      saved.getJSONArray("children").getJSONObject(0).getString("receivedAtoms"),
    )
    assertEquals(
      "499123",
      saved.getJSONArray("children").getJSONObject(1).getString("receivedAtoms"),
    )
    assertTrue(saved.has("groupReceipt"))
  }

  @Test
  fun groupRestartsAfterFirstFundedSourceWithoutResigningOrRebroadcastingIt() = runBlocking {
    val f = Fixture()
    f.grouped = true
    f.loseFirstResponse = true
    val p = f.engine().prepare("2000000")
    val unknown =
      f.engine().execute(p["operationId"] as String, p["revision"] as Int) { _, _ -> f.approvals++ }
    assertEquals(1, f.submitted.size)
    val signed =
      f.journal.active()!!.getJSONArray("children").getJSONObject(0).getString("signedData")
    val paid =
      f.engine().execute(unknown["operationId"] as String, unknown["revision"] as Int) { _, _ ->
        f.approvals++
      }
    assertEquals("paid", paid["status"])
    assertEquals(2, f.submitted.size)
    assertEquals(
      signed,
      f.journal
        .get(paid["operationId"] as String)
        .getJSONArray("children")
        .getJSONObject(0)
        .getString("signedData"),
    )
  }

  @Test
  fun unknownSubmissionRestartReconcilesPaidChildWithoutRerollOrDuplicate() = runBlocking {
    val f = Fixture()
    val prepared = f.engine().prepare("2000000")
    assertEquals(1, prepared["walletCount"])
    val before = f.journal.active()!!.getJSONObject("plan").toString()
    f.loseFirstResponse = true
    val unknown =
      f.engine().execute(prepared["operationId"] as String, prepared["revision"] as Int) { _, _ ->
        f.approvals++
      }
    assertEquals("unknown", unknown["status"])
    assertEquals(1, f.submitted.size)
    val active = f.journal.active()!!
    val result =
      f.engine().execute(active.getString("operationId"), active.getInt("revision")) { _, _ ->
        f.approvals++
      }
    assertEquals("paid", result["status"])
    assertEquals(2, f.submitted.size)
    assertEquals(
      before,
      f.journal.get(result["operationId"] as String).getJSONObject("plan").toString(),
    )
    assertEquals("2000000", result["amountAtoms"])
    assertEquals("1998000", result["receivedAtoms"])
    assertTrue(f.invalidations > 0)
    assertNull(f.journal.active())
  }

  @Test
  fun rejectedApprovalLeavesUnsignedPlanAndNoFinancialIO() = runBlocking {
    val f = Fixture()
    val p = f.engine().prepare("1000000")
    val original = f.journal.active()!!.getJSONObject("plan").toString()
    try {
      f.engine().execute(p["operationId"] as String, p["revision"] as Int) { _, _ ->
        throw IllegalStateException("Rejected")
      }
      fail()
    } catch (expected: IllegalStateException) {
      assertEquals("Rejected", expected.message)
    }
    assertTrue(f.submitted.isEmpty())
    assertTrue(f.journal.public(f.journal.active()!!)["canCancel"] as Boolean)
    assertEquals(original, f.journal.active()!!.getJSONObject("plan").toString())
  }

  @Test
  fun interruptedLocalSigningBeforeDurableBytesCanReprepareSamePlan() = runBlocking {
    val f = Fixture()
    val p = f.engine().prepare("1000000")
    val original = f.journal.active()!!.getJSONObject("plan").toString()
    f.journal.update(p["operationId"] as String, p["revision"] as Int) {
      it.getJSONArray("children").getJSONObject(0).put("signingPending", true)
    }
    val active = f.journal.active()!!
    val result =
      f.engine().execute(active.getString("operationId"), active.getInt("revision")) { _, _ ->
        f.approvals++
      }
    assertEquals("paid", result["status"])
    assertEquals(
      original,
      f.journal.get(result["operationId"] as String).getJSONObject("plan").toString(),
    )
  }

  @Test
  fun malformedUnsignedQuoteRemainsReadableAndCanRefreshWithoutReroll() = runBlocking {
    val f = Fixture()
    f.malformedQuote = true
    try {
      f.engine().prepare("1000000")
      fail()
    } catch (_: Exception) {}
    val saved = f.journal.active()!!
    val plan = saved.getJSONObject("plan").toString()
    val failed = f.journal.public(saved)
    assertEquals("needsReview", failed["status"])
    assertEquals("0", failed["minimumDestinationAtoms"])
    assertTrue(failed["canResume"] as Boolean)
    f.malformedQuote = false
    val repaired = f.engine().prepare("1000000")
    assertEquals("review", repaired["status"])
    assertEquals("999000", repaired["minimumDestinationAtoms"])
    assertEquals(plan, f.journal.active()!!.getJSONObject("plan").toString())
  }

  @Test
  fun insufficientOrCompetingPrivateWorkDoesNotAllocateReceivingWallets() = runBlocking {
    val f = Fixture()
    try {
      f.engine().prepare("4000000")
      fail()
    } catch (failure: RpcFailure) {
      assertEquals(RpcFailureCode.INSUFFICIENT_FUNDS, failure.code)
    }
    assertNull(f.journal.active())
    assertEquals(3, f.store.load().use { JSONObject(it.roleRegistry).getInt("nextRecipient") })
    f.rejectCompeting = true
    try {
      f.engine().prepare("1000000")
      fail()
    } catch (_: IllegalStateException) {}
    assertNull(f.journal.active())
  }

  companion object {
    private const val ASSET = "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx"
  }
}
