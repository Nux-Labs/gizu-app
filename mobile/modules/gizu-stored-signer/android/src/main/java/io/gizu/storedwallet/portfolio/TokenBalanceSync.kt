package io.gizu.storedwallet.portfolio

import io.gizu.storedwallet.*
import java.math.BigInteger
import javax.crypto.SecretKey
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject

internal interface PortfolioRpc {
  suspend fun call(method: String, params: JSONArray): Any

  suspend fun calls(requests: List<Pair<String, JSONArray>>): List<Any> =
    requests.map { call(it.first, it.second) }
}

internal class NativePortfolioRpc(endpoint: String, post: (suspend (String) -> String)? = null) :
  PortfolioRpc {
  private val chainId =
    when (endpoint) {
      "https://rpc.monad.xyz" -> 143L
      "https://rpc.mainnet.chain.robinhood.com" -> 4663L
      "https://ethereum-rpc.publicnode.com" -> 1L
      else -> null
    }
  private val transport = NativeRpcTransport(endpoint)
  private val send: suspend (String) -> String = post ?: { transport.post(it) }

  override suspend fun call(method: String, params: JSONArray): Any {
    val response =
      JSONObject(
        send(
          JSONObject()
            .put("jsonrpc", "2.0")
            .put("id", 1)
            .put("method", method)
            .put("params", params)
            .toString()
        )
      )
    response.optJSONObject("error")?.let {
      PortfolioDiagnostics.event(
        PortfolioDiagnostics.Stage.RPC,
        PortfolioDiagnostics.rpcReason(it),
        chain = chainId,
        method = method,
        status = it.optInt("code"),
      )
    }
    check(
      response.get("id") is Number &&
        response.get("id").toString() == "1" &&
        response.optString("jsonrpc") == "2.0" &&
        !response.has("error") &&
        !response.isNull("result")
    )
    return response.get("result")
  }

  override suspend fun calls(requests: List<Pair<String, JSONArray>>): List<Any> {
    require(requests.size <= 80)
    return requests.chunked(40).flatMap { chunk ->
      val body =
        JSONArray(
          chunk.mapIndexed { i, (method, params) ->
            JSONObject()
              .put("jsonrpc", "2.0")
              .put("id", i + 1)
              .put("method", method)
              .put("params", params)
          }
        )
      val response = JSONArray(send(body.toString()))
      check(response.length() == chunk.size)
      val results = mutableMapOf<Int, Any>()
      for (i in 0 until response.length()) {
        val row = response.getJSONObject(i)
        row.optJSONObject("error")?.let {
          PortfolioDiagnostics.event(
            PortfolioDiagnostics.Stage.RPC,
            PortfolioDiagnostics.rpcReason(it),
            chain = chainId,
            method = "batch",
            status = it.optInt("code"),
          )
        }
        val rawId = row.get("id")
        val id = rawId.toString().toIntOrNull()
        check(
          rawId is Number &&
            row.optString("jsonrpc") == "2.0" &&
            id != null &&
            id in 1..chunk.size &&
            !results.containsKey(id) &&
            !row.has("error") &&
            !row.isNull("result")
        )
        results[id] = row.get("result")
      }
      (1..chunk.size).map { checkNotNull(results[it]) }
    }
  }
}

internal data class TokenSnapshot(
  val balances: Map<String, String>,
  val block: String,
  val checkedAt: Long,
  val complete: Boolean,
  val stale: Boolean,
  val syncPending: Boolean,
  val sampleBlock: String = block,
)

/**
 * Device-only incremental index. Log topics/balance calls are ordinary native RPC, not a server
 * catalogue.
 */
internal class TokenBalanceSync(
  private val file: WalletFile,
  private val key: () -> SecretKey,
  walletId: String,
  private val chainId: Long,
  private val token: String,
  private val rpc: PortfolioRpc,
  private val decodeBalance: (String) -> String = { quantity(it).toString() },
) {
  private val aad = "gizu-token-snapshot:v1:$walletId:$chainId:${token.lowercase()}".toByteArray()

  private fun load(): JSONObject? {
    if (!file.exists()) return null
    val clear = CryptoEnvelope.decrypt(key(), file.read(), aad)
    try {
      return JSONObject(String(clear, Charsets.UTF_8)).also { check(it.getInt("version") == 1) }
    } finally {
      clear.fill(0)
    }
  }

  private fun save(root: JSONObject) {
    val clear = root.toString().toByteArray()
    check(clear.size < 3 * 1024 * 1024)
    try {
      file.write(CryptoEnvelope.encrypt(key(), clear, aad))
    } finally {
      clear.fill(0)
    }
  }

  private fun view(
    root: JSONObject,
    addresses: List<String>,
    stale: Boolean = false,
  ): TokenSnapshot {
    val values = root.getJSONObject("balances")
    val balances =
      addresses.mapNotNull { a -> if (values.has(a)) a to values.getString(a) else null }.toMap()
    val complete =
      balances.size == addresses.size &&
        root.optJSONArray("pending")?.length() == 0 &&
        !root.has("scan") &&
        !root.has("reconcile") &&
        !root.optBoolean("catchingUp") &&
        !root.optBoolean("invalidated")
    return TokenSnapshot(
      balances,
      root.optString("block", "0x0"),
      root.optLong("checkedAt", 0),
      complete,
      stale || !complete,
      !complete || root.optBoolean("catchingUp"),
      root.optString("sampleBlock", root.optString("block", "0x0")),
    )
  }

  /** Retain observations, but require canonical balances before calling them fresh again. */
  fun invalidate() {
    val root = load() ?: return
    val owners =
      root.optJSONArray("owners")
        ?: JSONArray(root.getJSONObject("balances").keys().asSequence().toList())
    val pending = root.getJSONArray("pending")
    val dirty =
      ((0 until pending.length()).map(pending::getString) +
          (0 until owners.length()).map(owners::getString))
        .distinct()
    root.put("pending", JSONArray(dirty)).put("invalidated", true)
    save(root)
  }

  fun cachedSnapshot(rawAddresses: List<String>, now: Long): TokenSnapshot? {
    val addresses = rawAddresses.map(String::lowercase).distinct()
    require(addresses.size <= 8192 && addresses.all { it.matches(Regex("0x[0-9a-f]{40}")) })
    val root = load() ?: return null
    val snapshot = view(root, addresses, now - root.getLong("checkedAt") !in 0 until 30_000)
    val previous =
      root.optJSONArray("owners")?.let { rows ->
        (0 until rows.length()).map { rows.getString(it) }.toSet()
      }
    return if (previous != null && addresses.any { it !in previous })
      snapshot.copy(complete = false, stale = true, syncPending = true)
    else snapshot
  }

  suspend fun read(rawAddresses: List<String>, now: Long): TokenSnapshot =
    withTimeoutOrNull(10_000L) { readAvailable(rawAddresses, now) }
      ?: cachedSnapshot(rawAddresses, now)?.copy(stale = true)
      ?: throw PortfolioReadTimeout()

  private suspend fun readAvailable(rawAddresses: List<String>, now: Long): TokenSnapshot {
    val addresses = rawAddresses.map(String::lowercase).distinct()
    require(addresses.size <= 8192 && addresses.all { it.matches(Regex("0x[0-9a-f]{40}")) })
    val old = load()
    val values = old?.getJSONObject("balances")
    PortfolioDiagnostics.event(
      PortfolioDiagnostics.Stage.TOKEN_CACHE,
      if (old == null) PortfolioDiagnostics.Reason.CACHE_EMPTY
      else PortfolioDiagnostics.Reason.STARTED,
      chainId,
    )
    if (
      old != null &&
        now - old.getLong("checkedAt") in 0 until 30_000 &&
        addresses.all { values!!.has(it) } &&
        (old.optJSONArray("owners")?.let { owners ->
          val previous = (0 until owners.length()).map { owners.getString(it) }.toSet()
          addresses.all { it in previous }
        } ?: true) &&
        !old.optBoolean("catchingUp") &&
        !old.optBoolean("invalidated") &&
        !old.has("scan") &&
        !old.has("reconcile") &&
        old.getJSONArray("pending").length() == 0
    )
      return view(old, addresses).also {
        PortfolioDiagnostics.event(
          PortfolioDiagnostics.Stage.TOKEN_CACHE,
          PortfolioDiagnostics.Reason.CACHE_FRESH,
          chainId,
        )
      }
    var stage = PortfolioDiagnostics.Stage.TOKEN_CHAIN
    try {
      check(
        quantity(rpc.call("eth_chainId", JSONArray()).toString()) == BigInteger.valueOf(chainId)
      )
      fun validHeader(header: JSONObject, number: BigInteger): String {
        check(quantity(header.getString("number")) == number)
        return header.getString("hash").also { check(it.matches(Regex("0x[0-9a-fA-F]{64}"))) }
      }
      // Robinhood's public endpoint prunes contract state at finalized heights. This mode is
      // strictly for display observations; execution and settlement retain their own gates.
      stage = PortfolioDiagnostics.Stage.TOKEN_HEAD
      val head =
        rpc.call(
          "eth_getBlockByNumber",
          JSONArray().put(if (chainId == 4663L) "latest" else "finalized").put(false),
        ) as JSONObject
      val headNumber = quantity(head.getString("number"))
      val headHash = validHeader(head, headNumber)
      val root =
        old?.let { JSONObject(it.toString()) }
          ?: JSONObject()
            .put("version", 1)
            .put("balances", JSONObject())
            .put("pending", JSONArray())
            .put("checkedAt", 0)
            .put("block", hex(headNumber))
            .put("blockHash", headHash)
            .put("reconcileAt", now)
            .put("reconcileOffset", 0)
      val stored = root.getJSONObject("balances")
      val pending = linkedSetOf<String>()
      root.getJSONArray("pending").let { p ->
        for (i in 0 until p.length()) if (p.getString(i) in addresses) pending.add(p.getString(i))
      }
      val previous =
        root.optJSONArray("owners")?.let { rows ->
          (0 until rows.length()).map { rows.getString(it) }.toSet()
        } ?: stored.keys().asSequence().toSet()
      addresses.filter { !stored.has(it) || it !in previous }.forEach(pending::add)
      suspend fun canonical(number: BigInteger): String {
        check(number <= headNumber)
        return validHeader(
          rpc.call("eth_getBlockByNumber", JSONArray().put(hex(number)).put(false)) as JSONObject,
          number,
        )
      }
      fun reconcile() {
        pending.addAll(addresses)
        root.remove("scan")
        root
          .put("reorg", true)
          .put("reconcile", JSONObject().put("block", hex(headNumber)).put("hash", headHash))
      }
      stage = PortfolioDiagnostics.Stage.TOKEN_CHECKPOINT
      val activeReconcile = root.optJSONObject("reconcile")
      if (activeReconcile != null) {
        val target = quantity(activeReconcile.getString("block"))
        if (target > headNumber || canonical(target) != activeReconcile.getString("hash"))
          reconcile()
      } else {
        val checkpoint = quantity(root.getString("block"))
        if (checkpoint > headNumber || canonical(checkpoint) != root.getString("blockHash"))
          reconcile()
        else
          root.optJSONObject("scan")?.let { scan ->
            val target = quantity(scan.getString("to"))
            if (target > headNumber || canonical(target) != scan.getString("hash")) reconcile()
          }
      }
      // Monad limits eth_getLogs to 100 blocks. After a longer absence, bounded
      // balance reconciliation catches up directly instead of replaying a long history.
      // This also replaces an oversized scan persisted by an earlier app version.
      if (
        chainId == 143L &&
          !root.has("reconcile") &&
          headNumber - quantity(root.getString("block")) > BigInteger.valueOf(100)
      ) {
        reconcile()
      }
      if (!root.has("reconcile") && !root.has("scan")) {
        val from = quantity(root.getString("block"))
        if (headNumber > from) {
          val to = headNumber.min(from + BigInteger.valueOf(if (chainId == 143L) 100 else 4096))
          root.put(
            "scan",
            JSONObject()
              .put("from", hex(from))
              .put("to", hex(to))
              .put("hash", if (to == headNumber) headHash else canonical(to))
              .put("owners", JSONArray(addresses))
              .put("offset", 0),
          )
        }
      }
      stage = PortfolioDiagnostics.Stage.TOKEN_LOGS
      val scan = root.optJSONObject("scan")
      if (scan != null) {
        check(scan.getString("from") == root.getString("block"))
        val watch = scan.getJSONArray("owners")
        check(watch.length() <= 8192)
        val offset = scan.getInt("offset")
        require(offset in 0..watch.length())
        val until = minOf(watch.length(), offset + 4 * 128)
        for (start in offset until until step 128) {
          val topics =
            JSONArray(
              (start until minOf(start + 128, watch.length())).map {
                "0x" + watch.getString(it).removePrefix("0x").padStart(64, '0')
              }
            )
          for (direction in listOf(1, 2)) {
            val filterTopics = JSONArray().put(TRANSFER)
            if (direction == 2) filterTopics.put(JSONObject.NULL)
            filterTopics.put(topics)
            val logs =
              rpc.call(
                "eth_getLogs",
                JSONArray()
                  .put(
                    JSONObject()
                      .put("address", token)
                      .put("fromBlock", hex(quantity(scan.getString("from")) + BigInteger.ONE))
                      .put("toBlock", scan.getString("to"))
                      .put("topics", filterTopics)
                  ),
              ) as JSONArray
            check(logs.length() <= 20_000)
            for (i in 0 until logs.length()) {
              val event = logs.getJSONObject(i)
              check(!event.optBoolean("removed") && event.getString("address").equals(token, true))
              val block = quantity(event.getString("blockNumber"))
              check(
                block > quantity(scan.getString("from")) && block <= quantity(scan.getString("to"))
              )
              val eventTopics = event.getJSONArray("topics")
              check(eventTopics.length() == 3 && eventTopics.getString(0).equals(TRANSFER, true))
              for (j in 1..2) {
                val topic = eventTopics.getString(j)
                check(topic.matches(Regex("0x0{24}[0-9a-fA-F]{40}")))
                val account = "0x" + topic.takeLast(40).lowercase()
                if (account in addresses) pending.add(account)
              }
            }
          }
        }
        scan.put("offset", until)
      }
      // Periodic rotating reads cover exceptional token behavior without another N-account scan.
      if (now - root.optLong("reconcileAt", now) >= 30 * 60_000L && addresses.isNotEmpty()) {
        val start = root.optInt("reconcileOffset", 0).coerceAtMost(addresses.lastIndex)
        val selected = addresses.drop(start).take(40)
        pending.addAll(selected)
        val next = start + selected.size
        root.put("reconcileOffset", if (next >= addresses.size) 0 else next)
        if (next >= addresses.size) root.put("reconcileAt", now)
      }
      val reconciliation = root.optJSONObject("reconcile")
      val readBlock =
        reconciliation?.getString("block") ?: scan?.getString("to") ?: root.getString("block")
      val readHash =
        reconciliation?.getString("hash") ?: scan?.getString("hash") ?: root.getString("blockHash")
      // A frozen log range may span several openings. Read pending owners at available current
      // state without advancing that range's checkpoint past any unscanned owner bucket.
      stage = PortfolioDiagnostics.Stage.TOKEN_SAMPLE
      val sample =
        if (chainId == 4663L)
          rpc.call("eth_getBlockByNumber", JSONArray().put("latest").put(false)) as JSONObject
        else null
      val sampleBlock = sample?.getString("number") ?: readBlock
      val sampleHash = sample?.let { validHeader(it, quantity(sampleBlock)) } ?: readHash
      stage = PortfolioDiagnostics.Stage.TOKEN_BALANCES
      // Small Robinhood catalogues fit the existing bounded balance budget. A full same-block
      // observation also covers transfers after the log scan's head, even as latest advances.
      if (chainId == 4663L && addresses.size in 1..80) pending.addAll(addresses)
      val sampledOwners = mutableSetOf<String>()
      for (chunk in pending.take(80).chunked(40)) {
        val requests =
          chunk.map { address ->
            "eth_call" to
              JSONArray()
                .put(
                  JSONObject()
                    .put("to", token)
                    .put("data", "0x70a08231" + address.removePrefix("0x").padStart(64, '0'))
                )
                .put(JSONObject().put("blockHash", sampleHash).put("requireCanonical", true))
          }
        val results = rpc.calls(requests)
        check(results.size == chunk.size)
        for ((index, address) in chunk.withIndex()) {
          stored.put(address, decodeBalance(results[index] as String))
          pending.remove(address)
          sampledOwners.add(address)
        }
      }
      stage = PortfolioDiagnostics.Stage.TOKEN_CANONICAL
      check(canonical(quantity(readBlock)) == readHash)
      if (sample != null)
        check(
          validHeader(
            rpc.call("eth_getBlockByNumber", JSONArray().put(sampleBlock).put(false)) as JSONObject,
            quantity(sampleBlock),
          ) == sampleHash
        )
      val scanned = scan == null || scan.getInt("offset") == scan.getJSONArray("owners").length()
      // All owners at one canonically rechecked sample supersede the earlier log checkpoint.
      // Partial catalogues retain the frozen scan; observing a subset must never skip transfers.
      val fullySampled =
        sample != null && addresses.isNotEmpty() && sampledOwners.size == addresses.size
      if (pending.isEmpty() && (fullySampled || scanned)) {
        root
          .put("block", if (fullySampled) sampleBlock else readBlock)
          .put("blockHash", if (fullySampled) sampleHash else readHash)
        root.remove("scan")
        root.remove("reconcile")
        root.remove("reorg")
        root.remove("invalidated")
      }
      root.put("sampleBlock", sampleBlock).put("sampleHash", sampleHash)
      root
        .put("owners", JSONArray(addresses))
        .put("pending", JSONArray(pending.toList()))
        .put("checkedAt", now)
        .put(
          "catchingUp",
          root.has("scan") ||
            root.has("reconcile") ||
            quantity(root.getString("block")) < headNumber.max(quantity(sampleBlock)),
        )
      stage = PortfolioDiagnostics.Stage.TOKEN_SAVE
      save(root)
      val reason =
        when {
          pending.isNotEmpty() -> PortfolioDiagnostics.Reason.BALANCE_PENDING
          root.has("scan") || root.has("reconcile") -> PortfolioDiagnostics.Reason.SCAN_PENDING
          quantity(root.getString("block")) < quantity(sampleBlock) ->
            PortfolioDiagnostics.Reason.SAMPLE_AHEAD
          root.optBoolean("catchingUp") -> PortfolioDiagnostics.Reason.SYNC_PENDING
          else -> PortfolioDiagnostics.Reason.READY
        }
      PortfolioDiagnostics.event(PortfolioDiagnostics.Stage.TOKEN_SYNC, reason, chainId)
      return view(root, addresses, root.optBoolean("reorg"))
    } catch (e: kotlinx.coroutines.CancellationException) {
      PortfolioDiagnostics.event(
        stage,
        PortfolioDiagnostics.Reason.CANCELLED,
        chainId,
        method = stageMethod(stage),
        failure = e,
      )
      throw e
    } catch (failure: Exception) {
      PortfolioDiagnostics.event(
        stage,
        PortfolioDiagnostics.Reason.UNAVAILABLE,
        chainId,
        method = stageMethod(stage),
        failure = failure,
      )
      if (old == null) throw IllegalStateException("Portfolio balance unavailable. Retry.")
      return view(old, addresses, true)
    }
  }

  companion object {
    private fun stageMethod(stage: PortfolioDiagnostics.Stage) =
      when (stage) {
        PortfolioDiagnostics.Stage.TOKEN_CHAIN -> "eth_chainId"
        PortfolioDiagnostics.Stage.TOKEN_HEAD,
        PortfolioDiagnostics.Stage.TOKEN_CHECKPOINT,
        PortfolioDiagnostics.Stage.TOKEN_SAMPLE,
        PortfolioDiagnostics.Stage.TOKEN_CANONICAL -> "eth_getBlockByNumber"
        PortfolioDiagnostics.Stage.TOKEN_LOGS -> "eth_getLogs"
        PortfolioDiagnostics.Stage.TOKEN_BALANCES -> "eth_call"
        else -> "none"
      }

    private const val TRANSFER =
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

    private fun quantity(value: String): BigInteger {
      require(value.matches(Regex("0x[0-9a-fA-F]+")))
      return BigInteger(value.substring(2), 16).also { require(it.bitLength() <= 256) }
    }

    private fun hex(value: BigInteger) = "0x" + value.toString(16)
  }
}
