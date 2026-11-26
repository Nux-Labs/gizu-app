package io.gizu.storedwallet

import java.math.BigInteger
import javax.crypto.KeyGenerator
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnSourceReplannerTest {
  @Test
  fun newFundingNetworksKeepTheirAccountOneSourceDuringRefresh() = runBlocking {
    for (chain in listOf(8453, 42161)) {
      val network = fundingNetwork(chain)
      val origin =
        if (chain == 8453) "nep141:base-${network.token}.omft.near"
        else "nep141:arb-${network.token}.omft.near"
      val row =
        saved().also {
          it
            .getJSONObject("proposal")
            .put("chainId", chain)
            .put("sourceAccountIndex", 1)
            .put("token", network.token)
        }
      val planner =
        EarnSourceReplanner(
          null,
          feeReader = { _, request ->
            JSONObject(
                fees(request)
                  .toString()
                  .replace(MONAD_EARN_USDC, network.token)
                  .replace(MONAD_EARN_USDC.drop(2).lowercase(), network.token.drop(2))
              )
              .put("chainId", chain)
              .put("version", "gizu-source-funding-v2")
          },
          quoteCreator = { _, _, revision, _, _, amount, _ ->
            quote(revision, amount) +
              mapOf("chainId" to chain, "token" to network.token, "originAsset" to origin)
          },
          stateReader = {
            EarnSourceReplanState(
              owner,
              "0x4",
              "1000000",
              4uL,
              "0xef0100" + EARN_IMPLEMENTATION.drop(2),
            )
          },
          sourceIdentity = { _, index ->
            assertEquals(1, index)
            owner
          },
          confidentialIdentity = { confidential },
          now = { now },
        )
      val (proposal, unsigned) = record().use { planner.replan(it, row) }
      assertEquals(chain, proposal.getInt("chainId"))
      assertEquals(network.token, proposal.getString("token"))
      assertEquals("989400", proposal.getString("amountAtoms"))
      assertEquals(owner, unsigned.getString("sender"))
    }
  }

  @Test
  fun depositApprovalRefreshKeepsTheExactReviewedAmountAndFeeCeiling() = runBlocking {
    val old =
      saved()
        .put(
          "fundingApprovalLimits",
          JSONObject()
            .put("amountAtoms", "989000")
            .put("maximumFeeAtoms", "1000")
            .put("minimumCreditAtoms", "989000"),
        )
    val next = record().use { replanner().replan(it, old) }
    assertEquals("989000", next.first.getString("amountAtoms"))
    assertEquals("1000", next.first.getString("maximumTokenFeeAtoms"))
    assertTrue(next.first.getLong("deadline") > now / 1000)
    assertEquals("0x4", next.first.getString("nonce"))
    try {
      record().use {
        replanner(feeReader = { _, request -> fees(request, multiplier = 2) }).replan(it, old)
      }
      fail("A refresh cannot increase an approved fee cap")
    } catch (_: IllegalStateException) {}
  }

  @Test
  fun depositRefreshRejectsLowerCreditAndInvalidApprovedHeadroom() = runBlocking {
    fun bounded() =
      saved()
        .put(
          "fundingApprovalLimits",
          JSONObject()
            .put("amountAtoms", "989000")
            .put("maximumFeeAtoms", "1000")
            .put("minimumCreditAtoms", "989000"),
        )
    try {
      record().use {
        replanner(
            quoteReader = { _, _, revision, _, _, amount, _ ->
              quote(revision, amount) + ("minimumCreditAtoms" to "988999")
            }
          )
          .replan(it, bounded())
      }
      fail("A refresh cannot reduce approved private credit")
    } catch (_: IllegalStateException) {}
    val overBudget =
      bounded().also {
        it.getJSONObject("proposal").put("amountAtoms", "989400")
        it.getJSONObject("fundingApprovalLimits").put("amountAtoms", "989400")
      }
    try {
      record().use { replanner().replan(it, overBudget) }
      fail("The approved maximum must fit beside the exact amount and reserve")
    } catch (_: IllegalStateException) {}
  }

  private val wallet = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12"
  private val owner = "0x" + "1".repeat(40)
  private val confidential = "0x" + "2".repeat(40)
  private val deposit = "0x" + "3".repeat(40)
  private val hash = "0x" + "a".repeat(64)
  private val now = 1000000L

  private fun record() =
    WalletRecord(
      wallet,
      StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
      ByteArray(32),
      true,
      wallet,
      earnChain = 1,
    )

  private fun saved() =
    JSONObject()
      .put("operationId", "source1")
      .put("walletId", wallet)
      .put("status", "planned")
      .put("revision", 5)
      .put(
        "proposal",
        JSONObject()
          .put("kind", "sourceFunding")
          .put("operationId", "source1")
          .put("revision", 7)
          .put("chainId", 143)
          .put("profileChainId", 1)
          .put("sourceAccountIndex", 3)
          .put("cycleIndex", 0)
          .put("fundingBatchId", "batch1")
          .put("fundingBatchSize", 2)
          .put("expectedFrom", owner)
          .put("confidentialAccount", confidential)
          .put("refundOwner", owner)
          .put("token", MONAD_EARN_USDC)
          .put("budgetAtoms", "1000000")
          .put("withdrawalReserveAtoms", "10000")
          .put("amountAtoms", "989000")
          .put("maximumTokenFeeAtoms", "1000")
          .put("recipient", deposit)
          .put("deadline", 900)
          .put("nonce", "0x4")
          .put("quoteId", hash)
          .put("slippageBps", 0),
      )

  private fun quote(revision: Int, amount: String) =
    mapOf<String, Any>(
      "operationId" to "source1",
      "revision" to revision,
      "quoteId" to hash,
      "chainId" to 143,
      "token" to MONAD_EARN_USDC,
      "recipient" to deposit,
      "confidentialAccount" to confidential,
      "refundOwner" to owner,
      "amountAtoms" to amount,
      "expiresAt" to 1300L,
      "minimumCreditAtoms" to amount,
      "originAsset" to EARN_MONAD_ASSET,
      "providerFeeBps" to 2,
    )

  private fun fees(request: JSONObject, multiplier: Int = 1, signatureBytes: Int = 64): JSONObject {
    val operation =
      JSONObject()
        .put("sender", owner)
        .put("nonce", "0x4")
        .put("paymaster", EARN_PAYMASTER)
        .put("callData", "0x1234")
        .put("signature", "SDK_DUMMY_SIGNATURE")
        .put("eip7702Auth", JSONObject().put("r", "SDK_AUTH_STUB"))
        .put("authorization", JSONObject().put("address", deposit))
        .put("maxFeePerGas", "0x" + multiplier.toString(16))
        .put("maxPriorityFeePerGas", "0x0")
    listOf(
        "callGasLimit",
        "verificationGasLimit",
        "preVerificationGas",
        "paymasterVerificationGasLimit",
        "paymasterPostOpGasLimit",
      )
      .forEach { operation.put(it, "0x64") }
    val data =
      "0200" +
        "00".repeat(12) +
        MONAD_EARN_USDC.drop(2).lowercase() +
        "64".padStart(32, '0') +
        BigInteger.TEN.pow(18).toString(16).padStart(64, '0') +
        "00".repeat(36 + signatureBytes)
    operation.put("paymasterData", "0x$data")
    val cap = 600L * multiplier
    return JSONObject()
      .put("version", "gizu-monad-funding-v1")
      .put("chainId", 143)
      .put("owner", owner)
      .put("recipient", request.getString("recipient"))
      .put("token", MONAD_EARN_USDC)
      .put("amount", request.getString("amount"))
      .put("budget", request.getString("budget"))
      .put("feeCap", cap.toString())
      .put(
        "remainingBudget",
        (request.getString("budget").toBigInteger() -
            request.getString("amount").toBigInteger() -
            cap.toBigInteger())
          .toString(),
      )
      .put("entryPoint", EARN_ENTRY_POINT)
      .put("paymaster", EARN_PAYMASTER)
      .put("delegation", EARN_IMPLEMENTATION)
      .put("executionAvailable", false)
      .put("paymasterDataStatus", "stub")
      .put("timestampMs", now)
      .put("expiresAtMs", now + 60000)
      .put("referenceBlock", "10")
      .put("referenceHash", hash)
      .put("authorizationRequired", false)
      .put("authorizationNonce", "4")
      .put("operation", operation)
  }

  private fun replanner(
    quotes: EarnQuoteJournal? = null,
    feeReader: suspend (Int, JSONObject) -> JSONObject = { _, request -> fees(request) },
    quoteReader: suspend (Int, String, Int, String, String, String, Int) -> Map<String, Any> =
      { _, _, revision, _, _, amount, _ ->
        quote(revision, amount)
      },
  ) =
    EarnSourceReplanner(
      quotes,
      feeReader = feeReader,
      quoteCreator = quoteReader,
      stateReader = {
        EarnSourceReplanState(
          owner,
          "0x4",
          "1000000",
          4uL,
          "0xef0100" + EARN_IMPLEMENTATION.drop(2),
        )
      },
      sourceIdentity = { _, index ->
        assertEquals(3, index)
        owner
      },
      confidentialIdentity = { confidential },
      now = { now },
    )

  @Test
  fun supportsBothDocumentedPaymasterSignatureLengthsAndRejectsExtraData() = runBlocking {
    for (signatureBytes in listOf(64, 65)) {
      val plan =
        record().use {
          replanner(feeReader = { _, request -> fees(request, signatureBytes = signatureBytes) })
            .replan(it, saved())
        }
      assertEquals((118 + signatureBytes) * 2 + 2, plan.second.getString("paymasterData").length)
    }
    for (signatureBytes in listOf(63, 66)) {
      try {
        record().use {
          replanner(feeReader = { _, request -> fees(request, signatureBytes = signatureBytes) })
            .replan(it, saved())
        }
        fail("Unsupported paymaster signature size")
      } catch (_: IllegalStateException) {}
    }
  }

  @Test
  fun refreshRetainsExactBatchIdentityAndBudgetWithNewCoreRevisionAndNoSignedBytes() = runBlocking {
    val original = saved()
    val (p, op) = record().use { replanner().replan(it, original) }
    for (field in
      listOf(
        "operationId",
        "sourceAccountIndex",
        "cycleIndex",
        "fundingBatchId",
        "fundingBatchSize",
        "budgetAtoms",
      )) assertEquals(original.getJSONObject("proposal").get(field), p.get(field))
    assertEquals(8, p.getInt("revision"))
    assertEquals("989400", p.getString("amountAtoms"))
    assertEquals("600", p.getString("maximumTokenFeeAtoms"))
    assertEquals("10000", p.getString("withdrawalReserveAtoms"))
    assertEquals("0x", op.getString("signature"))
    assertFalse(op.has("eip7702Auth"))
    assertFalse(op.has("authorization"))
    assertEquals(7, original.getJSONObject("proposal").getInt("revision"))
  }

  @Test
  fun feeIncreaseRequotesSameChildAtNextRevisionInsideOriginalBudget() = runBlocking {
    var calls = 0
    val revisions = mutableListOf<Int>()
    val r =
      replanner(
        feeReader = { _, request -> fees(request, if (++calls == 1) 1 else 2) },
        quoteReader = { _, id, revision, from, c, amount, _ ->
          assertEquals("source1", id)
          assertEquals(owner, from)
          assertEquals(confidential, c)
          revisions.add(revision)
          quote(revision, amount)
        },
      )
    val (p, _) = record().use { r.replan(it, saved()) }
    assertEquals(listOf(8, 9), revisions)
    assertEquals("988800", p.getString("amountAtoms"))
    assertEquals("1200", p.getString("maximumTokenFeeAtoms"))
  }

  @Test
  fun signedSourceAndChangedOwnerOrFeeCapCannotReachReplacement() = runBlocking {
    var network = 0
    val r =
      replanner(
        feeReader = { _, request ->
          network++
          fees(request)
        }
      )
    for (op in
      listOf(
        saved().put("signedUserOperation", "exact saved bytes"),
        saved().also { it.getJSONObject("proposal").put("expectedFrom", deposit) },
      )) {
      try {
        record().use { r.replan(it, op) }
        fail("Immutable or signed source")
      } catch (_: IllegalStateException) {}
    }
    assertEquals(0, network)
    val forged = replanner(feeReader = { _, request -> fees(request).put("feeCap", "1") })
    try {
      record().use { forged.replan(it, saved()) }
      fail("Paymaster cap must be independently recomputed")
    } catch (_: IllegalStateException) {}
  }

  @Test
  fun unstableFeesStopAtFourQuotesAndChangedNativeNonceFailsClosed() = runBlocking {
    var feesCalled = 0
    var quotesCalled = 0
    val r =
      replanner(
        feeReader = { _, request -> fees(request, ++feesCalled) },
        quoteReader = { _, _, revision, _, _, amount, _ ->
          quotesCalled++
          quote(revision, amount)
        },
      )
    val original = saved()
    try {
      record().use { r.replan(it, original) }
      fail("Fees never stabilize")
    } catch (_: IllegalStateException) {}
    assertEquals(4, quotesCalled)
    assertEquals(7, original.getJSONObject("proposal").getInt("revision"))
    val changed =
      replanner(
        feeReader = { _, request ->
          fees(request).also { row -> row.getJSONObject("operation").put("nonce", "0x5") }
        }
      )
    try {
      record().use { changed.replan(it, saved()) }
      fail("Native nonce changed")
    } catch (_: IllegalStateException) {}
  }

  @Test
  fun interruptedProtectedQuoteCommitCannotTrapOriginalSourceRevisionOnReopen() = runBlocking {
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val file =
      object : WalletFile {
        var bytes: ByteArray? = null

        override fun exists() = bytes != null

        override fun read() = bytes!!.copyOf()

        override fun write(bytes: ByteArray) {
          this.bytes = bytes.copyOf()
        }
      }
    val journal = EarnQuoteJournal(file, { key }, wallet, wallet)
    journal.save(
      JSONObject(quote(8, "989400"))
        .put("recoveryEnvelope", "v1.saved-protected-quote")
        .put("authenticatedBodyHash", hash)
    )
    val reopened = EarnQuoteJournal(file, { key }, wallet, wallet)
    val (p, _) = record().use { replanner(quotes = reopened).replan(it, saved()) }
    assertEquals(9, p.getInt("revision"))
    assertEquals("989400", p.getString("amountAtoms"))
    assertNotNull(reopened.get("source1", 8))
  }
}
