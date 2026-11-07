package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import uniffi.gizu_stored_signer_core.*

class EarnVaultEngineTest {
  private val wallet = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12"
  private val owner = "0x" + "1".repeat(40)
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

  private fun store(recovery: Boolean = false): WalletStore {
    val store =
      WalletStore(
        File(),
        object : WalletKeys {
          override fun existing() = key

          override fun create() = key

          override fun reset() = key
        },
      )
    WalletRecord(
        wallet,
        StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
        ByteArray(32),
        true,
        wallet,
        earnChain = 1,
        earnRecoveryRequired = recovery,
      )
      .use { store.create(it) }
    return store
  }

  private fun state() =
    EarnExecutionState(
      1uL,
      owner,
      4uL,
      100uL,
      10uL,
      hash,
      hash,
      "10000000",
      "1",
      "1000000",
      "10",
      "1000000",
      "10",
      "10",
      ETH_EARN_USDC,
      6u,
      "0x",
      hash,
      hash,
      hash,
    )

  private class Rpc : TransferRpc {
    var sent = 0

    override suspend fun call(method: String, params: org.json.JSONArray): Any =
      when (method) {
        "eth_chainId" -> "0x1"
        "eth_getTransactionReceipt",
        "eth_getTransactionByHash" -> JSONObject.NULL
        "eth_getTransactionCount" -> "0x4"
        "eth_getBlockByNumber" ->
          JSONObject().put("number", params.getString(0)).put("hash", "0x" + "a".repeat(64))
        "eth_sendRawTransaction" -> {
          sent++
          error("response lost")
        }
        else -> error("Unexpected $method")
      }
  }

  private fun setup(file: File = File()): Pair<EarnVaultJournal, File> {
    val j = EarnVaultJournal(file, { key }, wallet, wallet)
    j.create(
      JSONObject()
        .put("operationId", "deposit-1")
        .put("revision", 1)
        .put("nonce", 4)
        .put("deadline", System.currentTimeMillis() / 1000 + 300)
        .put("withdrawalReserveWei", "1000")
        .put("gasLimits", org.json.JSONArray().put(300000))
        .put("kind", "vaultDeposit")
        .put("expectedFrom", owner)
        .put("amountAtoms", "1000000")
    )
    return j to file
  }

  private var signatures = 0
  private var signedReference: NativeGasReference? = null

  private inner class Signer(private val callNonce: ULong = 4uL) : EarnVaultSigner {
    override fun prepare(revision: ULong, state: EarnExecutionState) = "native full review"

    override fun reviewHash() = hash

    override fun preparedCalls() =
      listOf(EarnExecutionCall(ETH_EARN_ROUTER, "0x6bbba4e0", "0", callNonce, 300000uL, "10", "1"))

    override fun approve(revision: ULong, hash: String) {}

    override fun signNextWithCanonicalReference(
      revision: ULong,
      state: EarnExecutionState,
      reference: NativeGasReference,
    ): NativeSignedEarnTransaction {
      assertEquals(state.blockNumber, reference.currentBlockNumber)
      assertEquals(state.blockHash, reference.currentBlockHash)
      signedReference = reference
      signatures++
      return NativeSignedEarnTransaction(
        "0x02abcdef",
        hash,
        owner,
        4uL,
        "deposit-1",
        revision,
        0u,
        hash,
      )
    }

    override fun close() {}
  }

  @Test
  fun longReviewSignsOnlyAfterNativeCanonicalAnchorRecheck() = runBlocking {
    val (j, _) = setup()
    val rpc = Rpc()
    var reads = 0
    EarnVaultEngine(
        store(),
        j,
        rpc,
        { _, _ -> Signer() },
        { _, _, _ -> state().also { it.blockNumber = if (reads++ == 0) 10uL else 13uL } },
      )
      .use { engine ->
        val review = engine.prepare("deposit-1", 1)
        try {
          engine.execute(review) {}
        } catch (_: IllegalStateException) {}
      }
    assertEquals(1, signatures)
    assertEquals(10uL, signedReference?.reviewedBlockNumber)
    assertEquals(13uL, signedReference?.currentBlockNumber)
    assertTrue(j.get("deposit-1").steps()[0].has("raw"))
  }

  @Test
  fun failedPersistenceNeverBroadcasts() = runBlocking {
    val (j, file) = setup()
    val rpc = Rpc()
    EarnVaultEngine(store(), j, rpc, { _, _ -> Signer() }, { _, _, _ -> state() }).use { engine ->
      val review = engine.prepare("deposit-1", 1)
      file.fail = true
      try {
        engine.execute(review) {}
        fail("Storage must fail")
      } catch (_: IllegalStateException) {}
    }
    assertEquals(0, rpc.sent)
    assertFalse(j.get("deposit-1").steps()[0].has("raw"))
  }

  @Test
  fun unknownSendCanOnlyRebroadcastSavedBytesWithFreshAuthority() = runBlocking {
    val (j, _) = setup()
    val rpc = Rpc()
    EarnVaultEngine(store(), j, rpc, { _, _ -> Signer() }, { _, _, _ -> state() }).use { engine ->
      val review = engine.prepare("deposit-1", 1)
      try {
        engine.execute(review) {}
        fail("Send must fail")
      } catch (_: IllegalStateException) {}
    }
    assertEquals(1, signatures)
    assertEquals("unknown", j.get("deposit-1").steps()[0].getString("status"))
    EarnVaultEngine(store(), j, rpc, { _, _ -> error("Retry cannot sign") }, { _, _, _ -> state() })
      .use { engine ->
        val review = engine.prepare("deposit-1", j.get("deposit-1").getInt("revision"))
        assertTrue(review.retry)
        try {
          engine.execute(review) { error("No approval") }
          fail("Authority must fail")
        } catch (_: IllegalStateException) {}
        assertEquals(1, rpc.sent)
        try {
          engine.execute(review) {}
          fail("Retry send must fail")
        } catch (_: IllegalStateException) {}
      }
    assertEquals(1, signatures)
    assertEquals(2, rpc.sent)
  }

  @Test
  fun changedContractCodeCannotAuthorizeSavedByteRetry() = runBlocking {
    val (j, _) = setup()
    val rpc = Rpc()
    EarnVaultEngine(store(), j, rpc, { _, _ -> Signer() }, { _, _, _ -> state() }).use { engine ->
      val review = engine.prepare("deposit-1", 1)
      try {
        engine.execute(review) {}
        fail("Send must fail")
      } catch (_: IllegalStateException) {}
    }
    val changed = state().also { it.routerCodeHash = "0x" + "b".repeat(64) }
    EarnVaultEngine(store(), j, rpc, { _, _ -> error("Retry cannot sign") }, { _, _, _ -> changed })
      .use { engine ->
        try {
          engine.prepare("deposit-1", j.get("deposit-1").getInt("revision"))
          fail("Changed router must fail")
        } catch (_: IllegalStateException) {}
      }
    assertEquals(1, signatures)
    assertEquals(1, rpc.sent)
    assertTrue(j.get("deposit-1").earnBlocked())
  }

  @Test
  fun approvalFinalizedAcrossMultipleBlocksNeedsFreshReviewAndNeverWithdraws() = runBlocking {
    val (j, _) = setup()
    j.update("deposit-1", 1) {
      it.getJSONObject("proposal").put("gasLimits", org.json.JSONArray().put(65000).put(300000))
    }
    val calls =
      org.json
        .JSONArray()
        .put(
          JSONObject()
            .put("to", ETH_EARN_USDC)
            .put("data", "0x095ea7b3")
            .put("nonce", "4")
            .put("valueWei", "0")
            .put("gasLimit", "65000")
            .put("maxFeePerGasWei", "10")
            .put("priorityFeePerGasWei", "1")
        )
        .put(
          JSONObject()
            .put("to", ETH_EARN_ROUTER)
            .put("data", "0x6bbba4e0")
            .put("nonce", "5")
            .put("valueWei", "0")
            .put("gasLimit", "300000")
            .put("maxFeePerGasWei", "10")
            .put("priorityFeePerGasWei", "1")
        )
    j.prepare("deposit-1", 2, calls, hash, "approval and deposit review")
    // Recorded canonical allowance receipt from the previous ceremony.
    j.update("deposit-1", 3) {
      it
        .steps()[0]
        .put("raw", "0x02approval")
        .put("transactionHash", hash)
        .put("status", "finalized")
    }
    val fresh =
      state().also {
        it.nonce = 5uL
        it.blockNumber = 12uL
      }
    val receipt =
      JSONObject()
        .put("transactionHash", hash)
        .put("from", owner)
        .put("to", ETH_EARN_USDC)
        .put("status", "0x1")
        .put("blockNumber", "0xb")
        .put("blockHash", hash)
        .put("gasUsed", "0x100")
        .put("effectiveGasPrice", "0xa")
        .put(
          "logs",
          org.json
            .JSONArray()
            .put(
              JSONObject()
                .put("address", ETH_EARN_USDC)
                .put(
                  "topics",
                  org.json
                    .JSONArray()
                    .put(hash)
                    .put("0x" + earnAddressWord(owner))
                    .put("0x" + earnAddressWord(ETH_EARN_ROUTER)),
                )
                .put("data", "0x" + earnNumberWord("1000000"))
            ),
        )
    val approvalTx =
      JSONObject()
        .put("hash", hash)
        .put("from", owner)
        .put("to", ETH_EARN_USDC)
        .put("input", "0x095ea7b3")
        .put("nonce", "0x4")
        .put("value", "0x0")
        .put("gas", "0xfde8")
        .put("maxFeePerGas", "0xa")
        .put("maxPriorityFeePerGas", "0x1")
    val rpc =
      object : TransferRpc {
        override suspend fun call(method: String, params: org.json.JSONArray): Any =
          when (method) {
            "eth_chainId" -> "0x1"
            "eth_getTransactionReceipt" -> receipt
            "eth_getTransactionByHash" -> approvalTx
            "eth_getBlockByNumber" -> JSONObject().put("hash", hash).put("number", "0xc")
            else -> error("Preparation must not send: $method")
          }
      }
    var reapprovedProposal: JSONObject? = null
    EarnVaultEngine(
        store(),
        j,
        rpc,
        { proposal, _ ->
          reapprovedProposal = JSONObject(proposal)
          Signer(5uL)
        },
        { _, _, _ -> fresh },
        { hash },
      )
      .use { engine ->
        val review = engine.prepare("deposit-1", 4)
        assertFalse(review.retry)
        assertEquals(1, review.index)
        assertEquals("vaultDeposit", reapprovedProposal!!.getString("kind"))
        assertEquals(5L, reapprovedProposal!!.getLong("nonce"))
        assertEquals(1, reapprovedProposal!!.getJSONArray("gasLimits").length())
        assertEquals("needsReview", j.public(j.get("deposit-1"))["status"])
        assertEquals(0, signatures)
        assertEquals(1, j.all().size)
        assertFalse(
          j.all().any { it.getJSONObject("proposal").getString("kind") == "vaultRedeemAll" }
        )
      }
  }

  @Test
  fun savedApprovalRetryRetainsFullRemainingGasAndWithdrawalReserve() {
    val op =
      JSONObject()
        .put(
          "proposal",
          JSONObject()
            .put("kind", "vaultDeposit")
            .put("deadline", 200)
            .put("withdrawalReserveWei", "1000"),
        )
        .put(
          "steps",
          org.json
            .JSONArray()
            .put(
              JSONObject()
                .put("to", ETH_EARN_USDC)
                .put("status", "signed")
                .put("raw", "0x02")
                .put("gasLimit", "65000")
                .put("maxFeePerGasWei", "10")
                .put("priorityFeePerGasWei", "1")
            )
            .put(
              JSONObject()
                .put("to", ETH_EARN_ROUTER)
                .put("status", "planned")
                .put("gasLimit", "300000")
                .put("maxFeePerGasWei", "10")
                .put("priorityFeePerGasWei", "1")
            ),
        )
    val funded = state().also { it.nativeBalanceWei = "3651000" }
    requireEarnRetryEconomics(op, op.steps()[0], funded, 100L)
    val underfunded = funded.copy(nativeBalanceWei = "3650999")
    assertThrows(IllegalStateException::class.java) {
      requireEarnRetryEconomics(op, op.steps()[0], underfunded, 100L)
    }
    assertThrows(IllegalStateException::class.java) {
      requireEarnRetryEconomics(op, op.steps()[0], funded.copy(baseFeeWei = "10"), 100L)
    }
    val router = op.steps()[1].put("raw", "0x02").put("status", "signed")
    assertThrows(IllegalStateException::class.java) {
      requireEarnRetryEconomics(op, router, funded, 200L)
    }
    op.put(
      "signingProposal",
      JSONObject(op.getJSONObject("proposal").toString()).put("deadline", 500),
    )
    requireEarnRetryEconomics(op, router, funded, 200L)
    assertThrows(IllegalStateException::class.java) {
      requireEarnRetryEconomics(op, router, funded, 500L)
    }
  }

  @Test
  fun recoveredWalletCannotPrepareOrSign() = runBlocking {
    val (j, _) = setup()
    EarnVaultEngine(
        store(true),
        j,
        Rpc(),
        { _, _ -> error("Recovery must not load signer") },
        { _, _, _ -> state() },
      )
      .use { engine ->
        try {
          engine.prepare("deposit-1", 1)
          fail("Recovery gate must fail")
        } catch (_: IllegalStateException) {}
      }
    assertEquals(0, signatures)
  }
}
