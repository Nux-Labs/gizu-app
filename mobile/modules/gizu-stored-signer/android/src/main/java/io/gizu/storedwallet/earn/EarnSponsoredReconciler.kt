package io.gizu.storedwallet

import org.json.JSONArray
import org.json.JSONObject

private fun sponsoredLogs(receipt: JSONObject): List<JSONObject> =
  receipt.getJSONArray("logs").let { rows ->
    check(rows.length() <= 4096)
    (0 until rows.length()).map(rows::getJSONObject)
  }

private fun sponsoredLogWords(log: JSONObject, count: Int): List<java.math.BigInteger> {
  val data = log.getString("data")
  check(Regex("0x[0-9a-fA-F]{${64 * count}}").matches(data))
  return (0 until count).map { data.substring(2 + 64 * it, 2 + 64 * (it + 1)).toBigInteger(16) }
}

private fun sponsoredLogAddress(log: JSONObject, index: Int, address: String) =
  log.getJSONArray("topics").getString(index).equals("0x" + earnAddressWord(address), true)

// Signed records store "0x00" yParity; bundlers return "0x0" or JSON numbers for the same value.
private fun authorizationQuantity(value: Any): java.math.BigInteger =
  when (value) {
    is Int,
    is Long -> {
      check((value as Number).toLong() >= 0)
      java.math.BigInteger.valueOf(value.toLong())
    }
    is String -> {
      check(Regex("0x[0-9a-fA-F]{1,64}").matches(value))
      value.drop(2).toBigInteger(16)
    }
    else -> error("Invalid authorization quantity")
  }

internal fun requireSameSignedUserOp(saved: JSONObject, received: JSONObject) {
  for (field in saved.keys().asSequence()) {
    if (field == "eip7702Auth" && !received.has(field))
      continue // Standard ByHash omits bundled authorization; receipt verifies its canonical
    // effects.
    check(received.has(field))
    if (field == "eip7702Auth") {
      val a = saved.getJSONObject(field)
      val b = received.getJSONObject(field)
      for (key in a.keys().asSequence()) check(
        if (key in setOf("chainId", "nonce", "yParity"))
          authorizationQuantity(a.get(key)) == authorizationQuantity(b.get(key))
        else a.getString(key).equals(b.getString(key), true)
      )
    } else
      check(saved.getString(field).equals(received.getString(field), true)) {
        "Bundler operation differs from signed record"
      }
  }
}

/**
 * Native chain receipt, exact UserOp and finalized EntryPoint event must agree before releasing
 * nonce.
 */
internal suspend fun reconcileEarnSponsoredOperations(
  journal: EarnSponsoredJournal,
  chainRpc: TransferRpc,
  bundler: TransferRpc,
  topic: (String) -> String = ::earnEventTopic,
  stateReader: suspend (JSONObject) -> uniffi.gizu_stored_signer_core.NativeSponsoredState =
    EarnSponsoredStateLoader(chainRpc)::load,
  chainFilter: Int? = null,
  operationIds: Set<String>? = null,
) {
  closeCompetingRequestedWithdrawals(journal)
  val rows = journal.all()
  val completedReturns =
    rows.withIndex().filter { (_, op) ->
      op.optString("status") == "finalized" &&
        op.getJSONObject("proposal").optString("kind") == "hoodTokenReturn" &&
        (completedReturnLifecycle(op, journal.walletId, journal.generation) ||
          refundedSponsoredReturn(op, journal.walletId, journal.generation))
    }
  for ((index, op) in rows.withIndex()) {
    if (operationIds != null && op.getString("operationId") !in operationIds) continue
    // A later read must not turn a replaced expired signature back into a sendable one.
    if (op.optString("status") == "nonceCancelled") continue
    val retired = op.optString("status") == "expired"
    if (retired && !requestedWithdrawal(op.getJSONObject("proposal"))) continue
    if (
      !op.has("signedUserOperation") ||
        chainFilter != null && op.getJSONObject("proposal").getInt("chainId") != chainFilter
    )
      continue
    val p = op.getJSONObject("proposal")
    // A terminal route checkpoints its confirmed origin/predecessors. A refund is not private
    // credit.
    // Later lookups and later investment balances cannot reopen those steps.
    if (
      op.optString("status") == "finalized" &&
        p.optString("kind") in setOf("hoodDeposit", "hoodRedeemAll", "hoodTokenReturn") &&
        completedReturns.any { (end, returned) ->
          val q = returned.getJSONObject("proposal")
          end >= index &&
            p.getInt("chainId") == q.getInt("chainId") &&
            p.optInt("cycleIndex", 0) == q.optInt("cycleIndex", 0) &&
            p.has("investmentSlot") == q.has("investmentSlot") &&
            p.optInt("investmentSlot", -1) == q.optInt("investmentSlot", -1) &&
            p.getString("expectedFrom").equals(q.getString("expectedFrom"), true)
        }
    )
      continue
    check(quantity(chainRpc.text("eth_chainId")) == p.getLong("chainId").toBigInteger())
    val hash = op.getString("userOperationHash")
    val saved = JSONObject(op.getString("signedUserOperation"))
    val before = op.toString()
    val reported = bundler.call("eth_getUserOperationReceipt", JSONArray().put(hash))
    val known = bundler.call("eth_getUserOperationByHash", JSONArray().put(hash))
    // Expired bytes may only recover a canonical receipt, never become sendable again.
    if (retired && (reported !is JSONObject || known !is JSONObject)) continue
    op.put("conflict", false)
    if (known is JSONObject) {
      check(known.getString("entryPoint").equals(EARN_ENTRY_POINT, true))
      requireSameSignedUserOp(saved, known.getJSONObject("userOperation"))
    } else check(known === JSONObject.NULL)
    if (reported is JSONObject) {
      check(
        reported.getString("userOpHash").equals(hash, true) &&
          reported.getString("sender").equals(p.getString("expectedFrom"), true)
      )
      check(
        quantity(reported.getString("nonce")) == quantity(p.getString("nonce")) &&
          reported.getString("entryPoint").equals(EARN_ENTRY_POINT, true)
      )
      val reportedReceipt = reported.getJSONObject("receipt")
      val txHash = earnHash(reportedReceipt.getString("transactionHash"))
      if (known === JSONObject.NULL) {
        // Receipt and operation indexes may become available at different times. Keep the
        // nonce reserved until the exact signed UserOp and canonical receipt can be verified.
        if (op.getString("status") != "pending")
          journal.update(op.getString("operationId"), op.getInt("revision")) {
            it.put("status", "pending")
          }
        continue
      }
      val receipt =
        chainRpc.call("eth_getTransactionReceipt", JSONArray().put(txHash)) as JSONObject
      check(
        earnHash(receipt.getString("transactionHash")) == txHash &&
          receipt.getString("status") == "0x1"
      )
      val number = receipt.getString("blockNumber")
      val blockHash = earnHash(receipt.getString("blockHash"))
      check(
        reportedReceipt.getString("blockHash").equals(blockHash, true) &&
          reportedReceipt.getString("blockNumber") == number
      )
      val canonical =
        chainRpc.call("eth_getBlockByNumber", JSONArray().put(number).put(false)) as JSONObject
      // Robinhood execution uses a canonical receipt, like Swap. L1 finality can trail by ~17
      // minutes. This only proves execution: a return still needs authenticated private credit.
      // Keep the receipt, signed UserOp, event, fee and second canonical-block checks below.
      val awaitFinality = p.getLong("chainId") != 4663L
      val final =
        if (awaitFinality)
          chainRpc.call("eth_getBlockByNumber", JSONArray().put("finalized").put(false))
            as JSONObject
        else null
      if (
        earnHash(canonical.getString("hash")) != blockHash ||
          final != null && quantity(final.getString("number")) < quantity(number)
      )
        op.put("status", "pending")
      else {
        val logs = sponsoredLogs(receipt)
        val owner = p.getString("expectedFrom")
        val event =
          logs.single { log ->
            val topics = log.getJSONArray("topics")
            log.getString("address").equals(EARN_ENTRY_POINT, true) &&
              topics.length() == 4 &&
              topics
                .getString(0)
                .equals(
                  topic("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)"),
                  true,
                ) &&
              topics.getString(1).equals(hash, true) &&
              sponsoredLogAddress(log, 2, owner) &&
              sponsoredLogAddress(log, 3, EARN_PAYMASTER)
          }
        val words = sponsoredLogWords(event, 4)
        check(
          words[0] == quantity(p.getString("nonce")) &&
            words[1] in setOf(java.math.BigInteger.ZERO, java.math.BigInteger.ONE)
        )
        val succeeded = words[1] == java.math.BigInteger.ONE
        check(reported.getBoolean("success") == succeeded)
        check(
          quantity(reported.getString("actualGasCost")) == words[2] &&
            quantity(reported.getString("actualGasUsed")) == words[3]
        )
        // A single operation per protected owner prevents ambiguous fees in a multi-UserOp bundle.
        check(
          logs.count { log ->
            val topics = log.getJSONArray("topics")
            log.getString("address").equals(EARN_ENTRY_POINT, true) &&
              topics.length() == 4 &&
              topics
                .getString(0)
                .equals(
                  topic("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)"),
                  true,
                ) &&
              sponsoredLogAddress(log, 2, owner)
          } == 1
        )
        if (succeeded) requireSponsoredReceiptSemantics(op, logs, topic)
        val token = p.getString("token")
        val transferTopic = topic("Transfer(address,address,uint256)")
        val tokenTransfers =
          logs.filter {
            it.getString("address").equals(token, true) &&
              it.getJSONArray("topics").length() == 3 &&
              it.getJSONArray("topics").getString(0).equals(transferTopic, true)
          }
        val charged =
          tokenTransfers
            .filter {
              sponsoredLogAddress(it, 1, owner) && sponsoredLogAddress(it, 2, EARN_PAYMASTER)
            }
            .fold(java.math.BigInteger.ZERO) { total, log ->
              total + sponsoredLogWords(log, 1).single()
            }
        val refunded =
          tokenTransfers
            .filter {
              sponsoredLogAddress(it, 1, EARN_PAYMASTER) && sponsoredLogAddress(it, 2, owner)
            }
            .fold(java.math.BigInteger.ZERO) { total, log ->
              total + sponsoredLogWords(log, 1).single()
            }
        val paid = charged - refunded
        check(paid.signum() >= 0 && paid <= p.getString("maximumTokenFeeAtoms").toBigInteger())
        op.put("actualTokenFeeAtoms", paid.toString()).put("transactionHash", txHash)
        // Robinhood's public RPC serves no historical state, so post-receipt reads use the latest
        // block there. These values change only through a later operation signed by this owner.
        val stateBlock: Any =
          if (p.getLong("chainId") == 4663L) "latest" else earnPinnedBlock(blockHash)
        if (p.getLong("chainId") == 4663L && succeeded) {
          val observed =
            chainRpc.call(
              "eth_call",
              JSONArray()
                .put(
                  JSONObject()
                    .put("to", HOOD_EARN_VAULT)
                    .put("data", "0x70a08231${earnAddressWord(owner)}")
                )
                .put(stateBlock),
            ) as String
          val shares = earnAbiWord(observed)
          if (p.getString("kind") == "hoodRedeemAll") {
            op.put("residualShares", shares.toString())
            if (p.has("requestedWithdrawalAtoms"))
              check(withdrawnRequestedPortion(JSONObject(op.toString()).put("status", "finalized")))
          }
          if (p.getString("kind") == "hoodDeposit")
            check(
              shares >=
                op.getJSONObject("stateBinding").getString("shares").toBigInteger() +
                  op.getString("settledShares").toBigInteger()
            )
        }
        if (op.has("authorization")) {
          val code = chainRpc.call("eth_getCode", JSONArray().put(owner).put(stateBlock)) as String
          check(code.equals("0xef0100" + EARN_IMPLEMENTATION.drop(2), true))
          val nonce =
            chainRpc.call("eth_getTransactionCount", JSONArray().put(owner).put(stateBlock))
              as String
          check(quantity(nonce) > op.getJSONObject("authorization").getLong("nonce").toBigInteger())
        }
        val checked =
          chainRpc.call("eth_getBlockByNumber", JSONArray().put(number).put(false)) as JSONObject
        op.put(
          "status",
          if (earnHash(checked.getString("hash")) == blockHash) {
            if (succeeded) "finalized" else "reverted"
          } else "pending",
        )
      }
    } else {
      check(reported === JSONObject.NULL)
      if (known is JSONObject) op.put("status", "pending")
      else {
        val state = stateReader(p)
        val binding = op.getJSONObject("stateBinding")
        val conflict =
          quantity(state.entryPointNonce) != quantity(p.getString("nonce")) ||
            state.transactionNonce.toString() != binding.getString("transactionNonce")
        op
          .put("conflict", conflict)
          .put(
            "status",
            if (conflict) "unknown"
            else if (op.getString("status") == "pending") "pending" else "signed",
          )
      }
    }
    if (retired && op.optString("status") !in terminalSteps) continue
    if (before != op.toString())
      journal.update(op.getString("operationId"), op.getInt("revision")) { target ->
        for (field in
          listOf(
            "status",
            "conflict",
            "actualTokenFeeAtoms",
            "transactionHash",
            "settledShares",
            "residualShares",
            "redeemedUsdgAtoms",
          )) if (op.has(field)) target.put(field, op.get(field))
      }
  }
  closeCompetingRequestedWithdrawals(journal)
}

internal fun requireSponsoredReceiptSemantics(
  op: JSONObject,
  logs: List<JSONObject>,
  topic: (String) -> String = ::earnEventTopic,
) {
  val p = op.getJSONObject("proposal")
  val owner = p.getString("expectedFrom")
  val token = p.getString("token")
  val amount = p.getString("amountAtoms").toBigInteger()
  fun match(address: String, signature: String) =
    logs.filter { log ->
      log.getString("address").equals(address, true) &&
        log.getJSONArray("topics").getString(0).equals(topic(signature), true)
    }
  fun transfer(from: String, to: String, amount: java.math.BigInteger, asset: String = token) {
    val log =
      match(asset, "Transfer(address,address,uint256)").single {
        it.getJSONArray("topics").length() == 3 &&
          sponsoredLogAddress(it, 1, from) &&
          sponsoredLogAddress(it, 2, to)
      }
    check(sponsoredLogWords(log, 1).single() == amount)
  }
  when (p.getString("kind")) {
    "sourceFunding",
    "hoodTokenReturn" -> transfer(owner, p.getString("recipient"), amount)
    "hoodDeposit" -> {
      transfer(owner, HOOD_EARN_ROUTER, amount)
      val event =
        match(HOOD_EARN_VAULT, "Deposit(address,address,uint256,uint256)").single {
          it.getJSONArray("topics").length() == 3 &&
            sponsoredLogAddress(it, 1, HOOD_EARN_ROUTER) &&
            sponsoredLogAddress(it, 2, owner)
        }
      val words = sponsoredLogWords(event, 2)
      check(words[0] == amount && words[1].signum() > 0)
      op.put("settledShares", words[1].toString())
    }
    "hoodRedeemAll" -> {
      transfer(owner, "0x" + "0".repeat(40), amount, HOOD_EARN_VAULT)
      val event =
        match(HOOD_EARN_VAULT, "Withdraw(address,address,address,uint256,uint256)").single {
          it.getJSONArray("topics").length() == 4 &&
            sponsoredLogAddress(it, 1, HOOD_EARN_ROUTER) &&
            sponsoredLogAddress(it, 2, HOOD_EARN_ROUTER) &&
            sponsoredLogAddress(it, 3, owner)
        }
      val words = sponsoredLogWords(event, 2)
      check(words[0].signum() > 0 && words[1] == amount)
      op.put("redeemedUsdgAtoms", words[0].toString())
      transfer(HOOD_EARN_ROUTER, owner, words[0])
    }
    else -> error("Unsupported sponsored action")
  }
}
