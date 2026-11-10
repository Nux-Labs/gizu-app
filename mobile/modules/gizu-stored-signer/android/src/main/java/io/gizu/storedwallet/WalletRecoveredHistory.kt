package io.gizu.storedwallet

import android.content.Context
import java.util.UUID
import javax.crypto.SecretKey
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.SwapOperation
import uniffi.gizu_stored_signer_core.confidentialWithdrawalPlan

private val recoveredDomains =
  mapOf(
    "gizu-stored-operations" to "gizu-operations",
    "gizu-swap" to "gizu-swap",
    "gizu-earn-vault" to "gizu-earn-vault",
    "gizu-earn-sponsored" to "gizu-earn-sponsored",
    "gizu-earn-payout" to "gizu-earn-payout",
    "gizu-earn-liquidity" to "gizu-earn-liquidity",
    "gizu-earn-withdrawal" to "gizu-earn-withdrawal",
    "gizu-earn-deposit" to "gizu-earn-deposit",
    "gizu-earn-quotes" to "gizu-earn-quotes",
    "gizu-confidential-withdrawal" to "gizu-confidential-withdrawal",
    "gizu-funding-reservations" to "gizu-funding-reservations",
  )

/**
 * Imports authenticated portable records; the caller commits the preserved archive first and
 * catalogue/recovery state last. A partial I/O failure never clears the recovery gate.
 */
internal class RecoveredHistoryImporter(
  private val walletId: String,
  private val generation: String,
  private val key: SecretKey,
  private val file: (String) -> WalletFile,
) {
  private fun aad(domain: String) = "$domain:v1:$walletId:$generation".toByteArray()

  private fun canonical(value: Any?): String =
    when (value) {
      is JSONObject ->
        value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") {
          JSONObject.quote(it) + ":" + canonical(value.get(it))
        }
      is JSONArray ->
        (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
      else -> JSONArray().put(value).toString().let { it.substring(1, it.length - 1) }
    }

  private val signedFields =
    setOf(
      "raw",
      "signedData",
      "signedOrder",
      "signedUserOperation",
      "rawTransaction",
      "signedTransaction",
      "permit",
      "authorization",
      "signedDelegation",
      "signature",
    )

  private fun signedEvidence(value: Any, path: String = ""): Map<String, String> {
    val result = linkedMapOf<String, String>()
    when (value) {
      is JSONObject ->
        for (field in value.keys()) {
          val child = value.get(field)
          if (field in signedFields) result["$path/$field"] = canonical(child)
          else result.putAll(signedEvidence(child, "$path/$field"))
        }
      is JSONArray ->
        for (i in 0 until value.length()) {
          val child = value.get(i)
          val identity = (child as? JSONObject)?.opt("index") ?: i
          result.putAll(signedEvidence(child, "$path/$identity"))
        }
    }
    return result
  }

  private fun unsignedSponsoredRefresh(older: JSONObject, newer: JSONObject): Boolean {
    if (
      !older.has("authorization") ||
        older.sponsoredSpendSaved() ||
        older.optBoolean("signingPending") ||
        older.optBoolean("cancelled")
    )
      return false
    val before = older.getJSONObject("proposal")
    val after = newer.getJSONObject("proposal")
    val kind = before.getString("kind")
    if (
      kind !in setOf("sourceFunding", "hoodDeposit") ||
        after.getLong("revision") <= before.getLong("revision")
    )
      return false
    val fixed =
      listOf(
        "kind",
        "operationId",
        "chainId",
        "profileChainId",
        "cycleIndex",
        "investmentSlot",
        "expectedFrom",
        "token",
        "slippageBps",
      ) +
        if (kind == "sourceFunding")
          listOf(
            "sourceAccountIndex",
            "fundingBatchId",
            "fundingBatchSize",
            "confidentialAccount",
            "refundOwner",
            "budgetAtoms",
            "withdrawalReserveAtoms",
          )
        else listOf("vault", "router")
    if (fixed.any { canonical(before.opt(it)) != canonical(after.opt(it)) }) return false
    // These are the same bounds as EarnSponsoredJournal.refreshUnsignedDeposit/Source.
    if (kind == "hoodDeposit") {
      if (
        older.optBoolean("conflict") ||
          depositAtoms(after.getString("budgetAtoms"), true) >
            depositAtoms(before.getString("budgetAtoms"), true)
      )
        return false
      val unsigned = newer.getJSONObject("unsignedUserOperation")
      if (
        !unsigned.getString("sender").equals(before.getString("expectedFrom"), true) ||
          unsigned.has("signature") && unsigned.getString("signature") != "0x" ||
          unsigned.has("eip7702Auth")
      )
        return false
    }
    return true
  }

  private fun mergeEntry(
    a: JSONObject,
    b: JSONObject,
    sponsored: Boolean,
    cashout: Boolean,
  ): JSONObject {
    val ar = a.optInt("revision", 0)
    val br = b.optInt("revision", 0)
    require(ar >= 0 && br >= 0)
    if (ar == br) {
      check(canonical(a) == canonical(b)) { "RECOVERY_HISTORY_CONFLICT" }
      return a
    }
    val newer = if (ar > br) a else b
    val older = if (ar > br) b else a
    if (cashout) validateCashoutMerge(older, newer)
    val signed = signedEvidence(older)
    val current = signedEvidence(newer)
    check(signed.all { (path, value) -> current[path] == value }) {
      "RECOVERY_SIGNED_HISTORY_CONFLICT"
    }
    if (signed.isNotEmpty() && older.has("proposal"))
      check(
        canonical(older.get("proposal")) == canonical(newer.opt("proposal")) ||
          sponsored && unsignedSponsoredRefresh(older, newer)
      ) {
        "RECOVERY_SIGNED_PROPOSAL_CONFLICT"
      }
    return JSONObject(newer.toString())
  }

  private fun mergeRows(
    a: JSONArray,
    b: JSONArray,
    sponsored: Boolean = false,
    cashout: Boolean = false,
    identity: (JSONObject) -> String,
  ): JSONArray {
    val rows = linkedMapOf<String, JSONObject>()
    for (source in listOf(a, b)) for (i in 0 until source.length()) {
      val row = source.getJSONObject(i)
      if (row.has("walletId")) check(row.getString("walletId") == walletId)
      val id = identity(row)
      require(id.length in 1..256)
      rows[id] =
        rows[id]?.let { mergeEntry(it, row, sponsored, cashout) } ?: JSONObject(row.toString())
    }
    require(rows.size <= 100_000)
    return JSONArray(rows.values.toList())
  }

  /** Cashout plans and signed allocations are native immutable records across every generation. */
  private fun validateCashoutMerge(older: JSONObject, newer: JSONObject) {
    check(canonical(older.get("plan")) == canonical(newer.get("plan"))) {
      "RECOVERY_CASHOUT_PLAN_CONFLICT"
    }
    val before = older.getJSONArray("children").objects()
    val after = newer.getJSONArray("children").objects()
    check(before.size == after.size)
    for ((index, child) in before.withIndex()) {
      val next = after[index]
      for (field in listOf("source", "slot", "amountAtoms")) check(
        canonical(child.get(field)) == canonical(next.get(field))
      )
      if (child.has("signedData"))
        for (field in
          listOf("signedData", "preparedText", "nonce", "payloadHash", "reservationId")) check(
          canonical(child.get(field)) == canonical(next.get(field))
        ) {
          "RECOVERY_CASHOUT_SIGNED_CONFLICT"
        }
      child.optJSONArray("nonceHistory")?.let { history ->
        val current = next.getJSONArray("nonceHistory")
        check(current.length() >= history.length())
        for (i in 0 until history.length()) check(history.getString(i) == current.getString(i))
      }
      if (child.getString("status") == "paid")
        check(canonical(child) == canonical(next)) { "RECOVERY_CASHOUT_PAID_CONFLICT" }
    }
    if (older.optBoolean("cancelled")) check(newer.optBoolean("cancelled"))
    if (older.has("groupReceipt"))
      check(canonical(older.get("groupReceipt")) == canonical(newer.get("groupReceipt"))) {
        "RECOVERY_CASHOUT_GROUP_CONFLICT"
      }
  }

  private fun validateCashoutOperation(row: JSONObject) {
    check(row.getString("walletId") == walletId && row.getInt("revision") > 0)
    val plan = row.getJSONObject("plan")
    val proposal = plan.getJSONObject("proposal")
    check(proposal.getString("operationId") == row.getString("operationId"))
    check(nativeJsonEqual(plan, JSONObject(confidentialWithdrawalPlan(proposal.toString()))))
    val matrix = plan.getJSONArray("children").objects()
    val children = row.getJSONArray("children").objects()
    check(children.size == matrix.size)
    val events = mutableSetOf<String>()
    for ((index, child) in children.withIndex()) {
      for (field in listOf("source", "slot", "amountAtoms")) check(
        nativeJsonEqual(child.get(field), matrix[index].get(field))
      )
      val status = child.getString("status")
      check(
        status in
          setOf("needsReview", "review", "unknown", "pending", "paid", "conflict", "cancelled")
      )
      val minimum = depositAtoms(child.getString("minimumDestinationAtoms"))
      val received = depositAtoms(child.getString("receivedAtoms"))
      if (child.has("signedData")) {
        check(
          !row.optBoolean("cancelled") && status !in setOf("needsReview", "review", "cancelled")
        )
        for (field in listOf("preparedText", "nonce", "payloadHash", "reservationId")) check(
          child.getString(field).isNotEmpty()
        )
        val prepared = JSONObject(child.getString("preparedText"))
        val payload = prepared.getJSONObject("intent").getString("payload")
        val source =
          proposal
            .getJSONArray("sources")
            .getJSONObject(child.getInt("source"))
            .getString("address")
        check(prepared.getString("operationId") == row.getString("operationId") + "_" + index)
        check(
          prepared.getString("confidentialAccount").equals(source, true) &&
            JSONObject(payload).getString("signer_id").equals(source, true)
        )
        earnAddressWord(prepared.getString("destinationRecipient"))
        val signed = JSONObject(child.getString("signedData"))
        check(
          signed.getString("standard") == "erc191" &&
            signed.getString("payload") == payload &&
            signed.getString("signature").isNotEmpty()
        )
        check(
          JSONObject(payload).getString("nonce") == child.getString("nonce") &&
            utf8EarnHash(payload) == child.getString("payloadHash")
        )
        check(
          prepared.getString("amountAtoms") == child.getString("amountAtoms") &&
            prepared.getString("minimumDestinationAtoms") ==
              child.getString("minimumDestinationAtoms")
        )
      }
      if (child.optBoolean("signingPending"))
        check(!row.optBoolean("cancelled") && status != "cancelled")
      if (status == "paid") {
        check(child.has("signedData") && minimum.signum() > 0 && received >= minimum)
        val receipt = child.optJSONObject("receipt")
        if (receipt != null) {
          val event =
            earnHash(receipt.getString("transactionHash")) + ":" + receipt.getInt("logIndex")
          check(receipt.getInt("logIndex") >= 0 && events.add(event))
          if (receipt.has("receivedAtoms"))
            check(receipt.getString("receivedAtoms") == child.getString("receivedAtoms"))
        } else check(child.has("deliveryGroupId") && row.has("groupReceipt"))
      } else check(received.signum() == 0)
      if (row.optBoolean("cancelled")) check(status == "cancelled")
    }
    row.optJSONObject("groupReceipt")?.let { proof -> validateCashoutGroupReceipt(row, proof) }
  }

  private fun validateCashoutGroupReceipt(row: JSONObject, proof: JSONObject) {
    check(
      proof.getString("operationId") == row.getString("operationId") &&
        proof.getString("status") == "paid"
    )
    check(
      proof.get("authenticated") == true &&
        proof.get("operationScoped") == true &&
        proof.getString("verification") == "destination-receipt-group-v1"
    )
    val groupId = proof.getString("groupId")
    check(groupId.matches(Regex("[0-9a-f]{64}")))
    val children = row.getJSONArray("children").objects()
    check(children.all { it.getString("status") == "paid" && it.has("signedData") })
    val routes = proof.getJSONArray("routes").objects()
    check(
      routes.size == children.size &&
        routes.map { it.getInt("index") }.toSet() == children.indices.toSet() &&
        routes.all { it.getString("status") == "SUCCESS" }
    )
    val slots = proof.getJSONArray("slots").objects()
    val group =
      JSONObject()
        .put("plan", row.getJSONObject("plan"))
        .put("recipients", JSONArray(slots.map { it.getString("destinationRecipient") }))
    check(cashoutGroupIdentity(group) == groupId)
    check(
      slots.size ==
        row
          .getJSONObject("plan")
          .getJSONObject("proposal")
          .getJSONArray("recipientIndices")
          .length()
    )
    val events = mutableSetOf<String>()
    for ((slot, receipt) in slots.withIndex()) {
      check(receipt.getInt("slot") == slot)
      val selected = children.filter { it.getInt("slot") == slot }
      check(
        receipt.getString("minimumDestinationAtoms") ==
          selected.sumAtoms("minimumDestinationAtoms") &&
          receipt.getString("receivedAtoms") == selected.sumAtoms("receivedAtoms")
      )
      val transfers = receipt.getJSONArray("receipts").objects()
      check(
        transfers.isNotEmpty() &&
          transfers.sumAtoms("receivedAtoms") == receipt.getString("receivedAtoms")
      )
      for (transfer in transfers) {
        check(depositAtoms(transfer.getString("receivedAtoms"), true).signum() > 0)
        check(
          transfer.getInt("logIndex") >= 0 &&
            events.add(
              earnHash(transfer.getString("transactionHash")) + ":" + transfer.getInt("logIndex")
            )
        )
      }
      for (child in selected) {
        val prepared = JSONObject(child.getString("preparedText"))
        check(
          receipt
            .getString("destinationRecipient")
            .equals(prepared.getString("destinationRecipient"), true)
        )
        if (child.has("deliveryGroupId")) check(child.getString("deliveryGroupId") == groupId)
        child.optJSONObject("receipt")?.let { legacy ->
          check(
            transfers.any {
              earnHash(it.getString("transactionHash")) ==
                earnHash(legacy.getString("transactionHash")) &&
                it.getInt("logIndex") == legacy.getInt("logIndex") &&
                it.getString("receivedAtoms") == child.getString("receivedAtoms")
            }
          )
        }
      }
    }
  }

  private fun prepare(domain: String, data: String, sourceGeneration: String): Any {
    require(data.toByteArray().size <= 16 * 1024 * 1024)
    if (domain == "gizu-earn-quotes") return JSONArray(data)
    val root = JSONObject(data)
    check(root.getInt("version") == 1)
    if (domain != "gizu-funding-reservations") check(root.getString("walletId") == walletId)
    if (domain == "gizu-confidential-withdrawal") {
      check(root.getString("generation") == sourceGeneration)
      for (operation in root.getJSONArray("operations").objects()) validateCashoutOperation(
        operation
      )
      root.put("generation", generation)
    }
    if (domain == "gizu-earn-deposit") {
      check(root.getString("generation") == sourceGeneration)
      root.put("generation", generation)
      val journeys = root.getJSONArray("journeys")
      for (i in 0 until journeys.length()) {
        val row = journeys.getJSONObject(i)
        check(
          row.getString("walletId") == walletId && row.getString("generation") == sourceGeneration
        )
        row.put("generation", generation)
      }
    }
    if (domain in setOf("gizu-earn-sponsored", "gizu-earn-liquidity")) {
      val operations = root.getJSONArray("operations")
      for (i in 0 until operations.length()) {
        val operation = operations.getJSONObject(i)
        if (!operation.has("minimumReturnReceipt")) continue
        // Only this authenticated import boundary can move already validated evidence between
        // journal generations. Never repair a substituted source generation or wallet binding.
        val receipt = checkNotNull(savedMinimumReturnReceipt(operation, walletId, sourceGeneration))
        receipt.getJSONObject("nativeBinding").put("generation", generation)
        checkNotNull(savedMinimumReturnReceipt(operation, walletId, generation))
      }
    }
    return root
  }

  private fun merge(domain: String, a: Any, b: Any): Any {
    if (domain == "gizu-earn-quotes")
      return mergeRows(a as JSONArray, b as JSONArray) {
        "${it.getString("operationId")}:${it.getInt("revision")}"
      }
    a as JSONObject
    b as JSONObject
    if (domain in setOf("gizu-swap", "gizu-funding-reservations")) {
      val ar = a.optLong("recoverySnapshotRevision", 0)
      val br = b.optLong("recoverySnapshotRevision", 0)
      val ac = JSONObject(a.toString()).also { it.remove("recoverySnapshotRevision") }
      val bc = JSONObject(b.toString()).also { it.remove("recoverySnapshotRevision") }
      if (canonical(ac) == canonical(bc)) return if (ar >= br) a else b
      check(ar > 0 && br > 0 && ar != br) { "RECOVERY_SNAPSHOT_HISTORY_CONFLICT" }
      val newer = if (ar > br) a else b
      val older = if (ar > br) b else a
      if (domain == "gizu-swap") return newer
      val batches = older.getJSONArray("batches")
      val current = newer.getJSONArray("batches")
      val result = linkedMapOf<String, JSONObject>()
      for (i in 0 until batches.length()) result[batches.getJSONObject(i).getString("id")] =
        batches.getJSONObject(i)
      for (i in 0 until current.length()) result[current.getJSONObject(i).getString("id")] =
        current.getJSONObject(i)
      return JSONObject(newer.toString()).put("batches", JSONArray(result.values.toList()))
    }
    val collection =
      when (domain) {
        "gizu-earn-deposit" -> "journeys"
        "gizu-funding-reservations" -> "batches"
        else -> "operations"
      }
    val id =
      when (collection) {
        "journeys" -> "journeyId"
        "batches" -> "id"
        else -> "operationId"
      }
    return JSONObject(a.toString())
      .put(
        collection,
        mergeRows(
          a.getJSONArray(collection),
          b.getJSONArray(collection),
          domain == "gizu-earn-sponsored",
          domain == "gizu-confidential-withdrawal",
        ) {
          it.getString(id)
        },
      )
  }

  private fun compactTransferHistory(pending: MutableMap<String, Pair<String, Any>>) {
    val target = "gizu-operations-$generation.enc"
    val entry = pending[target] ?: return
    val root = entry.second as JSONObject
    val rows = root.getJSONArray("operations")
    val retained = (0 until rows.length()).map(rows::getJSONObject).toMutableList()
    val domain = "gizu-stored-operations"
    while (retained.size > 256) {
      // Match normal OperationJournal rollover: unknown signatures always remain active.
      val settledIndex = retained.indexOfFirst { !it.unresolved() && !it.blocked() }
      check(settledIndex >= 0) { "RECOVERY_TOO_MANY_UNCERTAIN_TRANSFERS" }
      val settled = retained.removeAt(settledIndex)
      val id = settled.getString("operationId")
      require(id.matches(Regex("[a-zA-Z0-9_-]{1,128}")))
      val archiveName = "gizu-operations-$generation-archive-$id.enc"
      val archiveRoot =
        JSONObject()
          .put("version", 1)
          .put("walletId", walletId)
          .put("operations", JSONArray().put(settled))
      var archived = pending[archiveName]?.second
      if (archived == null && file(archiveName).exists()) {
        val clear = CryptoEnvelope.decrypt(key, file(archiveName).read(), aad(domain))
        try {
          archived = prepare(domain, String(clear, Charsets.UTF_8), generation)
        } finally {
          clear.fill(0)
        }
      }
      pending[archiveName] =
        domain to if (archived == null) archiveRoot else merge(domain, archived, archiveRoot)
    }
    pending[target] = domain to JSONObject(root.toString()).put("operations", JSONArray(retained))
  }

  fun import(history: JSONArray) {
    require(history.length() <= 32768)
    UUID.fromString(generation)
    val pending = linkedMapOf<String, Pair<String, Any>>()
    // Entire batch is validated before the first write, including local signed conflicts.
    for (i in 0 until history.length()) {
      val row = history.getJSONObject(i)
      val domain = row.getString("domain")
      val prefix = recoveredDomains[domain] ?: error("RECOVERY_HISTORY_DOMAIN")
      val old = row.getString("generation")
      UUID.fromString(old)
      val name = row.getString("name")
      val base = "$prefix-$old"
      check(
        name == "$base.enc" ||
          domain == "gizu-stored-operations" &&
            name.matches(Regex(Regex.escape(base) + "-archive-[a-zA-Z0-9_-]{1,128}\\.enc"))
      )
      val target = "$prefix-$generation" + name.removePrefix(base)
      val incoming = prepare(domain, row.getString("data"), old)
      if (domain in setOf("gizu-swap", "gizu-funding-reservations")) {
        val provenance = row.optLong("snapshotRevision", 0)
        require(provenance >= 0)
        (incoming as JSONObject).put("recoverySnapshotRevision", provenance)
      }
      var existing = pending[target]?.second
      if (existing == null && file(target).exists()) {
        val clear = CryptoEnvelope.decrypt(key, file(target).read(), aad(domain))
        try {
          existing = prepare(domain, String(clear, Charsets.UTF_8), generation)
        } finally {
          clear.fill(0)
        }
      }
      pending[target] =
        domain to if (existing == null) incoming else merge(domain, existing, incoming)
    }
    compactTransferHistory(pending)
    for ((_, entry) in pending) if (entry.first == "gizu-confidential-withdrawal")
      check(entry.second.toString().toByteArray().size < 8 * 1024 * 1024 - 1024)
    // Archive before the active root, so a crash can duplicate settled rows but never lose them.
    for ((target, entry) in pending.entries.sortedBy { if ("-archive-" in it.key) 0 else 1 }) {
      val clear = entry.second.toString().toByteArray()
      try {
        file(target).write(CryptoEnvelope.encrypt(key, clear, aad(entry.first)))
      } finally {
        clear.fill(0)
      }
    }
  }
}

internal fun importRecoveredHistory(context: Context, record: WalletRecord, history: JSONArray) {
  RecoveredHistoryImporter(
      record.id,
      record.journalId,
      checkNotNull(AndroidWalletKeys().existing()),
    ) {
      AndroidWalletFile(context, it, 16 * 1024 * 1024)
    }
    .import(history)
}

/**
 * Reconciles existing exact records only. Pending verified bytes remain resumable through the
 * original fresh-approval controls; no operation is prepared, signed, or submitted here.
 */
internal suspend fun reconcileRecoveredHistory(context: Context, store: WalletStore): Boolean {
  return try {
    store.load().use { record ->
      val key = checkNotNull(AndroidWalletKeys().existing())
      fun file(prefix: String) =
        AndroidWalletFile(context, "$prefix-${record.journalId}.enc", 16 * 1024 * 1024)
      fun rows(prefix: String): List<JSONObject> {
        val source = file(prefix)
        if (!source.exists()) return emptyList()
        val domain = if (prefix == "gizu-operations") "gizu-stored-operations" else prefix
        val clear =
          CryptoEnvelope.decrypt(
            key,
            source.read(),
            "$domain:v1:${record.id}:${record.journalId}".toByteArray(),
          )
        try {
          val root = JSONObject(String(clear, Charsets.UTF_8))
          check(root.getString("walletId") == record.id)
          val values =
            root.getJSONArray(if (prefix == "gizu-earn-deposit") "journeys" else "operations")
          return (0 until values.length()).map(values::getJSONObject)
        } finally {
          clear.fill(0)
        }
      }
      val quotes = EarnQuoteJournal(file("gizu-earn-quotes"), { key }, record.id, record.journalId)
      if (file("gizu-operations").exists()) {
        val journal = operationJournal(context, record)
        reconcileOperations(journal, MonadRpc())
        check(journal.all().none { op -> op.steps().any { it.optBoolean("conflict") } })
      }
      if (file("gizu-earn-vault").exists()) {
        val journal =
          EarnVaultJournal(file("gizu-earn-vault"), { key }, record.id, record.journalId)
        reconcileEarnVaultOperations(journal, EthereumEarnRpc())
        check(journal.all().none { op -> op.steps().any { it.optBoolean("conflict") } })
      }
      if (file("gizu-earn-sponsored").exists()) {
        val journal =
          EarnSponsoredJournal(
            file("gizu-earn-sponsored"),
            { key },
            record.id,
            record.journalId,
            quotes,
          )
        for (chain in
          journal
            .all()
            .filter { it.has("signedUserOperation") }
            .map { it.getJSONObject("proposal").getInt("chainId") }
            .distinct()) {
          check(chain in setOf(143, 4663))
          reconcileEarnSponsoredOperations(
            journal,
            EarnSponsoredChainRpc(chain),
            EarnSponsoredBundlerRpc(chain),
            chainFilter = chain,
          )
        }
        check(journal.all().none { it.optBoolean("conflict") || it.optBoolean("signingPending") })
      }
      if (file("gizu-earn-liquidity").exists()) {
        val journal =
          EarnLiquidityJournal(
            file("gizu-earn-liquidity"),
            { key },
            record.id,
            record.journalId,
            quotes,
          )
        reconcileEarnLiquidityOperations(journal, EthereumEarnRpc(), NativeFusionGateway())
        check(journal.all().none { it.optBoolean("conflict") })
      }
      suspend fun readAuth(): uniffi.gizu_stored_signer_core.EarnReadAuthentication {
        val provider = ConfidentialBalance()
        val salt = provider.salt()
        val random = ByteArray(7).also { java.security.SecureRandom().nextBytes(it) }
        val started = System.currentTimeMillis().toULong()
        return store.load().use {
          cycleReadAuth(it, salt, random, started, System.currentTimeMillis().toULong())
        }
      }
      val originalCycle = record.earnCycleIndex
      try {
        for (prefix in listOf("gizu-earn-payout", "gizu-earn-withdrawal")) {
          for (op in rows(prefix).filter { it.has("signedData") }) {
            val proposal = op.getJSONObject("proposal")
            store.selectEarnCycle(proposal.optInt("cycleIndex", 0))
            if (proposal.has("investmentSlot"))
              store.selectEarnInvestmentSlot(
                proposal.optInt("cycleIndex", 0),
                proposal.getInt("investmentSlot"),
              )
            val destination: TransferRpc =
              when (proposal.getInt("profileChainId")) {
                1 -> EthereumEarnRpc()
                4663 -> EarnSponsoredChainRpc(4663)
                else -> error("RECOVERY_CHAIN")
              }
            if (prefix == "gizu-earn-payout") {
              val journal = EarnPayoutJournal(file(prefix), { key }, record.id, record.journalId)
              EarnPayoutEngine(
                  store,
                  journal,
                  destination,
                  sourceReader = { _, _ -> error("Recovery cannot prepare a payout") },
                  readAuth = ::readAuth,
                )
                .use { it.reconcile(op.getString("operationId"), op.getInt("revision")) }
            } else {
              val journal =
                EarnWithdrawalJournal(file(prefix), { key }, record.id, record.journalId)
              EarnWithdrawalEngine(
                  store,
                  journal,
                  destination,
                  sourceReader = { _, _ -> error("Recovery cannot prepare a withdrawal") },
                  readAuth = ::readAuth,
                )
                .use { it.reconcile(op.getString("operationId"), op.getInt("revision")) }
            }
          }
        }
      } finally {
        val cycles = JSONArray(record.earnCycles)
        if (
          (0 until cycles.length()).any {
            cycles.getJSONObject(it).getInt("cycleIndex") == originalCycle
          }
        ) {
          store.selectEarnCycle(originalCycle)
          selectedInvestmentSlot(record)?.let { store.selectEarnInvestmentSlot(originalCycle, it) }
        }
      }
      if (file("gizu-swap").exists()) {
        val clear =
          CryptoEnvelope.decrypt(
            key,
            file("gizu-swap").read(),
            "gizu-swap:v1:${record.id}:${record.journalId}".toByteArray(),
          )
        try {
          val saved = JSONObject(String(clear, Charsets.UTF_8))
          check(saved.getString("walletId") == record.id)
          // Restore contains no seed. The existing UI owns subsequent read/review/resume steps.
          SwapOperation.restore(saved.getString("state"), "https://api.gizu.io").use {
            it.publicStatus()
          }
        } finally {
          clear.fill(0)
        }
      }
      true
    }
  } catch (e: CancellationException) {
    throw e
  } catch (_: Exception) {
    false
  }
}
