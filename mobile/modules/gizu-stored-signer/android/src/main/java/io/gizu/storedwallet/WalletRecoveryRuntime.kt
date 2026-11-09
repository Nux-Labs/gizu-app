package io.gizu.storedwallet

import android.content.Context
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.walletDiscoveryCandidates

internal val walletRecoveryHistoryDomains =
  mapOf(
    "gizu-discovered-wallets" to "gizu-discovered-wallets",
    "gizu-operations" to "gizu-stored-operations",
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

/** The same authenticated portable export is used by runtime and restore roundtrip checks. */
internal fun exportWalletRecoveryHistory(
  walletId: String,
  generation: String,
  key: javax.crypto.SecretKey,
  names: List<String>,
  archived: JSONArray,
  read: (String) -> ByteArray,
): JSONArray {
  val result = JSONArray(archived.toString())
  for ((prefix, domain) in walletRecoveryHistoryDomains) {
    val selected =
      names
        .map { it.removeSuffix(".bak") }
        .distinct()
        .filter {
          it.startsWith("$prefix-$generation") && it.endsWith(".enc") && !it.contains(".page-")
        }
        .sorted()
    require(selected.size <= 4096)
    for (name in selected) {
      val clear =
        CryptoEnvelope.decrypt(key, read(name), "$domain:v1:$walletId:$generation".toByteArray())
      try {
        result.put(
          JSONObject()
            .put("name", name)
            .put("domain", domain)
            .put("generation", generation)
            .put("data", String(clear, Charsets.UTF_8))
        )
      } finally {
        clear.fill(0)
      }
    }
  }
  return result
}

/** Sole application wiring. All recovery credentials and portable records remain native. */
internal object WalletRecoveryRuntime {
  @Volatile private var context: Context? = null
  private var instance: WalletRecoveryEngine? = null

  fun initialize(context: Context) {
    this.context = context.applicationContext
  }

  @Synchronized
  fun engine(context: Context): WalletRecoveryEngine {
    initialize(context)
    return instance
      ?: WalletRecoveryEngine(
          walletStore(context),
          AndroidWalletFile(context, "gizu-wallet-recovery-state.enc", 64 * 1024),
          HttpWalletRecoveryRemote(),
          { record -> exportHistory(context, record) },
          { record, history -> retainHistory(context, record, history) },
          { record, chain, cycle -> observeCycle(context, record, chain, cycle) },
          { record -> WalletDiscoveryRegistry(context, record).count() },
          reconcileRestored = { reconcileRecoveredHistory(context, walletStore(context)) },
          historyFingerprint = { record -> historyFingerprint(context, record) },
          discoveryResolved = { record ->
            discoveredMetadataResolved(
              record,
              WalletDiscoveryRegistry(context, record).descriptors(),
            )
          },
        )
        .also { instance = it }
  }

  suspend fun beforeSubmission() {
    val app = context ?: throw WalletRecoveryFailure("RECOVERY_NOT_INITIALIZED")
    val wallet = walletStore(app).load().use { it.id }
    engine(app).sync(wallet)
  }

  suspend fun beforeFreshFunding(context: Context, walletId: String) {
    walletStore(context).load().use { check(it.id == walletId && !it.earnRecoveryRequired) }
    engine(context).sync(walletId)
  }

  private fun archiveFile(context: Context, record: WalletRecord) =
    AndroidWalletFile(context, "gizu-recovered-history-${record.journalId}.enc", 16 * 1024 * 1024)

  private fun archiveAad(record: WalletRecord) =
    "gizu-recovered-history:v1:${record.id}:${record.journalId}".toByteArray()

  private fun archived(context: Context, record: WalletRecord): JSONArray {
    val file = archiveFile(context, record)
    if (!file.exists()) return JSONArray()
    val clear =
      CryptoEnvelope.decrypt(
        checkNotNull(AndroidWalletKeys().existing()),
        file.read(),
        archiveAad(record),
      )
    try {
      return JSONArray(String(clear, Charsets.UTF_8))
    } finally {
      clear.fill(0)
    }
  }

  private fun exportHistory(context: Context, record: WalletRecord): JSONArray =
    exportWalletRecoveryHistory(
      record.id,
      record.journalId,
      checkNotNull(AndroidWalletKeys().existing()),
      context.noBackupFilesDir.listFiles().orEmpty().map { it.name },
      archived(context, record),
    ) { name ->
      AndroidWalletFile(context, name, 16 * 1024 * 1024).read()
    }

  /**
   * Encrypted root commitments are cheap to inspect; never decrypt execution history on status
   * polls.
   */
  private fun historyFingerprint(context: Context, record: WalletRecord): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val names =
      context.noBackupFilesDir
        .listFiles()
        .orEmpty()
        .filter { file ->
          file.name.endsWith(".enc") &&
            !file.name.contains(".page-") &&
            (walletRecoveryHistoryDomains.keys.any {
              file.name.startsWith("$it-${record.journalId}")
            } || file.name == "gizu-recovered-history-${record.journalId}.enc")
        }
        .sortedBy { it.name }
    require(names.size <= 32768)
    for (file in names) {
      digest.update(file.name.toByteArray())
      digest.update(file.length().toString().toByteArray())
      // The AEAD nonce changes on each logical commit; a paged file exposes its complete tiny root.
      file.inputStream().use { input ->
        val buffer = ByteArray(32768)
        val n = input.read(buffer)
        if (n > 0) digest.update(buffer, 0, n)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun retainHistory(context: Context, record: WalletRecord, history: JSONArray) {
    require(history.length() <= 32768)
    val retained = linkedMapOf<String, JSONObject>()
    for (source in listOf(archived(context, record), history)) for (i in 0 until source.length()) {
      val row = source.getJSONObject(i)
      require(
        row.getString("domain") in walletRecoveryHistoryDomains.values &&
          row.getString("data").toByteArray().size <= 16 * 1024 * 1024
      )
      val id =
        MessageDigest.getInstance("SHA-256").digest(row.toString().toByteArray()).joinToString("") {
          "%02x".format(it)
        }
      retained[id] = row
      if (row.getString("domain") == "gizu-discovered-wallets")
        WalletDiscoveryRegistry(context, record).merge(JSONObject(row.getString("data")))
    }
    val clear = JSONArray(retained.values.toList()).toString().toByteArray()
    try {
      archiveFile(context, record)
        .write(
          CryptoEnvelope.encrypt(
            checkNotNull(AndroidWalletKeys().existing()),
            clear,
            archiveAad(record),
          )
        )
    } finally {
      clear.fill(0)
    }
    importRecoveredHistory(
      context,
      record,
      JSONArray(retained.values.filter { it.getString("domain") != "gizu-discovered-wallets" }),
    )
  }

  private suspend fun observeCycle(
    context: Context,
    record: WalletRecord,
    chain: Int,
    cycle: Int,
  ): Int =
    withContext(Dispatchers.IO) {
      val candidates =
        JSONArray(walletDiscoveryCandidates(record.entropy, chain.toULong(), cycle.toUInt()))
      val rpc: TransferRpc = if (chain == 1) EthereumEarnRpc() else EarnSponsoredChainRpc(chain)
      check(quantity(rpc.call("eth_chainId", JSONArray()).toString()).toInt() == chain)
      val block = if (chain == 1) "finalized" else "latest"
      val tokens =
        if (chain == 1)
          listOf(ETH_EARN_USDC, "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", ETH_EARN_VAULT)
        else listOf(HOOD_EARN_USDG, HOOD_EARN_VAULT)
      val registry = WalletDiscoveryRegistry(context, record)
      val ordered =
        (0 until candidates.length()).map(candidates::getJSONObject).sortedBy {
          it.getString("role") == "confidential"
        }
      val progress = registry.progress(chain, cycle)
      var discovered = progress.second
      for (i in progress.first until ordered.size) {
        val row = ordered[i]
        var found = false
        val address = row.getString("address")
        require(address.matches(Regex("0x[0-9a-fA-F]{40}")))
        if (row.getString("role") == "confidential") {
          val provider = ConfidentialBalance()
          val salt = provider.salt()
          val random = ByteArray(7).also { java.security.SecureRandom().nextBytes(it) }
          val now = System.currentTimeMillis()
          val auth =
            recordForCycle(record, JSONObject().put("chainId", chain).put("cycleIndex", cycle))
              .use {
                cycleReadAuth(it, salt, random, now.toULong(), System.currentTimeMillis().toULong())
              }
          found = (provider.read(auth, address)["available"] as String).toBigInteger().signum() > 0
        } else {
          found =
            quantity(rpc.call("eth_getBalance", JSONArray().put(address).put(block)).toString())
              .signum() > 0
          for (token in tokens) {
            val value =
              rpc
                .call(
                  "eth_call",
                  JSONArray()
                    .put(
                      JSONObject()
                        .put("to", token)
                        .put("data", "0x70a08231" + address.drop(2).lowercase().padStart(64, '0'))
                    )
                    .put(block),
                )
                .toString()
            if (earnAbiWord(value).signum() > 0) found = true
          }
        }
        if (found) {
          discovered++
          val tracked =
            discoveredOwnerTracked(
              record,
              JSONObject(row.toString()).put("chainId", chain).put("cycleIndex", cycle),
            )
          walletStore(context).recordDiscovered(record, cycle, !tracked)
        }
        registry.observed(chain, cycle, i + 1, discovered, row, found)
      }
      discovered
    }
}
