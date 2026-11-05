package io.gizu.storedwallet

import java.security.MessageDigest
import java.security.SecureRandom
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject

/**
 * Snapshot transport contains native metadata and exact portable history, never signing authority.
 */
internal class WalletRecoveryEngine(
  private val store: WalletStore,
  private val stateFile: WalletFile,
  private val remote: WalletRecoveryRemote,
  private val exportHistory: (WalletRecord) -> JSONArray = { JSONArray() },
  private val retainHistory: (WalletRecord, JSONArray) -> Unit = { _, _ -> },
  private val observeCycle: suspend (WalletRecord, Int, Int) -> Int,
  private val countKnown: (WalletRecord) -> Int = { 0 },
  private val reconcileRestored: suspend () -> Boolean = { false },
  private val historyFingerprint: (WalletRecord) -> String = { "" },
  private val discoveryResolved: (WalletRecord) -> Boolean = { !it.discoveryRecoveryRequired },
) {
  private val mutex = Mutex()
  @Volatile private var cancelled = false
  @Volatile private var phase = "idle"
  @Volatile private var message: String? = null
  @Volatile private var discoveryJob: kotlinx.coroutines.Job? = null

  private fun state(crypto: WalletRecoveryCrypto): JSONObject {
    if (!stateFile.exists())
      return JSONObject().put("revision", 0).put("scanned", -1).put("target", -1).put("count", 0)
    val clear =
      crypto.decrypt(crypto.locator + ":state", 1, String(stateFile.read(), Charsets.UTF_8))
    try {
      return JSONObject(String(clear, Charsets.UTF_8))
    } finally {
      clear.fill(0)
    }
  }

  private fun save(crypto: WalletRecoveryCrypto, state: JSONObject) =
    stateFile.write(
      crypto.encrypt(crypto.locator + ":state", 1, state.toString().toByteArray()).toByteArray()
    )

  private fun metadata(record: WalletRecord) =
    JSONObject()
      .put("roleRegistry", record.roleRegistry)
      .put("earnChain", record.earnChain)
      .put("earnCycleIndex", record.earnCycleIndex)
      .put("earnCycles", record.earnCycles)
      .put("discoveryHighWater", record.discoveryHighWater)
      .put("discoveryRecoveryRequired", record.discoveryRecoveryRequired)

  private fun snapshot(record: WalletRecord, state: JSONObject): JSONObject {
    val history = exportHistory(record)
    val captures = JSONArray()
    for (i in 0 until history.length()) {
      val row = JSONObject(history.getJSONObject(i).toString())
      if (!row.has("snapshotRevision"))
        row.put("snapshotRevision", Math.addExact(state.getLong("revision"), 1))
      captures.put(row)
    }
    return JSONObject()
      .put("version", 1)
      .put("metadata", metadata(record))
      .put("history", captures)
      .put("scanned", state.getInt("scanned"))
      .put("target", state.getInt("target"))
      .put("count", state.getInt("count"))
  }

  private fun digest(bytes: ByteArray) =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  private fun sourceFingerprint(record: WalletRecord, state: JSONObject) =
    digest(
      (metadata(record).toString() +
          ":" +
          state.getInt("scanned") +
          ":" +
          state.getInt("target") +
          ":" +
          state.getInt("count") +
          ":" +
          historyFingerprint(record))
        .toByteArray()
    )

  fun status(walletId: String): Map<String, Any> =
    store.load().use { record ->
      check(record.id == walletId)
      WalletRecoveryCrypto(record.entropy).use { crypto ->
        val state = state(crypto)
        val fingerprint = sourceFingerprint(record, state)
        buildMap {
          put("version", 1)
          put("phase", phase)
          put("revision", state.getLong("revision"))
          put("synced", state.optString("fingerprint") == fingerprint)
          put("scannedThroughCycle", state.getInt("scanned"))
          put("scanTargetCycle", state.getInt("target"))
          put("discoveredWallets", maxOf(state.getInt("count"), countKnown(record)))
          put("recoveryRequired", record.earnRecoveryRequired)
          message?.let { code ->
            put(
              "messageCode",
              when (code) {
                "RECOVERY_CONFLICT",
                "RECOVERY_RESTORE_REQUIRED" -> "conflict"
                "RECOVERY_ROLLBACK" -> "rollback"
                "RECOVERY_INTEGRITY_FAILED" -> "tampered"
                "RECOVERY_RECONCILIATION_REQUIRED" -> "reconciliationRequired"
                "DISCOVERY_MORE_REMAINING",
                "DISCOVERY_BOUND_REACHED" -> "scanIncomplete"
                "CANCELLED" -> "cancelled"
                else -> "backupUnavailable"
              },
            )
          }
        }
      }
    }

  private suspend fun <T> action(name: String, block: suspend () -> T): T =
    mutex.withLock {
      phase = name
      message = null
      try {
        block().also { phase = "ready" }
      } catch (e: CancellationException) {
        phase = "paused"
        throw e
      } catch (e: Exception) {
        phase = "error"
        message =
          when {
            e is WalletRecoveryFailure -> e.code
            name == "discovering" && (e is RpcFailure || e is EarnGatewayFailure) ->
              "DISCOVERY_MORE_REMAINING"
            else -> "RECOVERY_INTEGRITY_FAILED"
          }
        throw e
      }
    }

  suspend fun sync(walletId: String): Map<String, Any> {
    action("syncing") { syncSnapshot(walletId) }
    return status(walletId)
  }

  private fun ids(value: JSONArray): List<String> =
    (0 until value.length()).map {
      value.getString(it).also { id -> require(id.matches(Regex("[0-9a-f]{64}"))) }
    }

  private fun pageSets(manifest: JSONObject?): List<List<String>> =
    if (manifest == null) emptyList()
    else
      listOf(ids(manifest.getJSONArray("pages"))) +
        (manifest.optJSONArray("previousPages") ?: JSONArray()).let { sets ->
          require(sets.length() <= 2)
          (0 until sets.length()).map { ids(sets.getJSONArray(it)) }
        }

  private fun decodeManifest(crypto: WalletRecoveryCrypto, root: RecoveryObject?): JSONObject? {
    if (root == null) return null
    val clear = crypto.decrypt(crypto.locator, root.revision, root.ciphertext)
    try {
      return JSONObject(String(clear, Charsets.UTF_8)).also { check(it.getInt("version") == 1) }
    } finally {
      clear.fill(0)
    }
  }

  /**
   * Durable deletion candidates only; never delete a page referenced by any retained committed
   * root.
   */
  private suspend fun cleanup(
    crypto: WalletRecoveryCrypto,
    state: JSONObject,
    referenced: Set<String>,
  ) {
    val pending =
      ids(state.optJSONArray("cleanup") ?: JSONArray())
        .filter { it !in referenced }
        .distinct()
        .toMutableList()
    require(pending.size <= 2048)
    state.put("cleanup", JSONArray(pending))
    save(crypto, state)
    for (id in pending.toList().take(64)) {
      try {
        remote.delete(id, crypto.token)
      } catch (e: CancellationException) {
        throw e
      } catch (_: Exception) {
        break
      }
      pending.remove(id)
      state.put("cleanup", JSONArray(pending))
      save(crypto, state)
    }
  }

  private suspend fun syncSnapshot(walletId: String) =
    store.load().use { record ->
      check(record.id == walletId && record.verified)
      WalletRecoveryCrypto(record.entropy).use { crypto ->
        val state = state(crypto)
        val current = remote.get(crypto.locator, crypto.token)
        val revision = state.getLong("revision")
        if (
          current == null &&
            (revision > 0 || record.earnRecoveryRequired && record.journalId != record.id)
        )
          throw WalletRecoveryFailure("RECOVERY_MISSING")
        if (current != null && current.revision != revision)
          throw WalletRecoveryFailure(
            if (current.revision < revision) "RECOVERY_ROLLBACK" else "RECOVERY_RESTORE_REQUIRED"
          )
        val previous = pageSets(decodeManifest(crypto, current))
        val referenced = previous.flatten().toSet()
        cleanup(crypto, state, referenced)
        // Bound abandoned uploads even while the service refuses cleanup; do not allocate
        // indefinitely.
        if ((state.optJSONArray("cleanup")?.length() ?: 0) > 512)
          throw WalletRecoveryFailure("RECOVERY_CLEANUP_REQUIRED")
        val clear = snapshot(record, state).toString().toByteArray()
        try {
          val fingerprint = sourceFingerprint(record, state)
          if (current != null && state.optString("fingerprint") == fingerprint) return@use
          require(clear.size <= 16 * 1024 * 1024)
          val pages = JSONArray()
          for (offset in clear.indices step 64 * 1024) {
            currentCoroutineContext().ensureActive()
            val random = ByteArray(32).also { SecureRandom().nextBytes(it) }
            val id =
              crypto.pageLocator(
                java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(random)
              )
            // Track allocation before the upload, including an interrupted or uncertain PUT.
            val pending = state.optJSONArray("cleanup") ?: JSONArray()
            require(pending.length() < 2048)
            pending.put(id)
            state.put("cleanup", pending)
            save(crypto, state)
            val chunk = clear.copyOfRange(offset, minOf(clear.size, offset + 64 * 1024))
            val ciphertext = crypto.encrypt(id, 1, chunk)
            chunk.fill(0)
            val ack = remote.put(id, crypto.token, 0, ciphertext)
            check(ack.revision == 1L && ack.ciphertext == ciphertext)
            pages.put(id)
          }
          val next = Math.addExact(revision, 1)
          val manifest =
            JSONObject()
              .put("version", 1)
              .put("size", clear.size)
              .put("digest", digest(clear))
              .put("pages", pages)
              .put("previousPages", JSONArray(previous.take(2).map { JSONArray(it) }))
              .toString()
              .toByteArray()
          val ciphertext = crypto.encrypt(crypto.locator, next, manifest)
          manifest.fill(0)
          // Retirements are durable before CAS as well: the server can commit while its ACK is
          // lost.
          val retirement =
            ids(state.optJSONArray("cleanup") ?: JSONArray()) + previous.drop(2).flatten()
          state.put("cleanup", JSONArray(retirement.distinct()))
          save(crypto, state)
          val ack = remote.put(crypto.locator, crypto.token, revision, ciphertext)
          check(ack.revision == next && ack.ciphertext == ciphertext)
          val keep = ids(pages).toSet() + previous.take(2).flatten()
          val abandoned =
            ids(state.optJSONArray("cleanup") ?: JSONArray()) + previous.drop(2).flatten()
          state
            .put("revision", next)
            .put("fingerprint", fingerprint)
            .put("cleanup", JSONArray(abandoned.distinct().filter { it !in keep }))
          save(crypto, state)
          cleanup(crypto, state, keep)
        } finally {
          clear.fill(0)
        }
      }
    }

  suspend fun restore(walletId: String): Map<String, Any> {
    action("restoring") {
      store.load().use { record ->
        check(record.id == walletId)
        WalletRecoveryCrypto(record.entropy).use { crypto ->
          val state = state(crypto)
          val root =
            remote.get(crypto.locator, crypto.token)
              ?: throw WalletRecoveryFailure("RECOVERY_MISSING")
          if (root.revision < state.getLong("revision"))
            throw WalletRecoveryFailure("RECOVERY_ROLLBACK")
          val manifestBytes = crypto.decrypt(crypto.locator, root.revision, root.ciphertext)
          val manifest =
            try {
              JSONObject(String(manifestBytes, Charsets.UTF_8))
            } finally {
              manifestBytes.fill(0)
            }
          check(manifest.getInt("version") == 1)
          val size = manifest.getInt("size")
          require(size in 1..16 * 1024 * 1024)
          val pages = manifest.getJSONArray("pages")
          require(pages.length() == (size + 65535) / 65536)
          val clear = ByteArray(size)
          try {
            for (i in 0 until pages.length()) {
              currentCoroutineContext().ensureActive()
              val id = pages.getString(i)
              val page =
                remote.get(id, crypto.token) ?: throw WalletRecoveryFailure("RECOVERY_PAGE_MISSING")
              check(page.revision == 1L)
              val chunk = crypto.decrypt(id, 1, page.ciphertext)
              require(chunk.size == minOf(65536, size - i * 65536))
              chunk.copyInto(clear, i * 65536)
              chunk.fill(0)
            }
            check(digest(clear) == manifest.getString("digest"))
            val snapshot = JSONObject(String(clear, Charsets.UTF_8))
            check(snapshot.getInt("version") == 1)
            // Preserve exact evidence before publishing catalogue changes. Neither operation grants
            // authority.
            store.markRecoveryRequired(record)
            retainHistory(record, snapshot.getJSONArray("history"))
            store.mergeRecovery(snapshot.getJSONObject("metadata"))
            if (reconcileRestored())
              store.load().use { store.completeRecovery(it, discoveryResolved(it)) }
            state
              .put("revision", root.revision)
              .put("scanned", maxOf(state.getInt("scanned"), snapshot.getInt("scanned")))
              .put("target", maxOf(state.getInt("target"), snapshot.getInt("target")))
              .put("count", maxOf(state.getInt("count"), snapshot.getInt("count")))
              .remove("fingerprint")
            save(crypto, state)
            cleanup(crypto, state, pageSets(manifest).flatten().toSet())
            message =
              if (store.load().use { it.earnRecoveryRequired }) "RECOVERY_RECONCILIATION_REQUIRED"
              else null
          } finally {
            clear.fill(0)
          }
        }
      }
    }
    return status(walletId)
  }

  fun cancel(walletId: String): Map<String, Any> {
    cancelled = true
    discoveryJob?.cancel()
    phase = "paused"
    message = "CANCELLED"
    return status(walletId)
  }

  suspend fun discover(walletId: String, throughCycle: Int): Map<String, Any> {
    require(throughCycle in 0..1_000_000)
    action("discovering") {
      cancelled = false
      discoveryJob = currentCoroutineContext()[kotlinx.coroutines.Job]
      store.load().use { record ->
        check(record.id == walletId && record.verified)
        WalletRecoveryCrypto(record.entropy).use { crypto ->
          val state = state(crypto)
          require(throughCycle >= state.getInt("scanned"))
          state.put("target", maxOf(state.getInt("target"), throughCycle))
          save(crypto, state)
          // Each invocation has an explicit work budget; repeat to continue the durable cursor.
          repeat(1) {
            currentCoroutineContext().ensureActive()
            if (cancelled || state.getInt("scanned") >= throughCycle) return@repeat
            val cycle = state.getInt("scanned") + 1
            val oldOffset = state.optInt("chainOffset", 0)
            val completed =
              state.optJSONArray("completedChains")
                ?: JSONArray().put(oldOffset > 0).put(oldOffset > 1)
            val counts =
              state.optJSONArray("chainCounts")
                ?: JSONArray().put(state.optInt("cycleCount", 0)).put(0)
            for (offset in 0..1) {
              if (cancelled) break
              if (completed.getBoolean(offset)) continue
              try {
                counts.put(offset, observeCycle(record, if (offset == 0) 1 else 4663, cycle))
                completed.put(offset, true)
                state.put("completedChains", completed).put("chainCounts", counts)
                save(crypto, state)
              } catch (e: RpcFailure) {
                // An unavailable private provider cannot hide the other chain's public balances.
                message = "DISCOVERY_MORE_REMAINING"
              } catch (e: EarnGatewayFailure) {
                message = "DISCOVERY_MORE_REMAINING"
              }
            }
            if (completed.getBoolean(0) && completed.getBoolean(1)) {
              state
                .put("scanned", cycle)
                .put(
                  "count",
                  Math.addExact(
                    state.getInt("count"),
                    Math.addExact(counts.getInt(0), counts.getInt(1)),
                  ),
                )
                .put("chainOffset", 0)
                .put("cycleCount", 0)
              state.remove("completedChains")
              state.remove("chainCounts")
              save(crypto, state)
            }
          }
          if (cancelled || state.getInt("scanned") < throughCycle) phase = "paused"
          message =
            if (state.getInt("scanned") >= throughCycle) "DISCOVERY_BOUND_REACHED"
            else "DISCOVERY_MORE_REMAINING"
        }
      }
    }
    // action normally sets ready, but a budget-limited scan is explicitly paused.
    val result = status(walletId)
    if (cancelled || (result["scannedThroughCycle"] as Int) < throughCycle) phase = "paused"
    return status(walletId)
  }
}
