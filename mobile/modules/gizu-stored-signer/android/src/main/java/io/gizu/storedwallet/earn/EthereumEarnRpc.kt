package io.gizu.storedwallet

import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.EarnExecutionState
import uniffi.gizu_stored_signer_core.NativeGasReference
import uniffi.gizu_stored_signer_core.earnContractCodeHash

internal const val ETH_EARN_VAULT = "0x55C1B6e461a6334B567bAF0FEb5D728715446f05"
internal const val ETH_EARN_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
internal const val ETH_EARN_ROUTER = "0x02912516d49dE997db75B9D7858faAE59209650B"

/** Fixed native endpoint. No Expo/provider URL or provider state can enter this transport. */
internal class EthereumEarnRpc : TransferRpc {
  private val transport = NativeRpcTransport("https://ethereum-rpc.publicnode.com")

  override suspend fun call(method: String, params: JSONArray): Any {
    val response =
      JSONObject(
        transport.post(
          JSONObject()
            .put("jsonrpc", "2.0")
            .put("id", 1)
            .put("method", method)
            .put("params", params)
            .toString()
        )
      )
    check(
      response.getString("jsonrpc") == "2.0" && response.getInt("id") == 1 && !response.has("error")
    )
    return response.get("result")
  }
}

internal fun earnAddressWord(address: String): String {
  check(Regex("0x[0-9a-fA-F]{40}").matches(address))
  return address.drop(2).lowercase().padStart(64, '0')
}

internal fun earnNumberWord(decimal: String): String {
  check(Regex("0|[1-9][0-9]{0,77}").matches(decimal))
  val n = decimal.toBigInteger()
  check(n.bitLength() <= 256)
  return n.toString(16).padStart(64, '0')
}

internal fun earnAbiWord(value: String): java.math.BigInteger {
  check(Regex("0x[0-9a-fA-F]{64}").matches(value))
  return value.drop(2).toBigInteger(16)
}

internal fun earnHash(value: String): String {
  check(Regex("0x[0-9a-fA-F]{64}").matches(value))
  return value.lowercase()
}

internal fun earnPinnedBlock(hash: String) =
  JSONObject().put("blockHash", earnHash(hash)).put("requireCanonical", true)

internal fun requireFreshEarnBlock(
  block: JSONObject,
  now: Long = System.currentTimeMillis() / 1000,
) {
  val timestamp = quantity(block.getString("timestamp")).longValueExact()
  check(now - timestamp in -5L..60L) { "Stale native reference block" }
  val hash = earnHash(block.getString("hash"))
  val parent = earnHash(block.getString("parentHash"))
  check(hash != parent && hash != "0x" + "0".repeat(64) && parent != "0x" + "0".repeat(64))
}

/** Native RPC evidence only; the reviewed anchor never comes from the Expo request. */
internal suspend fun loadEarnGasReference(
  rpc: TransferRpc,
  reviewedNumber: ULong,
  reviewedHash: String,
  current: EarnExecutionState,
  nowMillis: () -> Long = System::currentTimeMillis,
): NativeGasReference {
  check(current.chainId == 1uL && quantity(rpc.text("eth_chainId")) == java.math.BigInteger.ONE)
  check(current.blockNumber >= reviewedNumber)
  suspend fun canonical(number: ULong, expectedHash: String) {
    val block =
      rpc.call("eth_getBlockByNumber", JSONArray().put("0x" + number.toString(16)).put(false))
        as JSONObject
    check(quantity(block.getString("number")) == number.toString().toBigInteger())
    check(earnHash(block.getString("hash")) == earnHash(expectedHash))
  }
  canonical(reviewedNumber, reviewedHash)
  canonical(current.blockNumber, current.blockHash)
  val observed = nowMillis()
  check(observed >= 0)
  return NativeGasReference(
    1uL,
    reviewedNumber,
    earnHash(reviewedHash),
    current.blockNumber,
    earnHash(current.blockHash),
    observed.toULong(),
  )
}

/**
 * One EIP-1898 canonical hash for all financial/code observations; only pending nonce uses pending.
 */
internal class EarnVaultStateLoader(
  private val rpc: TransferRpc,
  private val codeHash: (String) -> String = ::earnContractCodeHash,
  private val now: () -> Long = { System.currentTimeMillis() / 1000 },
) {
  suspend fun load(owner: String, kind: String, amount: String): EarnExecutionState {
    check(quantity(rpc.text("eth_chainId")) == java.math.BigInteger.ONE)
    check(kind in setOf("vaultDeposit", "vaultRedeemAll"))
    earnAddressWord(owner)
    earnNumberWord(amount)
    val block = rpc.call("eth_getBlockByNumber", JSONArray().put("latest").put(false)) as JSONObject
    requireFreshEarnBlock(block, now())
    val hash = earnHash(block.getString("hash"))
    val pinned = earnPinnedBlock(hash)
    suspend fun text(method: String, first: Any): String =
      rpc.call(method, JSONArray().put(first).put(pinned)) as String
    suspend fun call(to: String, data: String): String =
      text("eth_call", JSONObject().put("to", to).put("data", data))
    suspend fun uint(to: String, data: String) = earnAbiWord(call(to, data)).toString()
    val ownerWord = earnAddressWord(owner)
    val pending = quantity(rpc.text("eth_getTransactionCount", owner, "pending"))
    val canonicalNonce = quantity(text("eth_getTransactionCount", owner))
    check(pending >= canonicalNonce && pending.bitLength() <= 63)
    val nativeBalance = quantity(text("eth_getBalance", owner)).toString()
    val senderCode = text("eth_getCode", owner)
    val tokenCode = text("eth_getCode", ETH_EARN_USDC)
    val vaultCode = text("eth_getCode", ETH_EARN_VAULT)
    val routerCode = text("eth_getCode", ETH_EARN_ROUTER)
    check(tokenCode != "0x" && vaultCode != "0x" && routerCode != "0x")
    val assetWord = call(ETH_EARN_VAULT, "0x38d52e0f")
    earnAbiWord(assetWord)
    check(assetWord.substring(2, 26) == "0".repeat(24))
    val decimals = earnAbiWord(call(ETH_EARN_USDC, "0x313ce567"))
    check(decimals.bitLength() <= 31)
    val usdc = uint(ETH_EARN_USDC, "0x70a08231$ownerWord")
    val shares = uint(ETH_EARN_VAULT, "0x70a08231$ownerWord")
    val allowance =
      uint(
        if (kind == "vaultDeposit") ETH_EARN_USDC else ETH_EARN_VAULT,
        "0xdd62ed3e$ownerWord${earnAddressWord(ETH_EARN_ROUTER)}",
      )
    val preview = uint(ETH_EARN_VAULT, "0xef8b30f7${earnNumberWord(amount)}")
    val maxRedeem = uint(ETH_EARN_VAULT, "0xd905777e$ownerWord")
    val canonical =
      rpc.call("eth_getBlockByNumber", JSONArray().put(block.getString("number")).put(false))
        as JSONObject
    check(earnHash(canonical.getString("hash")) == hash)
    return EarnExecutionState(
      1uL,
      owner,
      pending.toLong().toULong(),
      now().toULong(),
      quantity(block.getString("number")).longValueExact().toULong(),
      hash,
      earnHash(block.getString("parentHash")),
      nativeBalance,
      quantity(block.getString("baseFeePerGas")).toString(),
      usdc,
      shares,
      allowance,
      preview,
      maxRedeem,
      "0x" + assetWord.takeLast(40),
      decimals.toInt().toUInt(),
      senderCode,
      codeHash(tokenCode),
      codeHash(vaultCode),
      codeHash(routerCode),
    )
  }
}

internal fun requireEarnTransaction(tx: JSONObject, step: JSONObject, owner: String, hash: String) {
  check(tx.getString("hash").equals(hash, true) && tx.getString("from").equals(owner, true))
  check(
    tx.getString("to").equals(step.getString("to"), true) &&
      tx.getString("input").equals(step.getString("data"), true)
  )
  check(quantity(tx.getString("gas")) == step.getString("gasLimit").toBigInteger())
  check(quantity(tx.getString("maxFeePerGas")) == step.getString("maxFeePerGasWei").toBigInteger())
  check(
    quantity(tx.getString("maxPriorityFeePerGas")) ==
      step.getString("priorityFeePerGasWei").toBigInteger()
  )
  check(
    quantity(tx.getString("nonce")) == step.getString("nonce").toBigInteger() &&
      quantity(tx.getString("value")) == java.math.BigInteger.ZERO
  )
}
