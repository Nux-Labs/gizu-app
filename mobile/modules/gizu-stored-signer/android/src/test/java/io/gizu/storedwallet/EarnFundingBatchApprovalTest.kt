package io.gizu.storedwallet

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnFundingBatchApprovalTest {
  @Test
  fun sameAccountOneOnTwoNetworksIsOneReviewedFundingBatch() {
    val rows =
      listOf(143, 8453).map { chain ->
        row(1).also {
          it.put("operationId", "source_$chain")
          it
            .getJSONObject("proposal")
            .put("operationId", "source_$chain")
            .put("chainId", chain)
            .put("token", fundingNetwork(chain).token)
        }
      }
    val ledger = ledger(rows)
    ledger.getJSONArray("legs").getJSONObject(0).put("sourceChainId", 143)
    ledger
      .getJSONArray("legs")
      .getJSONObject(1)
      .put("sourceChainId", 8453)
      .put("token", fundingNetwork(8453).token)
    val grant = approval(rows, ledger)
    grant.approveAfterPasskey(1000)
    record().use { wallet -> rows.forEach { grant.assertAuthorized(wallet, it, 1001) } }
    val switched = JSONObject(rows[1].toString())
    switched.getJSONObject("proposal").put("chainId", 42161)
    try {
      record().use { grant.assertAuthorized(it, switched, 1002) }
      fail("Reviewed Base authority must not authorize an Arbitrum operation")
    } catch (_: IllegalStateException) {}
  }

  private val wallet = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12"
  private val registry = "{\"version\":1,\"nextRecipient\":5}"

  private fun row(index: Int) =
    JSONObject()
      .put("walletId", wallet)
      .put("operationId", "source$index")
      .put("revision", 1)
      .put("status", "planned")
      .put("cancelled", false)
      .put(
        "proposal",
        JSONObject()
          .put("kind", "sourceFunding")
          .put("operationId", "source$index")
          .put("revision", 7)
          .put("chainId", 143)
          .put("profileChainId", 1)
          .put("cycleIndex", 2)
          .put("fundingBatchId", "batch1")
          .put("fundingBatchSize", 2)
          .put("sourceAccountIndex", index)
          .put("expectedFrom", "0x" + (index + 1).toString().repeat(40))
          .put("nonce", "0x0")
          .put("budgetAtoms", "1000000")
          .put("amountAtoms", "989900")
          .put("maximumTokenFeeAtoms", "100")
          .put("withdrawalReserveAtoms", "10000")
          .put("confidentialAccount", "0x" + "a".repeat(40))
          .put("refundOwner", "0x" + (index + 1).toString().repeat(40))
          .put("quoteId", "0x" + "b".repeat(64)),
      )
      .put(
        "unsignedUserOperation",
        JSONObject()
          .put("sender", "0x" + (index + 1).toString().repeat(40))
          .put("nonce", "0x0")
          .put("callData", "0x1234")
          .put("maxFeePerGas", "0x10")
          .put("maxPriorityFeePerGas", "0x1")
          .put("callGasLimit", "0x10")
          .put("verificationGasLimit", "0x10")
          .put("preVerificationGas", "0x10")
          .put("paymasterData", "0xab")
          .put("signature", "0x"),
      )

  private fun rows() = listOf(row(0), row(1))

  private fun ledger(rows: List<JSONObject>) =
    JSONObject()
      .put("id", "batch1")
      .put("feature", "earn")
      .put("cycleIndex", 2)
      .put("registrationComplete", true)
      .put(
        "legs",
        JSONArray(
          rows.map { r ->
            val p = r.getJSONObject("proposal")
            JSONObject()
              .put("sourceIndex", p.getInt("sourceAccountIndex"))
              .put("address", p.getString("expectedFrom"))
              .put("budgetAtoms", p.getString("budgetAtoms"))
              .put("operationId", r.getString("operationId"))
          }
        ),
      )

  private fun approval(rows: List<JSONObject> = rows(), ledger: JSONObject = ledger(rows)) =
    EarnFundingBatchApproval.createManifest(rows, wallet, wallet, 2, "batch1", registry, ledger)

  private fun record(generation: String = wallet, cycle: Int = 2, roles: String = registry) =
    WalletRecord(
      wallet,
      StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
      ByteArray(32),
      true,
      generation,
      roles,
      1,
      false,
      cycle,
    )

  @Test
  fun canonicalManifestIgnoresJsonKeyOrderAndJournalRevisionButBindsBothSources() {
    val rows = rows()
    val a = approval(rows)
    val changed =
      rows.reversed().map { r ->
        val clone = JSONObject(r.toString()).put("revision", 99).put("status", "authorizationSaved")
        val p = clone.getJSONObject("proposal")
        val reordered = JSONObject()
        p.keys().asSequence().toList().reversed().forEach { reordered.put(it, p.get(it)) }
        clone.put("proposal", reordered)
      }
    assertEquals(a.digest, approval(changed).digest)
    assertEquals(
      listOf("source0", "source1"),
      JSONObject(a.manifestJson).getJSONArray("children").let {
        (0 until it.length()).map { n -> it.getJSONObject(n).getString("operationId") }
      },
    )
    a.approveAfterPasskey(1000)
    record().use { r -> for (row in changed) a.assertAuthorized(r, row, 1001) }
  }

  @Test
  fun oneGrantExpiresCannotRenewAndNeverSurvivesReconstruction() {
    val a = approval()
    record().use { r ->
      assertThrows(IllegalStateException::class.java) { a.assertAuthorized(r, row(0), 1000) }
      a.approveAfterPasskey(1000)
      a.assertAuthorized(r, row(1), 181000)
      a.assertAuthorized(r, row(0), 900999)
      assertThrows(IllegalStateException::class.java) { a.assertAuthorized(r, row(0), 901000) }
      assertThrows(IllegalStateException::class.java) { a.approveAfterPasskey(901000) }
      assertThrows(IllegalStateException::class.java) {
        approval().assertAuthorized(r, row(0), 1001)
      }
    }
  }

  @Test
  fun proposalCapsQuoteDestinationRefundAndOriginalUserOperationCannotChange() {
    val a = approval()
    a.approveAfterPasskey(1000)
    record().use { r ->
      for (field in
        listOf(
          "amountAtoms",
          "budgetAtoms",
          "maximumTokenFeeAtoms",
          "withdrawalReserveAtoms",
          "expectedFrom",
          "confidentialAccount",
          "refundOwner",
          "quoteId",
        )) {
        val row = row(0)
        row.getJSONObject("proposal").put(field, "changed")
        assertThrows(IllegalStateException::class.java) { a.assertAuthorized(r, row, 1001) }
      }
      val row = row(0)
      row.getJSONObject("unsignedUserOperation").put("callData", "0x9999")
      assertThrows(IllegalStateException::class.java) { a.assertAuthorized(r, row, 1001) }
      assertThrows(IllegalStateException::class.java) { a.assertAuthorized(r, row(3), 1001) }
    }
  }

  @Test
  fun generationCycleRegistryCancellationClockAndInvalidationStopGrant() {
    val a = approval()
    a.approveAfterPasskey(1000)
    for (r in
      listOf(
        record("27cfcc2e-0891-4e31-a7d4-03780d7b4f12"),
        record(cycle = 3),
        record(roles = "{\"version\":1,\"nextRecipient\":6}"),
      )) {
      r.use {
        assertThrows(IllegalStateException::class.java) { a.assertAuthorized(it, row(0), 1001) }
      }
    }
    record().use { r ->
      assertThrows(IllegalStateException::class.java) {
        a.assertAuthorized(r, row(0).put("cancelled", true), 1001)
      }
      assertThrows(IllegalStateException::class.java) { a.assertAuthorized(r, row(0), 999) }
      a.invalidate()
      assertThrows(IllegalStateException::class.java) { a.assertAuthorized(r, row(0), 1001) }
    }
  }

  @Test
  fun onlyCompleteCommittedMatchingLedgerMayBecomeManifest() {
    val rows = rows()
    for (variant in 0..3) {
      val b = ledger(rows)
      when (variant) {
        0 -> b.put("registrationComplete", false)
        1 -> b.getJSONArray("legs").remove(1)
        2 -> b.getJSONArray("legs").getJSONObject(0).put("budgetAtoms", "1")
        3 -> b.getJSONArray("legs").getJSONObject(0).put("address", "other")
      }
      assertThrows(IllegalStateException::class.java) { approval(rows, b) }
    }
    assertThrows(IllegalStateException::class.java) { approval(listOf(row(0), row(0))) }
    assertThrows(IllegalStateException::class.java) { approval(listOf(row(0), row(2))) }
  }

  @Test
  fun completedAndUnknownChildrenStayInManifestWithoutNewAuthorityAndRetryBytesStayFixed() {
    val rows = rows()
    rows[0].put("status", "finalized").put("signedUserOperation", "old signed bytes")
    rows[1].put("status", "unknown").put("signedUserOperation", "uncertain bytes")
    val a = approval(rows)
    assertEquals(2, JSONObject(a.manifestJson).getJSONArray("children").length())
    a.approveAfterPasskey(1000)
    record().use { r ->
      rows.forEach {
        assertThrows(IllegalStateException::class.java) { a.assertAuthorized(r, it, 1001) }
      }
    }
    rows[1].put("status", "signed")
    val retry = approval(rows)
    retry.approveAfterPasskey(1000)
    record().use { r ->
      retry.assertAuthorized(r, rows[1], 1001)
      rows[1].put("signedUserOperation", "changed signed bytes")
      assertThrows(IllegalStateException::class.java) { retry.assertAuthorized(r, rows[1], 1002) }
    }
  }

  @Test
  fun newDelegationAndSpendingBytesAreFrozenAfterEachNativeSave() {
    val a = approval()
    a.approveAfterPasskey(1000)
    val row = row(0)
    record().use { r ->
      a.assertAuthorized(r, row, 1001)
      row
        .put(
          "authorization",
          JSONObject().put("address", "native fixed implementation").put("nonce", 7),
        )
        .put("status", "authorizationSaved")
        .put("revision", 2)
      a.assertAuthorized(r, row, 1002)
      val authorization = JSONObject(row.getJSONObject("authorization").toString())
      row.getJSONObject("authorization").put("address", "other")
      assertThrows(IllegalStateException::class.java) { a.assertAuthorized(r, row, 1003) }
      row
        .put("authorization", authorization)
        .put("signedUserOperation", "exact native signed bytes")
        .put("status", "unknown")
        .put("revision", 3)
      a.assertAuthorized(r, row, 1004)
      row.put("signedUserOperation", "other signed bytes")
      assertThrows(IllegalStateException::class.java) { a.assertAuthorized(r, row, 1005) }
    }
  }

  @Test
  fun malformedNonceGasCapsOrBudgetCannotBeApproved() {
    for (variant in 0..2) {
      val rows = rows()
      when (variant) {
        0 -> rows[0].getJSONObject("unsignedUserOperation").put("nonce", "0x1")
        1 -> rows[0].getJSONObject("unsignedUserOperation").put("maxPriorityFeePerGas", "0x11")
        2 -> rows[0].getJSONObject("proposal").put("amountAtoms", "1000000")
      }
      assertThrows(IllegalStateException::class.java) { approval(rows) }
    }
  }
}
