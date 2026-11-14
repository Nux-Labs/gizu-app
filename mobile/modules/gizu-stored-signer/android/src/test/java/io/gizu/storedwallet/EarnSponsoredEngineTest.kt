package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import uniffi.gizu_stored_signer_core.*

class EarnSponsoredEngineTest {
  @Test
  fun fundsMovedAfterReviewStopSigningWithAnInsufficientFundsResult() = runBlocking {
    val journal = setup()
    val rpc = Rpc()
    var available = "10000000"
    EarnSponsoredEngine(
        store(),
        journal,
        rpc,
        rpc,
        { _, _ -> Signer() },
        { state().copy(tokenBalanceAtoms = available) },
        { null },
      )
      .use { engine ->
        val review = engine.prepare("hood-1", 1)
        available = "1"
        val failure =
          assertThrows(RpcFailure::class.java) { runBlocking { engine.execute(review) {} } }
        assertEquals(RpcFailureCode.INSUFFICIENT_FUNDS, failure.code)
        assertEquals(0, signatures)
        assertEquals(0, rpc.sent)
        assertFalse(journal.get("hood-1").has("signedUserOperation"))
      }
  }

  @Test
  fun privateSnapshotCompletesBeforeFinalSigningStateIsReconstructed() = runBlocking {
    val journal = setup()
    val confidential = "0x" + "2".repeat(40)
    journal.update("hood-1", 1) {
      it.getJSONObject("proposal").put("confidentialAccount", confidential)
    }
    val rpc = Rpc()
    val order = mutableListOf<String>()
    val fake = Signer(onSign = { order.add("sign") })
    val route =
      NativeEarnRouteProof(
        NativeEarnQuoteBinding(
          "hood-1",
          7uL,
          hash,
          4663uL,
          HOOD_EARN_USDG,
          owner,
          "1000000",
          confidential,
          owner,
          (System.currentTimeMillis() / 1000 + 300).toULong(),
          hash,
          null,
        ),
        "990000",
        EARN_MONAD_ASSET,
        "sealed-quote",
        "995000",
      )
    EarnSponsoredEngine(
        store(),
        journal,
        rpc,
        rpc,
        { _, _ -> fake },
        {
          order.add("state")
          state()
        },
        { route },
        baselineReader = { _, _ ->
          order.add("baseline")
          JSONObject()
            .put("confidentialAddress", confidential)
            .put("authenticated", true)
            .put("operationScoped", false)
            .put("baselineEnvelope", "sealed-baseline")
        },
      )
      .use { engine ->
        val review = engine.prepare("hood-1", 2)
        order.clear()
        try {
          engine.execute(review) {}
        } catch (_: IllegalStateException) {}
        assertEquals(listOf("baseline", "state", "sign"), order)
        assertEquals(
          "sealed-baseline",
          journal
            .get("hood-1")
            .getJSONObject("stateBinding")
            .getJSONObject("privateBaseline")
            .getString("baselineEnvelope"),
        )
      }
  }

  @Test
  fun boundedJourneyChecksFreshStateBeforeAnyDurableSigning() = runBlocking {
    val journal = setup()
    val rpc = Rpc()
    val fake = Signer()
    EarnSponsoredEngine(store(), journal, rpc, rpc, { _, _ -> fake }, { state() }, { null }).use {
      engine ->
      val review = engine.prepare("hood-1", 1)
      try {
        engine.executeBounded(review, {}, { error("Approved minimum shares no longer satisfied") })
        fail("Changed live bounds signed")
      } catch (_: IllegalStateException) {}
      assertFalse(journal.get("hood-1").has("signedUserOperation"))
      assertEquals(0, rpc.sent)
    }
  }

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
        earnChain = 4663,
        earnRecoveryRequired = recovery,
      )
      .use { store.create(it) }
    return store
  }

  private fun state() =
    NativeSponsoredState(
      4663uL,
      owner,
      100uL,
      10uL,
      hash,
      "0x" + "b".repeat(64),
      "0x0",
      4uL,
      4uL,
      "10000000",
      "1000",
      "0",
      "1000",
      "0",
      HOOD_EARN_USDG,
      6u,
      "0xef0100" + EARN_IMPLEMENTATION.drop(2),
      "0x",
      "1",
      hash,
      hash,
      hash,
      hash,
      hash,
      hash,
    )

  private fun setup(file: File = File()): EarnSponsoredJournal {
    val j = EarnSponsoredJournal(file, { key }, wallet, wallet)
    val p =
      JSONObject()
        .put("operationId", "hood-1")
        .put("revision", 7)
        .put("kind", "hoodDeposit")
        .put("chainId", 4663)
        .put("profileChainId", 4663)
        .put("expectedFrom", owner)
        .put("token", HOOD_EARN_USDG)
        .put("amountAtoms", "1000000")
        .put("nonce", "0x0")
        .put("deadline", System.currentTimeMillis() / 1000 + 300)
        .put("maximumTokenFeeAtoms", "1000")
        .put("budgetAtoms", "1001000")
        .put("withdrawalReserveAtoms", "1000")
    j.create(
      p,
      JSONObject()
        .put("sender", owner)
        .put("nonce", "0x0")
        .put("signature", "0x")
        .put("callData", "0xcalls")
        .put("paymaster", EARN_PAYMASTER)
        .put("paymasterData", "0xstub")
        .put("maxFeePerGas", "0xa")
        .put("maxPriorityFeePerGas", "0x1"),
    )
    return j
  }

  private class Rpc : TransferRpc {
    var sent = 0
    val payloads = mutableListOf<String>()

    override suspend fun call(method: String, params: JSONArray): Any =
      when (method) {
        "eth_chainId" -> "0x1237"
        "eth_getUserOperationReceipt",
        "eth_getUserOperationByHash" -> JSONObject.NULL
        "pm_getPaymasterData" ->
          JSONObject()
            .put("paymaster", EARN_PAYMASTER)
            .put("paymasterData", "0xfinal")
            .put("paymasterPostOpGasLimit", "0x10")
            .put("paymasterVerificationGasLimit", "0x10")
        "eth_sendUserOperation" -> {
          sent++
          payloads.add(params.getJSONObject(0).toString())
          error("response lost")
        }
        else -> error("Unexpected $method")
      }
  }

  private var signatures = 0

  private inner class Signer(
    private val changed: Boolean = false,
    private val onSign: () -> Unit = {},
  ) : NativeSponsoredSigner {
    private var unsigned = ""

    override fun prepare(
      revision: ULong,
      userOperation: String,
      state: NativeSponsoredState,
      quote: NativeEarnQuoteBinding?,
      authorization: NativeSignedEarnAuthorization?,
    ): String {
      unsigned = userOperation
      return if (changed) "changed review" else "full exact review"
    }

    override fun reviewHash() = if (changed) "0x" + "c".repeat(64) else hash

    override fun approve(revision: ULong, hash: String) {}

    override fun sign(revision: ULong, state: NativeSponsoredState): NativeSignedEarnUserOperation {
      onSign()
      signatures++
      val payload = JSONObject(unsigned).put("signature", "private-signature").toString()
      return NativeSignedEarnUserOperation(
        hash,
        "private-signature",
        payload,
        "hood-1",
        revision,
        hash,
      )
    }

    override fun close() {}
  }

  @Test
  fun failedCommitNeverSubmitsSponsoredPayload() = runBlocking {
    val file = File()
    val j = setup(file)
    val rpc = Rpc()
    EarnSponsoredEngine(store(), j, rpc, rpc, { _, _ -> Signer() }, { state() }, { null }).use {
      engine ->
      val review = engine.prepare("hood-1", 1)
      file.fail = true
      try {
        engine.execute(review) {}
        fail("Persistence must fail")
      } catch (_: IllegalStateException) {}
    }
    assertEquals(0, rpc.sent)
    assertFalse(j.get("hood-1").has("signedUserOperation"))
    assertEquals(true, j.public(j.get("hood-1"))["canCancelPreparation"])
    file.fail = false
    j.cancel("hood-1", 1)
    Unit
  }

  @Test
  fun postPasskeyReconstructionCannotSilentlyChangeReview() = runBlocking {
    val j = setup()
    val rpc = Rpc()
    var constructed = 0
    EarnSponsoredEngine(
        store(),
        j,
        rpc,
        rpc,
        { _, _ -> Signer(++constructed >= 3) },
        { state() },
        { null },
      )
      .use { engine ->
        val review = engine.prepare("hood-1", 1)
        try {
          engine.execute(review) {}
          fail("Changed review must fail")
        } catch (_: IllegalStateException) {}
      }
    assertEquals(0, signatures)
    assertEquals(0, rpc.sent)
    assertFalse(j.get("hood-1").has("signedUserOperation"))
  }

  @Test
  fun lostSubmissionStaysEncryptedAndNeverSignsAgainOnSavedRetry() = runBlocking {
    val file = File()
    val j = setup(file)
    val rpc = Rpc()
    EarnSponsoredEngine(store(), j, rpc, rpc, { _, _ -> Signer() }, { state() }, { null }).use {
      engine ->
      val review = engine.prepare("hood-1", 1)
      try {
        engine.execute(review) {}
        fail("Send must fail")
      } catch (_: IllegalStateException) {}
    }
    assertEquals(1, signatures)
    assertEquals(1, rpc.sent)
    assertEquals("unknown", j.get("hood-1").getString("status"))
    assertTrue(j.get("hood-1").sponsoredBlocked())
    assertFalse(String(file.bytes!!).contains("private-signature"))
    assertFalse(j.public(j.get("hood-1")).toString().contains("private-signature"))
    EarnSponsoredEngine(
        store(),
        j,
        rpc,
        rpc,
        { _, _ -> error("Saved retry must not load signer") },
        { state() },
        { null },
      )
      .use { engine ->
        val review = engine.prepare("hood-1", j.get("hood-1").getInt("revision"))
        assertEquals("retry", review.kind)
        try {
          engine.execute(review) { error("Missing fresh native approval") }
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
    assertEquals(rpc.payloads[0], rpc.payloads[1])
  }

  @Test
  fun expiredUnsentExitReleasesItsBlockAndKeepsTheSignature() = runBlocking {
    val now = System.currentTimeMillis() / 1000
    val journal = signedExit(1)
    val rpc = Rpc()
    assertEquals(true, journal.public(journal.get("hood-1"))["signatureExpired"])
    retireExpiredUnsentExits(journal, rpc, { state() }, replacement(), now)
    val retired = journal.get("hood-1")
    assertEquals("expired", retired.getString("status"))
    assertTrue(retired.getString("signedUserOperation").contains("private-signature"))
    assertFalse(retired.sponsoredBlocked())
    val view = journal.public(retired)
    assertEquals("expired", view["status"])
    assertEquals(false, view["blocked"])
    assertEquals(false, view["canResume"])
    assertFalse(view.toString().contains("private-signature"))
    journal.create(
      JSONObject(retired.getJSONObject("proposal").toString())
        .put("operationId", "hood-2")
        .put("deadline", now + 300),
      JSONObject().put("sender", owner).put("nonce", "0x0").put("signature", "0x"),
    )
    assertEquals("planned", journal.get("hood-2").getString("status"))
    assertEquals(0, rpc.sent)
  }

  @Test
  fun replacementRefusesAValidSignatureAKnownOperationOrAChangedNonce() = runBlocking {
    val now = System.currentTimeMillis() / 1000
    val valid = signedExit(now + 300)
    assertFalse(valid.public(valid.get("hood-1")).containsKey("signatureExpired"))
    assertThrows(IllegalStateException::class.java) {
      runBlocking { retireExpiredUnsentExits(valid, Rpc(), { state() }, replacement(), now) }
    }
    assertEquals("signed", valid.get("hood-1").getString("status"))
    val known = signedExit(1)
    val reported =
      object : TransferRpc {
        override suspend fun call(method: String, params: JSONArray): Any =
          if (method == "eth_getUserOperationByHash") JSONObject().put("userOperation", "present")
          else Rpc().call(method, params)
      }
    assertThrows(IllegalStateException::class.java) {
      runBlocking { retireExpiredUnsentExits(known, reported, { state() }, replacement(), now) }
    }
    assertEquals("signed", known.get("hood-1").getString("status"))
    val moved = signedExit(1)
    assertThrows(IllegalStateException::class.java) {
      runBlocking {
        retireExpiredUnsentExits(
          moved,
          Rpc(),
          { state().copy(entryPointNonce = "0x1") },
          replacement(),
          now,
        )
      }
    }
    assertEquals("signed", moved.get("hood-1").getString("status"))
    assertTrue(moved.get("hood-1").sponsoredBlocked())
  }

  @Test
  fun providerFailureAndOtherActionsLeaveTheExpiredSignatureSendable() = runBlocking {
    val now = System.currentTimeMillis() / 1000
    val unavailable = signedExit(1)
    val failing =
      object : TransferRpc {
        override suspend fun call(method: String, params: JSONArray): Any = error("rpc down")
      }
    assertThrows(IllegalStateException::class.java) {
      runBlocking {
        retireExpiredUnsentExits(unavailable, failing, { state() }, replacement(), now)
      }
    }
    assertEquals("signed", unavailable.get("hood-1").getString("status"))
    val deposit = signedExit(1)
    retireExpiredUnsentExits(
      deposit,
      Rpc(),
      { error("A deposit must not read the exit") },
      replacement().put("kind", "hoodDeposit"),
      now,
    )
    assertEquals("signed", deposit.get("hood-1").getString("status"))
    assertTrue(deposit.get("hood-1").has("signedUserOperation"))
  }

  @Test
  fun settledRedeemReleasesOnlyAnExpiredUnsentRedeemBeforeTheReturn() = runBlocking {
    val now = System.currentTimeMillis() / 1000
    val open = signedExit(1)
    val rpc = Rpc()
    val incoming =
      JSONObject()
        .put("kind", "hoodTokenReturn")
        .put("expectedFrom", owner)
        .put("operationId", "return-1")
    retireSettledRedeemBeforeReturn(open, rpc, { state() }, incoming, now)
    assertEquals("signed", open.get("hood-1").getString("status"))
    val journal = signedExit(1)
    journal.update("hood-1", 4) { it.put("status", "finalized").put("redeemedUsdgAtoms", "900") }
    val prior =
      JSONObject(journal.get("hood-1").getJSONObject("proposal").toString())
        .put("operationId", "hood-2")
        .put("deadline", 1)
    journal.create(
      prior,
      JSONObject().put("sender", owner).put("nonce", "0x0").put("signature", "0x"),
    )
    journal.saveSigned(
      "hood-2",
      1,
      hash,
      "{\"signature\":\"private-signature\"}",
      "review",
      hash,
      JSONObject().put("transactionNonce", "4"),
    )
    journal.update("hood-2", 2) { it.put("status", "signed").put("conflict", false) }
    retireSettledRedeemBeforeReturn(journal, rpc, { state() }, incoming, now)
    assertEquals("expired", journal.get("hood-2").getString("status"))
    assertEquals("finalized", journal.get("hood-1").getString("status"))
    assertTrue(journal.get("hood-2").getString("signedUserOperation").contains("private-signature"))
  }

  private fun replacement() =
    JSONObject()
      .put("kind", "hoodRedeemAll")
      .put("expectedFrom", owner)
      .put("operationId", "hood-2")

  private fun signedExit(deadline: Long): EarnSponsoredJournal {
    val journal = setup()
    journal.update("hood-1", 1) {
      it.getJSONObject("proposal").put("kind", "hoodRedeemAll").put("deadline", deadline)
    }
    journal.saveSigned(
      "hood-1",
      2,
      hash,
      "{\"signature\":\"private-signature\"}",
      "review",
      hash,
      JSONObject().put("transactionNonce", "4"),
    )
    journal.update("hood-1", 3) { it.put("status", "signed").put("conflict", false) }
    return journal
  }

  @Test
  fun restoredProfileCannotLoadSignerOrPrepareUserOp() = runBlocking {
    val j = setup()
    val rpc = Rpc()
    EarnSponsoredEngine(
        store(true),
        j,
        rpc,
        rpc,
        { _, _ -> error("Recovery must not reach signer") },
        { state() },
        { null },
      )
      .use { engine ->
        try {
          engine.prepare("hood-1", 1)
          fail("Recovery must fail")
        } catch (_: IllegalStateException) {}
      }
    assertEquals(0, signatures)
    assertEquals(0, rpc.sent)
  }

  @Test
  fun savedVaultV2RedemptionRetryUsesExactSharesInsteadOfZeroMaxRedeemView() {
    val p =
      setup()
        .get("hood-1")
        .getJSONObject("proposal")
        .put("kind", "hoodRedeemAll")
        .put("amountAtoms", "2000000")
    val current = state().copy(shares = "2000000", maxRedeemShares = "0")
    val signed = JSONObject().put("maxFeePerGas", "0xa").put("maxPriorityFeePerGas", "0x1")
    val op =
      JSONObject()
        .put("proposal", p)
        .put("signedUserOperation", signed.toString())
        .put("stateBinding", sponsoredStateBinding(current))
    checkSponsoredRetry(op, current)
    assertThrows(IllegalStateException::class.java) {
      checkSponsoredRetry(op, current.copy(shares = "1999999"))
    }
    assertEquals(
      RpcFailureCode.INSUFFICIENT_FUNDS,
      assertThrows(RpcFailure::class.java) {
          checkSponsoredRetry(op, current.copy(tokenBalanceAtoms = "1"))
        }
        .code,
    )
  }

  @Test
  fun savedRetryRejectsExpiredDeadlineHigherGasAndUnfundedReserve() {
    val p = setup().get("hood-1").getJSONObject("proposal")
    val signed = JSONObject().put("maxFeePerGas", "0xa").put("maxPriorityFeePerGas", "0x1")
    val op =
      JSONObject()
        .put("proposal", p)
        .put("signedUserOperation", signed.toString())
        .put("stateBinding", sponsoredStateBinding(state()))
    checkSponsoredRetry(
      op,
      state().copy(tokenBalanceAtoms = "11000000"),
    ) // An unrelated donation cannot make saved bytes unsafe.
    assertThrows(IllegalStateException::class.java) {
      checkSponsoredRetry(op, state().copy(baseFeeWei = "10"))
    }
    assertEquals(
      RpcFailureCode.INSUFFICIENT_FUNDS,
      assertThrows(RpcFailure::class.java) {
          checkSponsoredRetry(op, state().copy(tokenBalanceAtoms = "1001000"))
        }
        .code,
    )
    p.put("deadline", System.currentTimeMillis() / 1000)
    assertThrows(IllegalStateException::class.java) { checkSponsoredRetry(op, state()) }
  }

  @Test
  fun cancellationDuringSpendSigningIsRejectedAcrossJournalInstances() = runBlocking {
    val file = File()
    val j = setup(file)
    val other = EarnSponsoredJournal(file, { key }, wallet, wallet)
    val rpc = Rpc()
    EarnSponsoredEngine(
        store(),
        j,
        rpc,
        rpc,
        { _, _ ->
          Signer(
            onSign = {
              assertEquals(false, other.public(other.get("hood-1"))["canCancelPreparation"])
              assertThrows(IllegalStateException::class.java) { other.cancel("hood-1", 1) }
            }
          )
        },
        { state() },
        { null },
      )
      .use { engine ->
        val review = engine.prepare("hood-1", 1)
        try {
          engine.execute(review) {}
          fail("Lost submission")
        } catch (_: IllegalStateException) {}
      }
    assertEquals(1, signatures)
    assertTrue(j.get("hood-1").has("signedUserOperation"))
    assertEquals(false, j.public(j.get("hood-1"))["canCancelPreparation"])
  }

  @Test
  fun discardingPreparedReviewPreventsSigningAndBroadcastWithoutAnotherApproval() = runBlocking {
    val j = setup()
    val rpc = Rpc()
    EarnSponsoredEngine(store(), j, rpc, rpc, { _, _ -> Signer() }, { state() }, { null }).use {
      engine ->
      val review = engine.prepare("hood-1", 1)
      j.cancel("hood-1", 1)
      try {
        engine.execute(review) {}
        fail("Discarded review")
      } catch (_: IllegalStateException) {}
    }
    assertEquals(0, signatures)
    assertEquals(0, rpc.sent)
    assertEquals(false, j.public(j.get("hood-1"))["canResume"])
  }
}
