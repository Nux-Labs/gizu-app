package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import uniffi.gizu_stored_signer_core.deriveAccountAddressRange

class EarnPrivatePayoutEngineTest {
  private class File : WalletFile {
    var bytes: ByteArray? = null
    var writes = 0
    var failAt = Int.MAX_VALUE

    override fun exists() = bytes != null

    override fun read() = checkNotNull(bytes).copyOf()

    override fun write(bytes: ByteArray) {
      writes++
      check(writes != failAt) { "Storage unavailable" }
      this.bytes = bytes.copyOf()
    }
  }

  private inner class Fixture : AutoCloseable {
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val record = DistributionDepositFixtures.record()
    val store =
      WalletStore(
          File(),
          object : WalletKeys {
            override fun existing() = key

            override fun create() = key

            override fun reset() = key
          },
        )
        .also { it.create(record) }
    val file = File()

    fun restoredJournal() = EarnPayoutJournal(file, { key }, record.id, record.journalId)

    val journal = restoredJournal()
    val descriptor =
      JSONObject()
        .put("kind", "swap")
        .put("profileChainId", 0)
        .put("cycleIndex", 0)
        .put("address", deriveAccountAddressRange(record.entropy, 2u, 1u).single())
        .put("amountAtoms", "990000")
    val now = System.currentTimeMillis()
    val review =
      DistributionDepositFixtures.review(record).also { review ->
        review
          .put("quotedAtMs", now)
          .put("expiresAtMs", now + 45000)
          .put("sourceBudgetAtoms", "990000")
        review
          .getJSONArray("sources")
          .getJSONObject(0)
          .put("kind", "private")
          .put("accountIndex", -1)
          .put("address", descriptor.getString("address"))
          .put("budgetAtoms", "990000")
          .put("maximumFeeAtoms", "0")
          .put("retainedAtoms", "0")
        val proposal =
          JSONObject()
            .put("kind", "privateEarnFunding")
            .put("sourceAccountIndex", -1)
            .put("token", MONAD_EARN_USDC)
            .put("confidentialAccount", cycleConfidential(record))
            .put("budgetAtoms", "990000")
            .put("amountAtoms", "990000")
            .put("maximumTokenFeeAtoms", "0")
            .put("source", descriptor)
        review.put(
          "fundingRows",
          JSONArray().put(JSONObject().put("operationId", "source0").put("proposal", proposal)),
        )
        review.getJSONObject("reservation").put("id", "private_engine").put("legs", JSONArray())
      }
    val grant =
      EarnDepositApproval.fromReview(record, review).apply {
        approveAfterPasskey(now)
        recordCredit("source0", "990000")
      }
    var available = "990000"
    var stale = false
    var signed = 0
    var approved = 0
    var closed = 0
    var factories = 0
    var prepares = 0
    var submissions = mutableListOf<String>()
    var lostSubmit = true
    var status = JSONObject().put("status", "pending").put("receivedAtoms", "0")
    var preparedMinimum: String? = null
    var providerFeeBps: Int? = null
    val excluded = mutableListOf<Set<String>>()
    val gateway =
      object : CashoutGateway {
        override suspend fun prepare(
          operationId: String,
          source: JSONObject,
          recipient: String,
          amount: String,
        ): JSONObject {
          prepares++
          return JSONObject()
            .also { prepared ->
              providerFeeBps?.let { total ->
                prepared
                  .put("providerFeeBps", total)
                  .put(
                    "feePolicy",
                    JSONObject()
                      .put("version", "qualified")
                      .put("route", "payoutRobinhood")
                      .put("totalBps", total)
                      .put(
                        "appFees",
                        JSONArray()
                          .put(JSONObject().put("recipient", "provider.near").put("fee", total)),
                      )
                      .put("referral", JSONObject.NULL)
                      .put("integratorFeeBps", 0)
                      .put("applicationFeeAtoms", "0"),
                  )
              }
            }
            .put("operationId", operationId)
            .put("minimumDestinationAtoms", preparedMinimum ?: amount)
            .put("destinationRecipient", recipient)
            .put("expiresAtMs", System.currentTimeMillis() + 45000)
            .put(
              "intent",
              JSONObject()
                .put("standard", "erc191")
                .put(
                  "payload",
                  JSONObject()
                    .put("nonce", "unique-$prepares")
                    .put("signer_id", source.getString("address"))
                    .put("amount", amount)
                    .toString(),
                ),
            )
        }

        override suspend fun submit(signed: String): JSONObject {
          submissions += signed
          if (lostSubmit) error("Provider accepted request but response was lost")
          return JSONObject().put("intentHash", "0x" + "c".repeat(64))
        }

        override suspend fun status(
          child: JSONObject,
          source: JSONObject,
          usedReceipts: Set<String>,
        ): JSONObject {
          excluded += usedReceipts
          return JSONObject(status.toString())
        }
      }

    fun engine(j: EarnPayoutJournal = journal) =
      EarnPrivatePayoutEngine(
        store,
        j,
        gateway,
        read = {
          mapOf(
            "available" to available,
            "timestampMs" to if (stale) now - 60001 else System.currentTimeMillis(),
            "authenticated" to true,
          )
        },
        authority = {},
        invalidate = { _, _ -> },
        signerFactory = { _, _ ->
          factories++
          object : PrivateEarnSigner {
            var payload = ""
            var evidence = ""

            override fun prepare(prepared: String, balance: String, evidence: String): String {
              // Stand in for native proof rejection; real signature/proof checks run in Rust tests.
              check(
                System.currentTimeMillis() - JSONObject(balance).getLong("timestampMs") <= 60000
              ) {
                "Native balance proof expired"
              }
              payload = JSONObject(prepared).getJSONObject("intent").getString("payload")
              this.evidence = evidence
              return "Exact native private investment review"
            }

            override fun reviewHash() = "0x" + "a".repeat(64)

            override fun approve(hash: String) {
              approved++
            }

            override fun sign(evidence: String): String {
              assertEquals(this.evidence, evidence)
              signed++
              return JSONObject()
                .put("standard", "erc191")
                .put("payload", payload)
                .put("signature", "secp256k1:signature-$signed")
                .toString()
            }

            override fun close() {
              closed++
            }
          }
        },
      )

    fun authorize(row: JSONObject, witness: JSONObject) =
      grant.assertPrepared(record, "payouts", row, witness, System.currentTimeMillis())

    override fun close() {
      grant.invalidate()
      record.close()
    }
  }

  @Test
  fun actualProviderFeeCannotExceedTheReviewedPayoutCap() = runBlocking {
    Fixture().use { f ->
      f.providerFeeBps = 45 // Saved allocation permits at most 4 bps.
      val engine = f.engine()
      val id = engine.create(f.review, "source0", "invest:0").getString("operationId")
      assertThrows(IllegalStateException::class.java) {
        runBlocking { engine.execute(id, f.grant, f::authorize) }
      }
      assertEquals(0, f.approved)
      assertEquals(0, f.signed)
      assertTrue(f.submissions.isEmpty())
    }
  }

  @Test
  fun lostSubmissionResponseRetainsUnknownAndExplicitRetryUsesExactDurableBytes() = runBlocking {
    Fixture().use { f ->
      val engine = f.engine()
      val row = engine.create(f.review, "source0", "invest:0")
      val id = row.getString("operationId")
      engine.execute(id, f.grant, f::authorize)
      val saved = f.restoredJournal().get(id)
      assertEquals("submissionUnknown", saved.getString("status"))
      assertEquals(1, f.signed)
      assertFalse(saved.has("signingAuthorizationPending"))
      val retry = f.engine(f.restoredJournal())
      val pending = retry.reconcile(id)
      assertEquals("submissionUnknown", pending.getString("status"))
      assertEquals("0", pending.getString("receivedAtoms"))
      assertFalse(pending.has("receipt"))
      assertEquals(1, f.submissions.size)
      f.lostSubmit = false
      retry.execute(id, f.grant, f::authorize)
      assertEquals(
        listOf(saved.getString("signedData"), saved.getString("signedData")),
        f.submissions,
      )
      assertEquals(1, f.signed)
      assertEquals(1, f.prepares)
      assertEquals("submitted", f.journal.get(id).getString("status"))
      assertEquals(1, f.closed)
    }
  }

  @Test
  fun missingHistoryCannotCreateDestinationCreditAndSignedChildrenCannotRequote() = runBlocking {
    Fixture().use { f ->
      val engine = f.engine()
      val row = engine.create(f.review, "source0", "invest:0")
      val id = row.getString("operationId")
      engine.execute(id, f.grant, f::authorize)
      f.status = JSONObject().put("status", "awaitingSettlement").put("receivedAtoms", "999999999")
      val reconciled = engine.reconcile(id)
      assertEquals("0", reconciled.getString("receivedAtoms"))
      assertFalse(reconciled.has("receipt"))
      assertEquals("submissionUnknown", reconciled.getString("status"))
      val proposal =
        JSONObject(row.getJSONObject("proposal").toString())
          .put("deadlineMs", System.currentTimeMillis() + 60000)
      assertThrows(IllegalStateException::class.java) {
        f.journal.refreshUnsigned(
          id,
          reconciled.getInt("revision"),
          proposal,
          "replacement",
          "freshnonce",
          "freshhash",
        )
      }
      assertThrows(IllegalStateException::class.java) {
        runBlocking { engine.create(f.review, "source0", "invest:0") }
      }
      assertEquals(1, f.signed)
      assertEquals(1, f.submissions.size)
    }
  }

  @Test
  fun selectedBudgetIncludesNotYetCreatedSiblingsAndSubtractsEverySignedSibling() = runBlocking {
    Fixture().use { f ->
      val engine = f.engine()
      val first = engine.create(f.review, "source0", "invest:0").getString("operationId")
      // The first child is 396000 atoms, but all 990000 selected atoms must still be available.
      f.available = "989999"
      assertThrows(IllegalStateException::class.java) {
        runBlocking { engine.execute(first, f.grant, f::authorize) }
      }
      assertEquals(0, f.factories)
      f.available = "990000"
      engine.execute(first, f.grant, f::authorize)
      assertEquals(1, f.signed)
      val second = engine.create(f.review, "source0", "invest:1").getString("operationId")
      f.available = "593999"
      assertThrows(IllegalStateException::class.java) {
        runBlocking { engine.execute(second, f.grant, f::authorize) }
      }
      assertEquals(1, f.signed)
      f.available = "594000"
      engine.execute(second, f.grant, f::authorize)
      assertEquals(2, f.signed)
      assertEquals(2, f.submissions.size)
    }
  }

  @Test
  fun staleNativeBalanceProofCannotApproveOrSign() = runBlocking {
    Fixture().use { f ->
      val engine = f.engine()
      val id = engine.create(f.review, "source0", "invest:0").getString("operationId")
      f.stale = true
      assertThrows(IllegalStateException::class.java) {
        runBlocking { engine.execute(id, f.grant, f::authorize) }
      }
      assertEquals(0, f.approved)
      assertEquals(0, f.signed)
      assertEquals(0, f.submissions.size)
      assertEquals(1, f.closed)
      assertFalse(f.journal.get(id).optBoolean("signingAuthorizationPending"))
    }
  }

  @Test
  fun approvalStillBindsExactRecipientMinimumAndFeeBeforeAnySignature() = runBlocking {
    for (mutation in 0..2) Fixture().use { f ->
      val engine = f.engine()
      val row = engine.create(f.review, "source0", "invest:0")
      val id = row.getString("operationId")
      assertThrows(IllegalStateException::class.java) {
        runBlocking {
          engine.execute(id, f.grant) { child, witness ->
            val changed = JSONObject(child.toString())
            when (mutation) {
              0 ->
                changed
                  .getJSONObject("proposal")
                  .put("expectedRecipient", cycleAddresses(f.record)[1])
              1 -> changed.getJSONObject("proposal").put("minimumDestinationAtoms", "395999")
              else -> witness.put("providerFeeBps", 5)
            }
            f.authorize(changed, witness)
          }
        }
      }
      assertEquals(0, f.approved)
      assertEquals(0, f.signed)
      assertFalse(f.journal.get(id).optBoolean("signingAuthorizationPending"))
    }
    Fixture().use { f ->
      f.preparedMinimum = "395999"
      assertThrows(IllegalStateException::class.java) {
        runBlocking { f.engine().create(f.review, "source0", "invest:0") }
      }
      assertTrue(f.journal.all().isEmpty())
    }
  }

  @Test
  fun failedWritesNeverSubmitAndExplicitRecoveryPreservesTheUnsentPlan() = runBlocking {
    for (failAfterSign in listOf(false, true)) Fixture().use { f ->
      val engine = f.engine()
      val id = engine.create(f.review, "source0", "invest:0").getString("operationId")
      f.file.failAt = f.file.writes + if (failAfterSign) 2 else 1
      assertThrows(IllegalStateException::class.java) {
        runBlocking { engine.execute(id, f.grant, f::authorize) }
      }
      assertEquals(if (failAfterSign) 1 else 0, f.signed)
      assertEquals(0, f.submissions.size)
      val saved = f.restoredJournal().get(id)
      assertFalse(saved.has("signedData"))
      assertEquals(failAfterSign, saved.optBoolean("signingAuthorizationPending"))
      f.file.failAt = Int.MAX_VALUE
      val fresh =
        EarnDepositApproval.fromRemainingReview(f.record, f.review, System.currentTimeMillis())
          .apply {
            approveAfterPasskey(System.currentTimeMillis())
            recordCredit("source0", "990000")
          }
      val recoveredEngine = f.engine(f.restoredJournal())
      recoveredEngine.execute(id, fresh) { child, witness ->
        fresh.assertPrepared(f.record, "payouts", child, witness, System.currentTimeMillis())
      }
      val recovered = f.journal.get(id)
      assertEquals(
        depositCanonical(saved.getJSONObject("proposal")),
        depositCanonical(recovered.getJSONObject("proposal")),
      )
      assertEquals(if (failAfterSign) 2 else 1, f.signed)
      assertEquals(1, f.submissions.size)
      assertEquals(recovered.getString("signedData"), f.submissions.single())
      assertFalse(recovered.has("signingAuthorizationPending"))
      assertEquals(1, f.prepares)
      fresh.invalidate()
    }
  }
}
