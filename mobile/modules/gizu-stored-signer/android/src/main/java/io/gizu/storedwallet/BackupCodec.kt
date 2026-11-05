package io.gizu.storedwallet

import java.util.Base64
import java.util.UUID
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

internal object BackupCodec {
  private fun enc(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

  private fun dec(value: String) = Base64.getUrlDecoder().decode(value)

  private fun header(bytes: ByteArray): JSONObject {
    require(bytes.size in 1..16 * 1024 * 1024)
    val h = JSONObject(String(bytes, Charsets.UTF_8))
    require(h.getString("format") == "gizu-stored-wallet")
    require(
      h.getString("rpId") == "gizu.io" && h.getString("derivationVersion") == "gizu-stored-evm-v1"
    )
    UUID.fromString(h.getString("walletId"))
    val version = h.getInt("version")
    require(version in 1..3)
    if (version == 2) requireRoleRegistry(h.getString("roleRegistry"))
    else require(!h.has("roleRegistry"))
    return h
  }

  private fun aad(h: JSONObject): ByteArray {
    val parts =
      mutableListOf(
        "gizu-stored-wallet",
        h.get("version").toString(),
        "gizu.io",
        "gizu-stored-evm-v1",
        h.getString("walletId"),
        h.getString("credentialId"),
        h.getString("x"),
        h.getString("y"),
      )
    if (h.getInt("version") == 2) parts.add(h.getString("roleRegistry"))
    return parts.joinToString(":").toByteArray()
  }

  fun credential(bytes: ByteArray): StoredPasskey {
    val h = header(bytes)
    return StoredPasskey(
        dec(h.getString("credentialId")),
        dec(h.getString("x")),
        dec(h.getString("y")),
      )
      .also {
        require(
          it.credentialId.size in 1..1024 && it.publicKeyX.size == 32 && it.publicKeyY.size == 32
        )
      }
  }

  fun encrypt(record: WalletRecord, prf: ByteArray): ByteArray {
    require(prf.size == 32)
    val h =
      JSONObject()
        .put("format", "gizu-stored-wallet")
        .put("version", 3)
        .put("rpId", "gizu.io")
        .put("derivationVersion", "gizu-stored-evm-v1")
        .put("walletId", record.id)
        .put("credentialId", enc(record.credential.credentialId))
        .put("x", enc(record.credential.publicKeyX))
        .put("y", enc(record.credential.publicKeyY))

    val clear =
      JSONObject()
        .put("version", 3)
        .put("entropy", enc(record.entropy))
        .put("roleRegistry", record.roleRegistry)
        .put("earnChain", record.earnChain)
        .put("earnRecoveryRequired", record.earnRecoveryRequired)
        .put("earnCycleIndex", record.earnCycleIndex)
        .put("earnCycles", record.earnCycles)
        .put("discoveryHighWater", record.discoveryHighWater)
        .put("discoveryRecoveryRequired", record.discoveryRecoveryRequired)
        .toString()
        .toByteArray()
    try {
      return h.put(
          "envelope",
          enc(CryptoEnvelope.encrypt(SecretKeySpec(prf, "AES"), clear, aad(h))),
        )
        .toString()
        .toByteArray()
    } finally {
      clear.fill(0)
    }
  }

  fun decrypt(bytes: ByteArray, prf: ByteArray): WalletRecord {
    require(prf.size == 32)
    val h = header(bytes)
    val credential = credential(bytes)
    val clear =
      CryptoEnvelope.decrypt(SecretKeySpec(prf, "AES"), dec(h.getString("envelope")), aad(h))
    var entropy: ByteArray? = null
    try {
      val metadata =
        if (h.getInt("version") == 3) JSONObject(String(clear, Charsets.UTF_8)) else null
      if (metadata != null) require(metadata.getInt("version") == 3)
      entropy = if (metadata != null) dec(metadata.getString("entropy")) else clear.copyOf()
      return WalletRecord(
        h.getString("walletId"),
        credential,
        entropy,
        roleRegistry =
          metadata?.getString("roleRegistry")
            ?: if (h.getInt("version") == 2) h.getString("roleRegistry") else INITIAL_ROLE_REGISTRY,
        earnChain = metadata?.getInt("earnChain") ?: 0,
        earnRecoveryRequired = metadata?.getBoolean("earnRecoveryRequired") ?: false,
        earnCycleIndex = metadata?.getInt("earnCycleIndex") ?: 0,
        earnCycles = metadata?.getString("earnCycles") ?: "[]",
        discoveryHighWater = metadata?.optInt("discoveryHighWater", -1) ?: -1,
        discoveryRecoveryRequired = metadata?.optBoolean("discoveryRecoveryRequired") ?: false,
      )
    } catch (e: Exception) {
      entropy?.fill(0)
      throw e
    } finally {
      clear.fill(0)
    }
  }
}
