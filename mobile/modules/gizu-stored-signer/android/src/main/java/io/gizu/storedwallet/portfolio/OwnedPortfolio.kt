package io.gizu.storedwallet.portfolio

import android.content.Context
import io.gizu.storedwallet.*
import io.gizu.storedwallet.swap.SwapPortfolioStore
import java.math.BigInteger
import java.security.MessageDigest
import javax.crypto.SecretKey
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.deriveEarnCycleAddresses

internal fun ownedEarnCycleAddresses(record: WalletRecord, chain: Long, cycle: Int): List<String> {
  val row =
    JSONArray(record.earnCycles).objects().singleOrNull {
      it.getInt("cycleIndex") == cycle && it.getLong("chainId") == chain
    }
  return if (row?.has("distribution") == true)
    recordForCycle(record, row).use { cycleAddresses(it) }
  else deriveEarnCycleAddresses(record.entropy, chain.toULong(), cycle.toUInt())
}

/**
 * Only aggregated public observations cross the native boundary. Owners and cursors stay encrypted.
 */
internal class NativeOwnedPortfolio(
  private val file: (String) -> WalletFile,
  private val key: () -> SecretKey,
  private val rpc: (Long) -> PortfolioRpc,
  private val deriveCycle: (WalletRecord, Long, Int) -> List<String> = ::ownedEarnCycleAddresses,
  private val derivePublic: (WalletRecord, Int) -> String,
  private val targets: (WalletRecord) -> List<String>,
  private val clock: () -> Long = System::currentTimeMillis,
  private val selector: (String) -> String = { earnEventTopic(it).take(10) },
  private val rpcBudget: () -> PortfolioReadBudget = { PortfolioReadBudget() },
  private val discoveredOwners: (WalletRecord, Long) -> List<String> = { _, _ -> emptyList() },
) {
  constructor(
    context: Context
  ) : this(
    file = { AndroidWalletFile(context, it, limit = 3 * 1024 * 1024) },
    key = { checkNotNull(AndroidWalletKeys().existing()) },
    rpc = {
      NativePortfolioRpc(
        when (it) {
          1L -> "https://ethereum-rpc.publicnode.com"
          143L -> "https://rpc.monad.xyz"
          4663L -> "https://rpc.mainnet.chain.robinhood.com"
          else -> error("Unsupported portfolio chain")
        }
      )
    },
    deriveCycle = ::ownedEarnCycleAddresses,
    derivePublic = ::publicAccountAddress,
    targets = { SwapPortfolioStore(context, it).targets() },
    discoveredOwners = { record, chain ->
      WalletDiscoveryRegistry(context, record).owners(chain.toInt(), false).map { it.second }
    },
  )

  private data class Group(
    val chain: Long,
    val token: String,
    val symbol: String,
    val decimals: Int?,
    val owners: List<String>,
    val underlying: String? = null,
  )

  private data class Rate(
    val atoms: BigInteger,
    val decimals: Int,
    val checkedAt: Long,
    val stale: Boolean,
    val block: String,
  )

  private fun groupKey(chain: Long, token: String) = "$chain:${token.lowercase()}"

  private fun digest(value: String) =
    MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") {
      "%02x".format(it)
    }

  private fun addresses(values: JSONArray) = (0 until values.length()).map { values.getString(it) }

  private fun fresh(checked: Long, now: Long) = now - checked in 0 until TTL

  private fun quantity(value: String): BigInteger {
    require(value.matches(Regex("0x[0-9a-fA-F]+")))
    return BigInteger(value.drop(2), 16).also { require(it.bitLength() <= 256) }
  }

  private fun word(value: Any): BigInteger {
    val text = value.toString()
    require(text.matches(Regex("0x[0-9a-fA-F]{64}")))
    return BigInteger(text.drop(2), 16)
  }

  private fun load(record: WalletRecord): JSONObject {
    val cache = file("gizu-owned-${record.journalId}.enc")
    if (!cache.exists())
      return JSONObject()
        .put("version", 1)
        .put("snapshots", JSONObject())
        .put("metadata", JSONObject())
        .put("rates", JSONObject())
        .put("native", JSONObject())
    val clear = CryptoEnvelope.decrypt(key(), cache.read(), aad(record))
    try {
      return JSONObject(String(clear, Charsets.UTF_8)).also { check(it.getInt("version") == 1) }
    } finally {
      clear.fill(0)
    }
  }

  private fun save(record: WalletRecord, root: JSONObject) {
    val clear = root.toString().toByteArray()
    check(clear.size < 3 * 1024 * 1024)
    try {
      file("gizu-owned-${record.journalId}.enc")
        .write(CryptoEnvelope.encrypt(key(), clear, aad(record)))
    } finally {
      clear.fill(0)
    }
  }

  private fun aad(record: WalletRecord) = "gizu-owned:v1:${record.journalId}".toByteArray()

  private fun owners(record: WalletRecord, root: JSONObject): JSONObject {
    val fingerprint =
      digest(
        "${record.roleRegistry}|${record.earnCycles}|${record.earnChain}|${record.earnCycleIndex}|${listOf(1L, 4663L).flatMap { discoveredOwners(record, it) }}"
      )
    if (root.optString("catalogue") == fingerprint) return root.getJSONObject("owners")
    val cycles = JSONArray(record.earnCycles)
    val rows = (0 until cycles.length()).map { cycles.getJSONObject(it) }.toMutableList()
    if (rows.isEmpty() && record.earnChain != 0)
      rows.add(JSONObject().put("cycleIndex", 0).put("chainId", record.earnChain))
    // The current investment is first in the bounded native gas refresh.
    val ordered = rows.sortedByDescending { it.getInt("cycleIndex") == record.earnCycleIndex }
    val result =
      JSONObject()
        .put(
          "public",
          JSONArray(publicAccountIndices(record).map { derivePublic(record, it).lowercase() }),
        )
    for (chain in listOf(1L, 4663L)) {
      val all =
        (ordered
            .filter { it.getLong("chainId") == chain }
            .flatMap { deriveCycle(record, chain, it.getInt("cycleIndex")) } +
            discoveredOwners(record, chain))
          .map(String::lowercase)
          .distinct()
      require(all.all { it.matches(Regex("0x[0-9a-f]{40}")) })
      result.put(chain.toString(), JSONArray(all))
    }
    root.put("catalogue", fingerprint).put("owners", result)
    return result
  }

  /** Invalidate affected assets only; old observations remain visible as stale. */
  fun invalidateTokens(record: WalletRecord, chain: Long, tokens: Set<String>) {
    require(chain in setOf(1L, 143L, 4663L) && tokens.size <= 256)
    val normalized = tokens.map(String::lowercase).toSet()
    require(normalized.all { it == "native" || it.matches(Regex("0x[0-9a-f]{40}")) })
    if (normalized.isEmpty()) return
    val root = load(record)
    val catalogue = owners(record, root)
    // Token groups are subsets of these owners. Invalidating all possible shards
    // also covers grouped stable assets and vaults without exposing their owners.
    val candidates =
      addresses(catalogue.getJSONArray("public")) +
        (catalogue.optJSONArray(chain.toString())?.let(::addresses) ?: emptyList())
    val shardCount = maxOf(1, (candidates.distinct().size + 8191) / 8192)
    for (token in normalized) {
      if (token == "native") {
        val native = root.getJSONObject("native")
        native
          .keys()
          .asSequence()
          .filter { it.startsWith("$chain:") }
          .toList()
          .forEach { native.getJSONObject(it).put("invalidated", true) }
        continue
      }
      val id = groupKey(chain, token)
      root
        .getJSONObject("snapshots")
        .optJSONObject(id)
        ?.put("complete", false)
        ?.put("syncPending", true)
      for (index in 0 until shardCount) {
        TokenBalanceSync(
            file("gizu-owned-token-${record.journalId}-${digest(id)}-$index.enc"),
            key,
            record.journalId,
            chain,
            token,
            rpc(chain),
          )
          .invalidate()
      }
    }
    save(record, root)
  }

  suspend fun read(record: WalletRecord): Map<String, Any?> {
    val now = clock()
    val root = load(record)
    val owners = owners(record, root)
    val public = addresses(owners.getJSONArray("public"))
    val eth = addresses(owners.getJSONArray("1"))
    val hood = addresses(owners.getJSONArray("4663"))
    val groups = mutableListOf<Group>()
    // Cash is observed before vault metadata and gas so an unavailable Earn chain cannot
    // consume the display budget before Robinhood USDG gets its first observation.
    groups.add(Group(4663, HOOD_EARN_USDG, "USDG", 6, (hood + public).distinct()))
    if (eth.isNotEmpty()) {
      groups.add(Group(1, ETH_EARN_USDC, "USDC", 6, eth))
      groups.add(Group(1, ETH_EARN_WETH, "WETH", 18, eth))
      groups.add(Group(1, ETH_EARN_VAULT, "USDC", null, eth, ETH_EARN_USDC))
    }
    if (hood.isNotEmpty())
      groups.add(Group(4663, HOOD_EARN_VAULT, "USDG", null, hood, HOOD_EARN_USDG))
    val swapTargets = targets(record).map(String::lowercase).distinct()
    require(swapTargets.size <= 256 && swapTargets.all { it.matches(Regex("0x[0-9a-f]{40}")) })
    for (token in swapTargets) if (
      groups.none { it.chain == 4663L && it.token.equals(token, true) }
    )
      groups.add(Group(4663, token, "Token ${token.takeLast(6)}", null, public))
    // Independent token cursors are rotated; opening a large catalogue does not rescan every asset.
    val activeVault =
      groups.indexOfFirst { it.chain == record.earnChain.toLong() && it.underlying != null }
    val initial =
      if (JSONArray(record.earnCycles).length() > 0 && activeVault >= 0) activeVault else 0
    val start = root.optInt("readOffset", initial).mod(groups.size)
    val order = (groups.indices.drop(start) + groups.indices.take(start))
    val selected = order.take(TOKEN_GROUP_BUDGET).toSet()
    // Rotate work itself, including when every group fits the selection budget. A slow
    // provider must not always consume the deadline before a later vault is observed.
    root.put("readOffset", (start + 1) % groups.size)
    var calls = 0
    val rpcs = mutableMapOf<Long, PortfolioRpc>()
    val budget = rpcBudget()
    fun chainRpc(chain: Long): PortfolioRpc =
      rpcs.getOrPut(chain) {
        val upstream = budget.wrap(rpc(chain), chain)
        object : PortfolioRpc {
          override suspend fun call(method: String, params: JSONArray): Any {
            calls++
            return upstream.call(method, params)
          }

          override suspend fun calls(requests: List<Pair<String, JSONArray>>): List<Any> {
            calls += requests.size
            return upstream.calls(requests)
          }
        }
      }
    val assets = mutableListOf<Map<String, Any?>>()
    val positions = mutableListOf<Map<String, Any?>>()
    for (index in order) {
      val group = groups[index]
      val id = groupKey(group.chain, group.token)
      val snapshot =
        tokenSnapshot(record, root, group, now, index in selected, chainRpc(group.chain))
      val metadata = root.getJSONObject("metadata")
      var decimals =
        group.decimals ?: metadata.optJSONObject(id)?.optInt("decimals", -1)?.takeIf { it >= 0 }
      var rate: Rate? = null
      if (index in selected && group.underlying != null)
        rate = vaultRate(root, group, now, snapshot.block, chainRpc(group.chain))
      else if (group.underlying != null) rate = cachedRate(root, id, now, true)
      if (rate != null) decimals = rate.decimals
      if (
        decimals == null &&
          index in selected &&
          group.underlying == null &&
          snapshot.balances.isNotEmpty()
      ) {
        try {
          val sample = observationBlock(chainRpc(group.chain), group.chain, snapshot.sampleBlock)
          val block = sample.second
          decimals =
            word(
                chainRpc(group.chain)
                  .call(
                    "eth_call",
                    JSONArray()
                      .put(JSONObject().put("to", group.token).put("data", "0x313ce567"))
                      .put(block),
                  )
              )
              .intValueExact()
              .also { require(it in 0..36) }
          check(
            pinned(chainRpc(group.chain), sample.first).getString("blockHash") ==
              block.getString("blockHash")
          )
          metadata.put(id, JSONObject().put("decimals", decimals))
        } catch (e: CancellationException) {
          throw e
        } catch (failure: Exception) {
          PortfolioDiagnostics.event(
            PortfolioDiagnostics.Stage.TOKEN_METADATA,
            PortfolioDiagnostics.Reason.UNAVAILABLE,
            group.chain,
            failure = failure,
          )
          /* Amount remains an integer with unknown precision. */
        }
      }
      val observed =
        snapshot.balances.values.fold(BigInteger.ZERO) { sum, value -> sum + BigInteger(value) }
      val complete = snapshot.complete && !snapshot.syncPending
      val stale = snapshot.stale || !fresh(snapshot.checkedAt, now)
      val row =
        linkedMapOf<String, Any?>(
          "assetId" to id,
          "chainId" to group.chain,
          "token" to group.token.lowercase(),
          "symbol" to group.symbol,
          "decimals" to (if (group.underlying != null) 6 else decimals),
          "balanceAtoms" to observed.toString().takeIf { complete },
          "observedAtoms" to observed.toString(),
          "complete" to complete,
          "stale" to stale,
          "checkedAt" to snapshot.checkedAt,
          "valueUsdcAtoms" to null,
          "valuationUnavailable" to true,
          "observationFinality" to if (group.chain == 4663L) "latest" else "finalized",
        )
      if (group.underlying == null) {
        if (group.symbol == "USDC" && complete && !stale) {
          row["valueUsdcAtoms"] = observed.toString()
          row["valuationUnavailable"] = false
        }
        assets.add(row)
      } else {
        val converted =
          rate?.let { r ->
            snapshot.balances.values.fold(BigInteger.ZERO) { sum, shares ->
              sum + BigInteger(shares) * r.atoms / BigInteger.TEN.pow(r.decimals)
            }
          }
        row["shareDecimals"] = decimals
        row["shareAtoms"] = row["balanceAtoms"]
        row["underlyingAtoms"] = converted?.toString()?.takeIf { complete }
        row["observedUnderlyingAtoms"] = converted?.toString()
        row["underlyingToken"] = group.underlying.lowercase()
        row["conversionEstimated"] = true
        row["conversionCheckedAt"] = rate?.checkedAt
        row["conversionBlock"] = rate?.block
        row["stale"] = stale || rate == null || rate.stale
        if (group.symbol == "USDC" && complete && row["stale"] == false && converted != null) {
          row["valueUsdcAtoms"] = converted.toString()
          row["valuationUnavailable"] = false
        }
        positions.add(row)
      }
    }
    val displayOrder =
      groups.mapIndexed { index, group -> groupKey(group.chain, group.token) to index }.toMap()
    assets.sortBy { displayOrder[it["assetId"]] }
    positions.sortBy { displayOrder[it["assetId"]] }
    assets.addAll(nativeAssets(root, public, eth, hood, record.earnChain.toLong(), now, ::chainRpc))
    val all = assets + positions
    save(record, root)
    return mapOf(
      "ownedAssets" to assets,
      "positions" to positions,
      "ownedCheckedAt" to all.mapNotNull { it["checkedAt"] as? Long }.minOrNull(),
      "ownedStale" to all.any { it["stale"] != false },
      "ownedBalanceComplete" to all.all { it["complete"] == true },
      "ownedSyncPending" to all.any { it["complete"] != true },
      "valuationComplete" to false,
      "ownedRpcCallCount" to calls,
    )
  }

  private suspend fun tokenSnapshot(
    record: WalletRecord,
    root: JSONObject,
    group: Group,
    now: Long,
    refresh: Boolean,
    rpc: PortfolioRpc,
  ): TokenSnapshot {
    val id = groupKey(group.chain, group.token)
    val snapshots = root.getJSONObject("snapshots")
    val saved = snapshots.optJSONObject(id)
    fun cached(): TokenSnapshot {
      val values = saved?.optJSONObject("balances")
      val balances =
        if (group.underlying == null && saved?.has("observed") == true)
          mapOf("aggregate" to saved.getString("observed"))
        else
          group.owners
            .mapNotNull { a -> if (values?.has(a) == true) a to values.getString(a) else null }
            .toMap()
      val covered =
        if (group.underlying == null)
          saved?.optString("owners") == digest(group.owners.sorted().joinToString(","))
        else balances.size == group.owners.size
      val complete = covered && saved?.optBoolean("complete") == true
      return TokenSnapshot(
        balances,
        saved?.optString("block", "0x0") ?: "0x0",
        saved?.optLong("checkedAt", 0) ?: 0,
        complete,
        true,
        !complete || saved?.optBoolean("syncPending") == true,
        saved?.optString("sampleBlock", saved.optString("block", "0x0")) ?: "0x0",
      )
    }
    if (!refresh)
      return cached().let { it.copy(stale = it.syncPending || !fresh(it.checkedAt, now)) }
    try {
      // A recipient registry may exceed one RPC-index shard when historic Earn owners are added.
      val chunks = group.owners.chunked(8192)
      val refreshShard = root.optInt("shard:$id", 0).mod(chunks.size)
      val shards =
        chunks.mapIndexed { index, addresses ->
          val sync =
            TokenBalanceSync(
              file("gizu-owned-token-${record.journalId}-${digest(id)}-$index.enc"),
              key,
              record.journalId,
              group.chain,
              group.token,
              rpc,
            )
          if (index == refreshShard) sync.read(addresses, now)
          else
            sync.cachedSnapshot(addresses, now)
              ?: TokenSnapshot(emptyMap(), "0x0", 0, false, true, true)
        }
      root.put("shard:$id", (refreshShard + 1) % chunks.size)
      val balances = shards.flatMap { it.balances.entries }.associate { it.toPair() }
      val result =
        TokenSnapshot(
          balances,
          shards.minByOrNull { quantity(it.block) }?.block ?: "0x0",
          shards.minOfOrNull { it.checkedAt } ?: now,
          shards.all { it.complete },
          shards.any { it.stale },
          shards.any { it.syncPending },
          shards.minByOrNull { quantity(it.sampleBlock) }?.sampleBlock ?: "0x0",
        )
      val summary =
        JSONObject()
          .put("block", result.block)
          .put("sampleBlock", result.sampleBlock)
          .put("checkedAt", result.checkedAt)
          .put("complete", result.complete)
          .put("syncPending", result.syncPending)
      if (group.underlying != null) summary.put("balances", JSONObject(balances))
      else
        summary
          .put(
            "observed",
            balances.values
              .fold(BigInteger.ZERO) { sum, value -> sum + BigInteger(value) }
              .toString(),
          )
          .put("owners", digest(group.owners.sorted().joinToString(",")))
      snapshots.put(id, summary)
      return result
    } catch (e: CancellationException) {
      throw e
    } catch (failure: Exception) {
      PortfolioDiagnostics.event(
        PortfolioDiagnostics.Stage.OWNED_TOKEN,
        PortfolioDiagnostics.Reason.CACHE_STALE,
        group.chain,
        failure = failure,
      )
      return cached()
    }
  }

  private suspend fun pinned(rpc: PortfolioRpc, number: String): JSONObject {
    val header = rpc.call("eth_getBlockByNumber", JSONArray().put(number).put(false)) as JSONObject
    check(quantity(header.getString("number")) == quantity(number))
    val hash = header.getString("hash")
    require(hash.matches(Regex("0x[0-9a-fA-F]{64}")))
    return JSONObject().put("blockHash", hash).put("requireCanonical", true)
  }

  private suspend fun observationBlock(
    rpc: PortfolioRpc,
    chain: Long,
    number: String,
  ): Pair<String, JSONObject> {
    if (chain != 4663L) return number to pinned(rpc, number)
    val header =
      rpc.call("eth_getBlockByNumber", JSONArray().put("latest").put(false)) as JSONObject
    val current = header.getString("number")
    quantity(current)
    val hash = header.getString("hash")
    require(hash.matches(Regex("0x[0-9a-fA-F]{64}")))
    return current to JSONObject().put("blockHash", hash).put("requireCanonical", true)
  }

  private fun cachedRate(
    root: JSONObject,
    id: String,
    now: Long,
    unrefreshed: Boolean = false,
  ): Rate? =
    root.getJSONObject("rates").optJSONObject(id)?.let {
      Rate(
        BigInteger(it.getString("atoms")),
        it.getInt("decimals"),
        it.getLong("checkedAt"),
        unrefreshed && !fresh(it.getLong("checkedAt"), now),
        it.getString("block"),
      )
    }

  private suspend fun vaultRate(
    root: JSONObject,
    group: Group,
    now: Long,
    number: String,
    rpc: PortfolioRpc,
  ): Rate? {
    val id = groupKey(group.chain, group.token)
    val old = cachedRate(root, id, now)
    if (old != null && fresh(old.checkedAt, now)) return old
    try {
      val sample = observationBlock(rpc, group.chain, number)
      val block = sample.second
      val metadata = root.getJSONObject("metadata")
      var decimals = metadata.optJSONObject(id)?.optInt("decimals", -1) ?: -1
      if (decimals < 0) {
        val asset =
          word(
            rpc.call(
              "eth_call",
              JSONArray()
                .put(JSONObject().put("to", group.token).put("data", "0x38d52e0f"))
                .put(block),
            )
          )
        check(asset == BigInteger(group.underlying!!.drop(2), 16))
        decimals =
          word(
              rpc.call(
                "eth_call",
                JSONArray()
                  .put(JSONObject().put("to", group.token).put("data", "0x313ce567"))
                  .put(block),
              )
            )
            .intValueExact()
        require(decimals in 0..36)
        metadata.put(id, JSONObject().put("decimals", decimals))
      }
      val amount = BigInteger.TEN.pow(decimals)
      val converted =
        word(
          rpc.call(
            "eth_call",
            JSONArray()
              .put(
                JSONObject()
                  .put("to", group.token)
                  .put(
                    "data",
                    selector("convertToAssets(uint256)") + amount.toString(16).padStart(64, '0'),
                  )
              )
              .put(block),
          )
        )
      check(pinned(rpc, sample.first).getString("blockHash") == block.getString("blockHash"))
      root
        .getJSONObject("rates")
        .put(
          id,
          JSONObject()
            .put("atoms", converted.toString())
            .put("decimals", decimals)
            .put("checkedAt", now)
            .put("block", sample.first),
        )
      return Rate(converted, decimals, now, false, sample.first)
    } catch (e: CancellationException) {
      throw e
    } catch (failure: Exception) {
      PortfolioDiagnostics.event(
        PortfolioDiagnostics.Stage.VAULT_RATE,
        PortfolioDiagnostics.Reason.UNAVAILABLE,
        group.chain,
        failure = failure,
      )
      return old?.copy(stale = true)
    }
  }

  private suspend fun nativeAssets(
    root: JSONObject,
    public: List<String>,
    eth: List<String>,
    hood: List<String>,
    activeChain: Long,
    now: Long,
    rpc: (Long) -> PortfolioRpc,
  ): List<Map<String, Any?>> {
    val groups =
      listOf(Triple(1L, "ETH", eth), Triple(143L, "MON", public), Triple(4663L, "ETH", hood))
    val accounts = groups.flatMap { (chain, _, owners) -> owners.map { chain to it } }.distinct()
    val cache = root.getJSONObject("native")
    if (accounts.isNotEmpty()) {
      val offset = root.optInt("nativeOffset", 0).mod(accounts.size)
      val rotated = (accounts.drop(offset) + accounts.take(offset))
      // Current I has priority, followed by the ordinary rotating reconciliation.
      val current = if (activeChain == 4663L) hood else eth
      val priorities =
        listOfNotNull(
          current.getOrNull(1)?.let { (if (activeChain == 4663L) 4663L else 1L) to it },
          public.getOrNull(1)?.let { 143L to it },
        )
      val pending =
        (priorities + rotated)
          .distinct()
          .filter { a ->
            !fresh(
              cache.optJSONObject(groupKey(a.first, a.second))?.optLong("checkedAt", 0) ?: 0,
              now,
            ) || cache.optJSONObject(groupKey(a.first, a.second))?.optBoolean("invalidated") == true
          }
          .take(NATIVE_READ_BUDGET)
      root.put("nativeOffset", (offset + NATIVE_READ_BUDGET) % accounts.size)
      val blocks = mutableMapOf<Long, JSONObject>()
      for ((chain, address) in pending) try {
        val block = blocks.getOrPut(chain) { JSONObject() }
        if (block.length() == 0) {
          check(
            quantity(rpc(chain).call("eth_chainId", JSONArray()).toString()) ==
              BigInteger.valueOf(chain)
          )
          val header =
            rpc(chain)
              .call(
                "eth_getBlockByNumber",
                JSONArray().put(if (chain == 4663L) "latest" else "finalized").put(false),
              ) as JSONObject
          block.put("number", header.getString("number")).put("hash", header.getString("hash"))
          require(block.getString("hash").matches(Regex("0x[0-9a-fA-F]{64}")))
        }
        val amount =
          quantity(
            rpc(chain)
              .call(
                "eth_getBalance",
                JSONArray()
                  .put(address)
                  .put(
                    JSONObject()
                      .put("blockHash", block.getString("hash"))
                      .put("requireCanonical", true)
                  ),
              )
              .toString()
          )
        check(
          pinned(rpc(chain), block.getString("number")).getString("blockHash") ==
            block.getString("hash")
        )
        cache.put(
          groupKey(chain, address),
          JSONObject().put("atoms", amount.toString()).put("checkedAt", now),
        )
      } catch (e: CancellationException) {
        throw e
      } catch (failure: Exception) {
        PortfolioDiagnostics.event(
          PortfolioDiagnostics.Stage.NATIVE_BALANCE,
          PortfolioDiagnostics.Reason.CACHE_STALE,
          chain,
          failure = failure,
        )
        /* Cached observations remain visibly stale. */
      }
    }
    return groups
      .filter { it.third.isNotEmpty() }
      .map { (chain, symbol, owners) ->
        val observations = owners.mapNotNull { cache.optJSONObject(groupKey(chain, it)) }
        val observed =
          observations.fold(BigInteger.ZERO) { sum, value ->
            sum + BigInteger(value.getString("atoms"))
          }
        val complete = observations.size == owners.size
        mapOf(
          "assetId" to "$chain:native",
          "chainId" to chain,
          "token" to "native",
          "symbol" to symbol,
          "decimals" to 18,
          "balanceAtoms" to observed.toString().takeIf { complete },
          "observedAtoms" to observed.toString(),
          "complete" to complete,
          "stale" to
            (!complete ||
              observations.any {
                it.optBoolean("invalidated") || !fresh(it.getLong("checkedAt"), now)
              }),
          "checkedAt" to (observations.minOfOrNull { it.getLong("checkedAt") } ?: 0L),
          "valueUsdcAtoms" to null,
          "valuationUnavailable" to true,
          "observationFinality" to if (chain == 4663L) "latest" else "finalized",
        )
      }
  }

  companion object {
    private const val TTL = 30_000L
    private const val TOKEN_GROUP_BUDGET = 6
    private const val NATIVE_READ_BUDGET = 8
  }
}
