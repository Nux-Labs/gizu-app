package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import uniffi.gizu_stored_signer_core.*

class EarnLiquidityCancellationEngineTest {
  private val wallet = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12"
  private val owner = "0x" + "1".repeat(40)
  private val recipient = "0x" + "2".repeat(40)
  private val originalHash = "0x" + "a".repeat(64)
  private val cancellationHash = "0x" + "b".repeat(64)
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

  private fun setup(file: File = File()): EarnLiquidityJournal {
    val j = EarnLiquidityJournal(file, { key }, wallet, wallet)
    val p =
      JSONObject()
        .put("operationId", "return-1")
        .put("revision", 7)
        .put("kind", "returnEth")
        .put("chainId", 1)
        .put("quoteId", "quote")
        .put("expectedFrom", owner)
        .put("confidentialAccount", recipient)
        .put("recipient", recipient)
        .put("amountAtoms", "1000")
        .put("nonce", 4)
        .put("deadline", 100)
        .put("gasLimit", 21000)
        .put("maxFeePerGasWei", "10")
        .put("priorityFeePerGasWei", "0")
    j.create(p)
    j.update("return-1", 1) {
      it
        .put("raw", "0xf8original")
        .put("transactionHash", originalHash)
        .put("signingProposal", p)
        .put("stateBinding", JSONObject())
        .put("status", "pending")
        .put("cancellationAllowed", true)
    }
    return j
  }

  private fun state() =
    NativeEthereumLiquidityState(
      1uL,
      owner,
      100uL,
      10uL,
      originalHash,
      cancellationHash,
      4uL,
      "10000000",
      "0",
      "0",
      "0",
      "0",
      "0",
      originalHash,
      "0",
      "0",
      "0x",
      "0x",
      "0",
      "1",
      originalHash,
      originalHash,
      originalHash,
      originalHash,
      originalHash,
      originalHash,
    )

  private inner class Rpc : TransferRpc {
    var sends = 0
    var latest = "0x4"
    var pending = "0x5"
    var known = true
    val raws = mutableListOf<String>()

    override suspend fun call(method: String, params: JSONArray): Any =
      when (method) {
        "eth_chainId" -> "0x1"
        "eth_getTransactionCount" -> if (params.getString(1) == "pending") pending else latest
        "eth_getTransactionByHash" ->
          if (params.getString(0) == originalHash && known)
            JSONObject()
              .put("hash", originalHash)
              .put("from", owner)
              .put("to", recipient)
              .put("input", "0x")
              .put("nonce", "0x4")
              .put("gas", "0x5208")
              .put("value", "0x3e8")
              .put("type", "0x0")
              .put("gasPrice", "0xa")
              .put("blockHash", JSONObject.NULL)
          else JSONObject.NULL
        "eth_sendRawTransaction" -> {
          sends++
          raws.add(params.getString(0))
          error("response lost")
        }
        else -> error("Unexpected $method")
      }
  }

  private var signatures = 0

  private inner class Signer(private val p: JSONObject, private val changed: Boolean = false) :
    NativeLiquidityCancellationSigner {
    override fun prepare(revision: ULong, state: NativeEthereumLiquidityState) =
      if (changed) "changed review"
      else "cancel same nonce ${p.getLong("nonce")} fee ${p.getString("maxFeePerGasWei")}"

    override fun reviewHash() = if (changed) originalHash else cancellationHash

    override fun approve(revision: ULong, hash: String) {}

    override fun sign(
      revision: ULong,
      state: NativeEthereumLiquidityState,
    ): NativeSignedEarnTransaction {
      signatures++
      return NativeSignedEarnTransaction(
        "0xf8private-cancellation",
        cancellationHash,
        owner,
        4uL,
        "return-1",
        revision,
        0u,
        cancellationHash,
      )
    }

    override fun close() {}
  }

  @Test
  fun cancellationUsesOnlySavedRawSameNonceAndCannotBroadcastBeforeDurableCommit() = runBlocking {
    val file = File()
    val j = setup(file)
    val rpc = Rpc()
    EarnLiquidityCancellationEngine(
        store(),
        j,
        rpc,
        signerFactory = { p, _ ->
          val parsed = JSONObject(p)
          assertEquals("0xf8original", parsed.getString("originalRawTransaction"))
          assertEquals(originalHash, parsed.getString("originalTransactionHash"))
          assertEquals(4L, parsed.getLong("nonce"))
          assertEquals("12", parsed.getString("maxFeePerGasWei"))
          assertEquals("0", parsed.getString("priorityFeePerGasWei"))
          Signer(parsed)
        },
        stateReader = { state() },
        reconcile = {},
      )
      .use { engine ->
        val review = engine.prepare("return-1", 2)!!
        file.fail = true
        try {
          engine.execute(review) {}
          fail("Commit must fail")
        } catch (_: IllegalStateException) {}
      }
    assertEquals(0, rpc.sends)
    assertFalse(j.get("return-1").has("cancellationAttempts"))
    assertEquals("0xf8original", j.get("return-1").getString("raw"))
  }

  @Test
  fun uncertainCancellationIsEncryptedAndRetryRequiresFreshAuthorityAndIdenticalBytes() =
    runBlocking {
      val file = File()
      val j = setup(file)
      val rpc = Rpc()
      EarnLiquidityCancellationEngine(
          store(),
          j,
          rpc,
          signerFactory = { p, _ -> Signer(JSONObject(p)) },
          stateReader = { state() },
          reconcile = {},
        )
        .use { engine ->
          val review = engine.prepare("return-1", 2)!!
          try {
            engine.execute(review) {}
            fail("Lost send")
          } catch (_: IllegalStateException) {}
        }
      assertEquals(1, signatures)
      assertEquals(1, rpc.sends)
      assertTrue(j.get("return-1").liquidityBlocked())
      assertFalse(String(file.bytes!!).contains("private-cancellation"))
      assertFalse(j.public(j.get("return-1")).toString().contains("private-cancellation"))
      EarnLiquidityCancellationEngine(
          store(),
          j,
          rpc,
          signerFactory = { _, _ -> error("Retry must never sign again") },
          stateReader = { state() },
          reconcile = {},
        )
        .use { engine ->
          val review = engine.prepare("return-1", 3)!!
          assertTrue(review.retry)
          try {
            engine.execute(review) { error("Missing fresh approval") }
            fail("Approval required")
          } catch (_: IllegalStateException) {}
          assertEquals(1, rpc.sends)
          try {
            engine.execute(review) {}
            fail("Lost retry")
          } catch (_: IllegalStateException) {}
        }
      assertEquals(1, signatures)
      assertEquals(2, rpc.sends)
      assertEquals(rpc.raws[0], rpc.raws[1])
      assertEquals(1, j.get("return-1").getJSONArray("cancellationAttempts").length())
    }

  @Test
  fun originalNonceMinedDuringCeremonyPreventsReplacementSigning() = runBlocking {
    val j = setup()
    val rpc = Rpc()
    EarnLiquidityCancellationEngine(
        store(),
        j,
        rpc,
        signerFactory = { p, _ -> Signer(JSONObject(p)) },
        stateReader = { state() },
        reconcile = {},
      )
      .use { engine ->
        val review = engine.prepare("return-1", 2)!!
        rpc.latest = "0x5"
        try {
          engine.execute(review) {}
          fail("Original already mined")
        } catch (_: IllegalStateException) {}
      }
    assertEquals(0, signatures)
    assertEquals(0, rpc.sends)
    assertFalse(j.get("return-1").has("cancellationAttempts"))
  }

  @Test
  fun changedReviewRecoveryWalletAndUnrelatedPendingNonceCannotAuthorizeCancellation() =
    runBlocking {
      val j = setup()
      val rpc = Rpc()
      var made = 0
      EarnLiquidityCancellationEngine(
          store(),
          j,
          rpc,
          signerFactory = { p, _ -> Signer(JSONObject(p), ++made > 1) },
          stateReader = { state() },
          reconcile = {},
        )
        .use { engine ->
          val review = engine.prepare("return-1", 2)!!
          try {
            engine.execute(review) {}
            fail("Changed review")
          } catch (_: IllegalStateException) {}
        }
      assertEquals(0, signatures)
      assertEquals(0, rpc.sends)
      EarnLiquidityCancellationEngine(
          store(true),
          j,
          rpc,
          signerFactory = { _, _ -> error("Recovery blocked") },
          stateReader = { state() },
          reconcile = {},
        )
        .use { engine ->
          try {
            engine.prepare("return-1", 2)
            fail("Recovery blocked")
          } catch (_: IllegalStateException) {}
        }
      rpc.known = false
      EarnLiquidityCancellationEngine(
          store(),
          j,
          rpc,
          signerFactory = { _, _ -> error("Unknown pending cannot sign") },
          stateReader = { state() },
          reconcile = {},
        )
        .use { engine ->
          try {
            engine.prepare("return-1", 2)
            fail("Unknown pending")
          } catch (_: IllegalStateException) {}
        }
    }

  @Test
  fun distributionCancellationRetainsOriginalCycleAndInvestmentSlot() {
    val op = setup().get("return-1").put("raw", "0x02original")
    op.getJSONObject("signingProposal").put("cycleIndex", 7).put("investmentSlot", 3)
    val proposal = nativeLiquidityCancellationProposal(op, state(), 100)
    assertEquals(7, proposal.getInt("cycleIndex"))
    assertEquals(3, proposal.getInt("investmentSlot"))
  }

  @Test
  fun eip1559CancellationBumpsBothFeesAndPreservesNonceAcrossFurtherApprovedBumps() {
    val op = setup().get("return-1").put("raw", "0x02original")
    op.getJSONObject("signingProposal").put("priorityFeePerGasWei", "2")
    val p = nativeLiquidityCancellationProposal(op, state(), 100)
    assertEquals("12", p.getString("maxFeePerGasWei"))
    assertEquals("3", p.getString("priorityFeePerGasWei"))
    assertEquals("252000", p.getString("maximumGasCostWei"))
    assertEquals(4L, p.getLong("nonce"))
    op.put(
      "cancellationAttempts",
      JSONArray()
        .put(
          JSONObject()
            .put("raw", "0x02saved-cancellation")
            .put("transactionHash", cancellationHash)
            .put("proposal", p)
        ),
    )
    val next = nativeLiquidityCancellationProposal(op, state(), 101)
    assertEquals("14", next.getString("maxFeePerGasWei"))
    assertEquals("4", next.getString("priorityFeePerGasWei"))
    assertEquals(cancellationHash, next.getString("originalTransactionHash"))
    assertEquals(4L, next.getLong("nonce"))
    assertThrows(IllegalStateException::class.java) {
      nativeLiquidityCancellationProposal(op, state().copy(nonce = 5uL), 101)
    }
    assertThrows(IllegalStateException::class.java) {
      nativeLiquidityCancellationProposal(op, state().copy(nativeBalanceWei = "1"), 101)
    }
  }
}
