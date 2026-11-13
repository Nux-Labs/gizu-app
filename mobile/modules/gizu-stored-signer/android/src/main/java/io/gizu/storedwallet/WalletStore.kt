package io.gizu.storedwallet

import java.io.*
import java.util.UUID
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject

internal const val INITIAL_ROLE_REGISTRY = """{"version":1,"nextRecipient":3}"""

internal fun requireRoleRegistry(value: String) {
  require(value.length in 1..1024)
  val p = JSONObject(value)
  require(p.length() == 2 && p.getInt("version") == 1 && p.getInt("nextRecipient") >= 3)
}

/** Secrets and the account catalogue never leave native encrypted storage. */
internal class WalletRecord(
  val id: String,
  val credential: StoredPasskey,
  val entropy: ByteArray,
  val verified: Boolean = false,
  val journalId: String = id,
  val roleRegistry: String = INITIAL_ROLE_REGISTRY,
  val earnChain: Int = 0,
  val earnRecoveryRequired: Boolean = false,
  val earnCycleIndex: Int = 0,
  val earnCycles: String = "[]",
  val discoveryHighWater: Int = -1,
  val discoveryRecoveryRequired: Boolean = false,
) : AutoCloseable {
  init {
    UUID.fromString(id)
    UUID.fromString(journalId)
    require(entropy.size == 32 && credential.credentialId.size in 1..1024)
    require(credential.publicKeyX.size == 32 && credential.publicKeyY.size == 32)
    requireRoleRegistry(roleRegistry)
    require(earnChain in listOf(0, 1, 4663) && earnCycleIndex in 0..1_000_000)
    require(discoveryHighWater in -1..1_000_000)
    val rows = JSONArray(earnCycles)
    require(earnCycles.toByteArray().size <= 8 * 1024 * 1024)
    val seen = mutableSetOf<Int>()
    for (i in 0 until rows.length()) {
      val row = rows.getJSONObject(i)
      require(row.getInt("cycleIndex") in 0..1_000_000 && seen.add(row.getInt("cycleIndex")))
      require(row.getInt("chainId") in listOf(1, 4663))
      if (row.has("privateAccount")) require(row.getString("privateAccount") == "shared")
      if (row.has("distribution")) {
        val weights = distributionWeights(row.getJSONObject("distribution"))
        if (row.has("distributionBudgetAtoms"))
          depositAtoms(row.getString("distributionBudgetAtoms"), true)
        if (row.has("investmentSlot"))
          require(
            row.getDouble("investmentSlot") == row.getInt("investmentSlot").toDouble() &&
              row.getInt("investmentSlot") in weights.indices
          )
        val withdrawals = row.optJSONObject("withdrawalIndices")
        withdrawals?.keys()?.asSequence()?.forEach { slot ->
          require(slot.toInt() in weights.indices)
          require(
            withdrawals.getInt(slot) in 3 until JSONObject(roleRegistry).getInt("nextRecipient")
          )
        }
      } else require(!row.has("investmentSlot") && !row.has("withdrawalIndices"))
      if (row.has("withdrawalIndex"))
        require(
          row.getInt("withdrawalIndex") in 3 until JSONObject(roleRegistry).getInt("nextRecipient")
        )
    }
  }

  override fun close() {
    entropy.fill(0)
  }

  fun publicState(): Map<String, Any> =
    mapOf("status" to if (verified) "ready" else "backupRequired", "walletId" to id)
}

internal interface WalletFile {
  fun exists(): Boolean

  fun read(): ByteArray

  fun write(bytes: ByteArray)
}

internal interface WalletKeys {
  fun existing(): SecretKey?

  fun create(): SecretKey

  fun reset(): SecretKey
}

internal class WalletStore(private val file: WalletFile, private val keys: WalletKeys) {
  private val aad = "io.gizu.storedwallet.v1:wallet:gizu.io:gizu-stored-evm-v1".toByteArray()

  companion object {
    private val lock = Any()
  }

  fun exists() = file.exists()

  fun state(): Map<String, Any> =
    try {
      if (!exists()) mapOf("status" to "absent") else load().use { it.publicState() }
    } catch (_: Exception) {
      mapOf("status" to "recoveryRequired")
    }

  fun load(): WalletRecord {
    check(exists())
    val key = keys.existing() ?: error("Missing storage key")
    val encrypted = file.read()
    require(encrypted.size in 1..16 * 1024 * 1024)
    val clear = CryptoEnvelope.decrypt(key, encrypted, aad)
    try {
      val version = DataInputStream(ByteArrayInputStream(clear)).readInt()
      require(version in 1..6)
      // Two released development branches used version 4 for different layouts.
      // Validate the entire record before accepting either historical encoding.
      if (version == 4) {
        try {
          return decode(clear, false)
        } catch (_: Exception) {
          return decode(clear, true)
        }
      }
      return decode(clear, version >= 5)
    } finally {
      clear.fill(0)
    }
  }

  private fun decode(clear: ByteArray, earnLayout: Boolean): WalletRecord =
    DataInputStream(ByteArrayInputStream(clear)).use { input ->
      val v = input.readInt()
      val verified = if (v >= 2) input.readBoolean() else false
      val id = input.readUTF()
      val generation = if (v >= 3) input.readUTF() else id
      val chain = if (earnLayout) input.readInt() else 0
      val recovery = if (earnLayout) input.readBoolean() else false
      val length = input.readInt()
      require(length in 1..1024)
      val credential =
        StoredPasskey(
          ByteArray(length).also(input::readFully),
          ByteArray(32).also(input::readFully),
          ByteArray(32).also(input::readFully),
        )
      val entropy = ByteArray(32)
      try {
        input.readFully(entropy)
        val registry =
          if (v >= 5 || v == 4 && !earnLayout) input.readUTF() else INITIAL_ROLE_REGISTRY
        val cycle = if (v >= 5) input.readInt() else 0
        val cycles =
          if (v >= 6) {
            val n = input.readInt()
            require(n in 2..8 * 1024 * 1024)
            String(ByteArray(n).also(input::readFully), Charsets.UTF_8)
          } else if (v >= 5) input.readUTF()
          else if (chain > 0) JSONArray().put(cycleRow(id, 0, chain)).toString() else "[]"
        val highWater = if (v >= 6) input.readInt() else -1
        val discoveryRecovery = if (v >= 6) input.readBoolean() else false
        require(input.available() == 0)
        WalletRecord(
          id,
          credential,
          entropy,
          verified,
          generation,
          registry,
          chain,
          recovery,
          cycle,
          cycles,
          highWater,
          discoveryRecovery,
        )
      } catch (e: Exception) {
        entropy.fill(0)
        throw e
      }
    }

  fun create(record: WalletRecord) =
    synchronized(lock) {
      check(!exists()) { "Existing wallet must not be overwritten" }
      save(record)
    }

  private fun replacement(
    current: WalletRecord,
    verified: Boolean = current.verified,
    registry: String = current.roleRegistry,
    chain: Int = current.earnChain,
    recovery: Boolean = current.earnRecoveryRequired,
    cycle: Int = current.earnCycleIndex,
    cycles: String = current.earnCycles,
    highWater: Int = current.discoveryHighWater,
    discoveryRecovery: Boolean = current.discoveryRecoveryRequired,
  ) =
    WalletRecord(
      current.id,
      current.credential,
      current.entropy.copyOf(),
      verified,
      current.journalId,
      registry,
      chain,
      recovery,
      cycle,
      cycles,
      highWater,
      discoveryRecovery,
    )

  private fun checkIdentity(current: WalletRecord, expected: WalletRecord) {
    check(
      current.id == expected.id &&
        current.journalId == expected.journalId &&
        java.security.MessageDigest.isEqual(current.entropy, expected.entropy)
    )
    check(current.credential.credentialId.contentEquals(expected.credential.credentialId))
  }

  fun markVerified(expected: WalletRecord) =
    synchronized(lock) {
      load().use { current ->
        checkIdentity(current, expected)
        replacement(current, verified = true).use { save(it) }
      }
    }

  /** Legacy intent 0 is recovered unchanged; allocating another investment is explicit. */
  fun bindEarnChain(expected: WalletRecord, chain: Int) =
    synchronized(lock) {
      require(chain in listOf(1, 4663))
      load().use { current ->
        checkIdentity(current, expected)
        check(current.verified && expected.verified)
        check(current.earnChain == 0 || current.earnChain == chain || current.earnRecoveryRequired)
        if (current.earnChain == chain) return@synchronized
        val rows = JSONArray(current.earnCycles)
        if (rows.length() == 0)
          rows.put(
            cycleRow(current.id, 0, chain).also {
              if (current.earnChain == 0 && !current.earnRecoveryRequired)
                it.put("privateAccount", "shared")
            }
          )
        else if (current.earnRecoveryRequired)
          for (i in 0 until rows.length()) if (
            rows.getJSONObject(i).getInt("cycleIndex") == current.earnCycleIndex
          )
            rows.getJSONObject(i).put("chainId", chain)
        replacement(current, chain = chain, cycles = rows.toString()).use { save(it) }
      }
    }

  fun allocateEarnCycle(expected: WalletRecord, chain: Int, budgetAtoms: String? = null) =
    synchronized(lock) {
      require(chain in listOf(1, 4663))
      load().use { current ->
        checkIdentity(current, expected)
        check(current.verified && !current.earnRecoveryRequired)
        val rows = JSONArray(current.earnCycles)
        check(current.earnCycleIndex < 1_000_000)
        if (rows.length() == 0 && current.earnChain > 0)
          rows.put(cycleRow(current.id, 0, current.earnChain))
        val next =
          (0 until rows.length())
            .maxOfOrNull { rows.getJSONObject(it).getInt("cycleIndex") }
            ?.let { Math.addExact(maxOf(it, current.discoveryHighWater), 1) }
            ?: maxOf(1, current.discoveryHighWater + 1)
        rows.put(
          cycleRow(current.id, next, chain).put("privateAccount", "shared").also { row ->
            if (budgetAtoms != null)
              row
                .put("distribution", chooseEarnDistribution(budgetAtoms))
                .put("distributionBudgetAtoms", budgetAtoms)
                .put("investmentSlot", 0)
          }
        )
        replacement(current, chain = chain, cycle = next, cycles = rows.toString()).use { save(it) }
      }
    }

  fun selectEarnCycle(index: Int) =
    synchronized(lock) {
      load().use { current ->
        val rows = JSONArray(current.earnCycles)
        val row =
          (0 until rows.length()).map(rows::getJSONObject).single {
            it.getInt("cycleIndex") == index
          }
        replacement(current, chain = row.getInt("chainId"), cycle = index).use { save(it) }
      }
    }

  fun selectEarnInvestmentSlot(index: Int, slot: Int) =
    synchronized(lock) {
      load().use { current ->
        check(current.verified)
        val rows = JSONArray(current.earnCycles)
        val row = rows.objects().single { it.getInt("cycleIndex") == index }
        require(slot in distributionWeights(row.getJSONObject("distribution")).indices)
        row.put("investmentSlot", slot)
        replacement(current, chain = row.getInt("chainId"), cycle = index, cycles = rows.toString())
          .use { save(it) }
      }
    }

  /** Commit unsigned draft identity with its fresh cycle before the journey file is created. */
  fun prepareEarnDepositCycle(
    expected: WalletRecord,
    chain: Int,
    draftId: String?,
    budgetAtoms: String? = null,
  ): String =
    synchronized(lock) {
      check(chain == 4663)
      load().use { current ->
        checkIdentity(current, expected)
        check(current.verified && !current.earnRecoveryRequired)
        val rows = JSONArray(current.earnCycles)
        val cycles = (0 until rows.length()).map(rows::getJSONObject)
        val existing =
          if (draftId != null) cycles.singleOrNull { it.optString("depositJourneyId") == draftId }
          else
            cycles
              .filter { it.has("depositJourneyId") && !it.optBoolean("depositFinished") }
              .maxByOrNull { it.getInt("cycleIndex") }
        if (draftId != null)
          check(existing != null) { "Deposit draft was not allocated by this device" }
        if (existing != null) {
          check(existing.getInt("chainId") == chain)
          check(!existing.optBoolean("depositAbandoned")) {
            "This unsigned draft was discarded; prepare a new deposit"
          }
          if (existing.has("distributionBudgetAtoms") && budgetAtoms != null)
            check(existing.getString("distributionBudgetAtoms") == budgetAtoms) {
              "Resume the saved deposit budget or start a new deposit"
            }
          replacement(current, chain = chain, cycle = existing.getInt("cycleIndex")).use {
            save(it)
          }
          return@synchronized existing.getString("depositJourneyId")
        }
        check(current.earnCycleIndex < 1_000_000)
        if (rows.length() == 0 && current.earnChain > 0)
          rows.put(cycleRow(current.id, 0, current.earnChain))
        val next =
          (0 until rows.length())
            .maxOfOrNull { rows.getJSONObject(it).getInt("cycleIndex") }
            ?.let { Math.addExact(maxOf(it, current.discoveryHighWater), 1) }
            ?: maxOf(1, current.discoveryHighWater + 1)
        val id = "deposit_" + UUID.randomUUID().toString().replace("-", "")
        rows.put(
          cycleRow(current.id, next, chain)
            .put("privateAccount", "shared")
            .put("depositJourneyId", id)
            .put("depositFinished", false)
            .also {
              if (budgetAtoms != null)
                it
                  .put("distribution", chooseEarnDistribution(budgetAtoms))
                  .put("distributionBudgetAtoms", budgetAtoms)
                  .put("investmentSlot", 0)
            }
        )
        replacement(current, chain = chain, cycle = next, cycles = rows.toString()).use { save(it) }
        id
      }
    }

  /** Call only after the journey journal has durably saved its independently verified result. */
  fun completeEarnDepositCycle(
    expected: WalletRecord,
    journeyId: String,
    abandoned: Boolean = false,
  ) =
    synchronized(lock) {
      load().use { current ->
        checkIdentity(current, expected)
        check(
          current.verified &&
            !current.earnRecoveryRequired &&
            current.earnCycleIndex == expected.earnCycleIndex
        )
        val rows = JSONArray(current.earnCycles)
        val cycle =
          (0 until rows.length()).map(rows::getJSONObject).single {
            it.getInt("cycleIndex") == current.earnCycleIndex &&
              it.optString("depositJourneyId") == journeyId
          }
        cycle.put("depositFinished", true)
        if (abandoned) cycle.put("depositAbandoned", true)
        replacement(current, cycles = rows.toString()).use { save(it) }
      }
    }

  /** A retry keeps its receiver. Different cycles can never consolidate into one receiver. */
  fun reserveEarnWithdrawal(expected: WalletRecord): Int =
    synchronized(lock) {
      load().use { current ->
        checkIdentity(current, expected)
        check(current.verified && !current.earnRecoveryRequired)
        val rows = JSONArray(current.earnCycles)
        if (rows.length() == 0) rows.put(cycleRow(current.id, 0, current.earnChain))
        val row =
          (0 until rows.length()).map(rows::getJSONObject).single {
            it.getInt("cycleIndex") == current.earnCycleIndex
          }
        val slot = selectedInvestmentSlot(current)
        val withdrawals =
          if (slot == null) row
          else
            row.optJSONObject("withdrawalIndices")
              ?: JSONObject().also { row.put("withdrawalIndices", it) }
        val field = slot?.toString() ?: "withdrawalIndex"
        if (withdrawals.has(field)) return@synchronized withdrawals.getInt(field)
        val registry = JSONObject(current.roleRegistry)
        val index = registry.getInt("nextRecipient")
        check(index < Int.MAX_VALUE)
        registry.put("nextRecipient", index + 1)
        withdrawals.put(field, index)
        replacement(current, registry = registry.toString(), cycles = rows.toString()).use {
          save(it)
        }
        index
      }
    }

  fun restore(record: WalletRecord) =
    synchronized(lock) {
      check(state()["status"] in listOf("absent", "recoveryRequired"))
      val key = keys.reset()
      WalletRecord(
          record.id,
          record.credential,
          record.entropy.copyOf(),
          true,
          UUID.randomUUID().toString(),
          record.roleRegistry,
          record.earnChain,
          true,
          record.earnCycleIndex,
          record.earnCycles,
          record.discoveryHighWater,
          record.discoveryRecoveryRequired,
        )
        .use { save(it, key) }
    }

  fun persistRegistry(expectedId: String, registry: String) =
    synchronized(lock) {
      requireRoleRegistry(registry)
      load().use { current ->
        check(
          current.id == expectedId &&
            JSONObject(registry).getInt("nextRecipient") >=
              JSONObject(current.roleRegistry).getInt("nextRecipient")
        )
        replacement(current, registry = registry).use { save(it) }
      }
    }

  /** Metadata only. A remote history never restores authorization or clears uncertainty. */
  fun mergeRecovery(metadata: JSONObject) =
    synchronized(lock) {
      load().use { current ->
        val remote = JSONArray(metadata.getString("earnCycles"))
        val local = JSONArray(current.earnCycles)
        val merged = sortedMapOf<Int, JSONObject>()
        for (source in listOf(local, remote)) for (i in 0 until source.length()) {
          val row = source.getJSONObject(i)
          val index = row.getInt("cycleIndex")
          val existing = merged[index]
          if (existing == null) merged[index] = JSONObject(row.toString())
          else {
            // A cycle's derivation and plan are immutable, including legacy absence.
            check(existing.has("distribution") == row.has("distribution")) {
              "RECOVERY_METADATA_CONFLICT"
            }
            check(existing.optString("privateAccount") == row.optString("privateAccount")) {
              "RECOVERY_METADATA_CONFLICT"
            }
            for (field in row.keys()) {
              if (field == "investmentSlot")
                continue // Local navigation is not recovered authority.
              if (field == "withdrawalIndices" && existing.has(field)) {
                val localIndices = existing.getJSONObject(field)
                val remoteIndices = row.getJSONObject(field)
                for (slot in remoteIndices.keys()) {
                  check(
                    !localIndices.has(slot) ||
                      localIndices.getInt(slot) == remoteIndices.getInt(slot)
                  ) {
                    "RECOVERY_METADATA_CONFLICT"
                  }
                  localIndices.put(slot, remoteIndices.getInt(slot))
                }
              } else if (
                existing.has(field) && !nativeJsonEqual(existing.get(field), row.get(field))
              ) {
                // Completion is monotonic; all identity/recipient conflicts fail closed.
                check(field in setOf("depositFinished", "depositAbandoned")) {
                  "RECOVERY_METADATA_CONFLICT"
                }
                existing.put(field, existing.getBoolean(field) || row.getBoolean(field))
              } else existing.put(field, row.get(field))
            }
          }
        }
        val registry = JSONObject(current.roleRegistry)
        registry.put(
          "nextRecipient",
          maxOf(
            registry.getInt("nextRecipient"),
            JSONObject(metadata.getString("roleRegistry")).getInt("nextRecipient"),
          ),
        )
        val next =
          maxOf(
            current.earnCycleIndex,
            metadata.getInt("earnCycleIndex"),
            merged.keys.maxOrNull() ?: 0,
          )
        val chain = merged[next]?.getInt("chainId") ?: current.earnChain
        replacement(
            current,
            registry = registry.toString(),
            chain = chain,
            recovery = true,
            cycle = next,
            cycles = JSONArray(merged.values.toList()).toString(),
            highWater =
              maxOf(current.discoveryHighWater, metadata.optInt("discoveryHighWater", -1)),
            discoveryRecovery =
              current.discoveryRecoveryRequired || metadata.optBoolean("discoveryRecoveryRequired"),
          )
          .use { save(it) }
      }
    }

  fun recordDiscovered(expected: WalletRecord, cycle: Int, untracked: Boolean) =
    synchronized(lock) {
      require(cycle in 0..1_000_000)
      load().use { current ->
        checkIdentity(current, expected)
        replacement(
            current,
            highWater = maxOf(current.discoveryHighWater, cycle),
            recovery = current.earnRecoveryRequired || untracked,
            discoveryRecovery = current.discoveryRecoveryRequired || untracked,
          )
          .use { save(it) }
      }
    }

  fun markRecoveryRequired(expected: WalletRecord) =
    synchronized(lock) {
      load().use { current ->
        checkIdentity(current, expected)
        replacement(current, recovery = true).use { save(it) }
      }
    }

  /**
   * Only the native restored-history verifier may call this after every uncertainty is resolved.
   */
  fun completeRecovery(expected: WalletRecord, discoveryResolved: Boolean = false) =
    synchronized(lock) {
      load().use { current ->
        checkIdentity(current, expected)
        if (!current.discoveryRecoveryRequired || discoveryResolved)
          replacement(current, recovery = false, discoveryRecovery = false).use { save(it) }
      }
    }

  private fun cycleRow(id: String, index: Int, chain: Int): JSONObject {
    val profile = if (chain == 1) "ethereum-usdc" else "robinhood-usdg"
    return JSONObject()
      .put("cycleIndex", index)
      .put("chainId", chain)
      .put(
        "intentId",
        if (index == 0) "earn-v1:${id.lowercase()}:$profile"
        else "earn-v2:${id.lowercase()}:$profile:$index",
      )
  }

  private fun save(record: WalletRecord, key: SecretKey? = null) {
    val header =
      ByteArrayOutputStream()
        .apply {
          DataOutputStream(this).use { out ->
            out.writeInt(6)
            out.writeBoolean(record.verified)
            out.writeUTF(record.id)
            out.writeUTF(record.journalId)
            out.writeInt(record.earnChain)
            out.writeBoolean(record.earnRecoveryRequired)
            out.writeInt(record.credential.credentialId.size)
            out.write(record.credential.credentialId)
            out.write(record.credential.publicKeyX)
            out.write(record.credential.publicKeyY)
          }
        }
        .toByteArray()
    val footer =
      ByteArrayOutputStream()
        .apply {
          DataOutputStream(this).use { out ->
            out.writeUTF(record.roleRegistry)
            out.writeInt(record.earnCycleIndex)
            val cycles = record.earnCycles.toByteArray()
            out.writeInt(cycles.size)
            out.write(cycles)
            out.writeInt(record.discoveryHighWater)
            out.writeBoolean(record.discoveryRecoveryRequired)
          }
        }
        .toByteArray()
    val clear = header + record.entropy + footer
    try {
      file.write(CryptoEnvelope.encrypt(key ?: keys.existing() ?: keys.create(), clear, aad))
    } finally {
      clear.fill(0)
    }
  }
}
