package io.gizu.storedwallet

import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.*

internal const val EARN_ENTRY_POINT = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108"
internal const val EARN_IMPLEMENTATION = "0xe6Cae83BdE06E4c305530e199D7217f42808555B"
internal const val EARN_PAYMASTER = "0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402"
internal const val MONAD_EARN_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603"
internal const val HOOD_EARN_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
internal const val HOOD_EARN_VAULT = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd"
internal const val HOOD_EARN_ROUTER = "0xcC108538f36242D6E0d6B9255f6D9Ccd137D70Fe"
internal const val EARN_MONAD_ASSET = "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx"
internal const val EARN_HOOD_ASSET =
  "nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near"

internal class EarnSponsoredChainRpc(chain: Int) : TransferRpc {
  private val transport =
    NativeRpcTransport(
      when (chain) {
        143 -> "https://rpc.monad.xyz"
        4663 -> "https://rpc.mainnet.chain.robinhood.com"
        else -> error("Unsupported chain")
      }
    )

  override suspend fun call(method: String, params: JSONArray): Any =
    nativeEarnRpc(transport, method, params)
}

internal class EarnSponsoredBundlerRpc(chain: Int) : TransferRpc {
  init {
    check(chain in setOf(143, 4663))
  }

  private val transport = NativeRpcTransport("$EARN_NATIVE_BACKEND/bundler/$chain")

  override suspend fun call(method: String, params: JSONArray): Any {
    check(
      method in
        setOf(
          "pm_getPaymasterData",
          "eth_sendUserOperation",
          "eth_getUserOperationReceipt",
          "eth_getUserOperationByHash",
          "eth_supportedEntryPoints",
        )
    )
    return nativeEarnRpc(transport, method, params)
  }
}

internal class EarnRpcRejection(val method: String, val rpcCode: Long, val hint: String) :
  Exception("Native RPC rejected a request")

internal suspend fun nativeEarnRpc(
  transport: NativeRpcTransport,
  method: String,
  params: JSONArray,
): Any {
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
  check(response.getString("jsonrpc") == "2.0" && response.getInt("id") == 1)
  response.optJSONObject("error")?.let { error ->
    val code = error.optLong("code", 0)
    val message = error.optString("message").lowercase(java.util.Locale.ROOT)
    val aa = Regex("""\baa[0-9]{2}\b""").find(message)?.value?.uppercase(java.util.Locale.ROOT)
    val hint =
      when {
        code == -32005L || "rate limit" in message || "too many requests" in message ->
          "RATE_LIMITED"
        code == -32601L -> "UNSUPPORTED_METHOD"
        code == -32602L -> "INVALID_PARAMS"
        "block not found" in message ||
          "header not found" in message ||
          "unknown block" in message -> "BLOCK_UNAVAILABLE"
        aa != null -> aa
        else -> "REJECTED"
      }
    throw EarnRpcRejection(method, code, hint)
  }
  check(!response.has("error"))
  return response.get("result")
}

internal fun utf8EarnHash(value: String): String =
  earnContractCodeHash("0x" + value.toByteArray().joinToString("") { "%02x".format(it) })

internal data class NativeEarnRouteProof(
  val binding: NativeEarnQuoteBinding,
  val minimumCreditAtoms: String,
  val originAsset: String,
  val recoveryEnvelope: String? = null,
  val maximumCreditAtoms: String? = null,
)

/**
 * Native TLS fetch of the server's previously verified executable quote registry; JS is never
 * proof.
 */
internal class NativeEarnQuoteGateway(
  private val post: suspend (String, String) -> String = { endpoint, body ->
    NativeRpcTransport("$EARN_NATIVE_BACKEND/$endpoint").post(body)
  },
  private val hashBody: (String) -> String = ::utf8EarnHash,
  private val now: () -> Long = { System.currentTimeMillis() / 1000 },
  private val quotes: EarnQuoteJournal? = null,
) {
  private val routeFields =
    listOf(
      "operationId",
      "revision",
      "quoteId",
      "chainId",
      "token",
      "amountAtoms",
      "confidentialAccount",
      "refundOwner",
      "recipient",
    )
  private val routeAddresses = setOf("token", "confidentialAccount", "refundOwner", "recipient")

  suspend fun create(
    chain: Int,
    operationId: String,
    revision: Int,
    owner: String,
    confidential: String,
    amount: String,
    returning: Boolean,
    returnAsset: String = "usdc",
  ): Map<String, Any> {
    check(
      chain in setOf(1, 4663) &&
        returnAsset in setOf("usdc", "native") &&
        (chain == 1 || returnAsset == "usdc")
    )
    earnAddressWord(owner)
    earnAddressWord(confidential)
    earnNumberWord(amount)
    val body =
      JSONObject()
        .put("operationId", operationId)
        .put("revision", revision)
        .put("profileChainId", chain)
        .put("sourceOwner", owner)
        .put("confidentialAccount", confidential)
        .put("amountAtoms", amount)
        .put("settlementMode", "balance-delta-v1")
    if (returning && chain == 1) body.put("returnAsset", returnAsset)
    val saved = quotes?.get(operationId, revision)
    val response =
      if (saved != null) {
        val expectedChain = if (returning) chain else 143
        val expectedToken =
          if (!returning) MONAD_EARN_USDC
          else if (chain == 4663) HOOD_EARN_USDG
          else if (returnAsset == "native") ETH_NATIVE_TOKEN else ETH_EARN_USDC
        check(
          saved.getString("amountAtoms") == amount &&
            saved.getInt("chainId") == expectedChain &&
            saved.getString("token").equals(expectedToken, true)
        )
        check(
          saved.getString("confidentialAccount").equals(confidential, true) &&
            saved.getString("refundOwner").equals(owner, true)
        )
        val request = JSONObject()
        for (field in routeFields) request.put(field, saved.get(field))
        request.put("recoveryEnvelope", saved.getString("recoveryEnvelope"))
        JSONObject(post("quote-binding", request.toString()))
      } else JSONObject(post(if (returning) "return-quote" else "source-quote", body.toString()))
    check(
      response.getString("operationId") == operationId && response.getInt("revision") == revision
    )
    val feePolicy =
      nativeEarnFeePolicy(
        response,
        "providerFeeBps",
        if (!returning) "source"
        else if (chain == 4663) "returnRobinhood"
        else if (returnAsset == "native") "returnEth" else "returnUsdc",
      )
    val expectedChain = if (returning) chain else 143
    val token =
      if (!returning) MONAD_EARN_USDC
      else if (chain == 4663) HOOD_EARN_USDG
      else if (returnAsset == "native") ETH_NATIVE_TOKEN else ETH_EARN_USDC
    check(
      response.getInt("chainId") == expectedChain &&
        response.getString("token").equals(token, true) &&
        response.getString("amountAtoms") == amount
    )
    check(
      response.getString("confidentialAccount").equals(confidential, true) &&
        response.getString("refundOwner").equals(owner, true)
    )
    earnAddressWord(response.getString("recipient"))
    earnHash(response.getString("authenticatedBodyHash"))
    val expires = response.getLong("expiresAt")
    check(expires > now() && expires <= now() + 600)
    val minimum = response.getString("minimumCreditAtoms")
    earnNumberWord(minimum)
    check(minimum.toBigInteger().signum() > 0)
    check(
      response.getString("originAsset") ==
        if (!returning) EARN_MONAD_ASSET
        else if (chain == 4663) EARN_HOOD_ASSET
        else if (returnAsset == "native") ETH_NATIVE_ORIGIN_ASSET else ETH_USDC_ORIGIN_ASSET
    )
    quotes?.save(response) // A failed durable commit must never release a public quote.
    val result =
      mutableMapOf<String, Any>(
        "operationId" to operationId,
        "revision" to revision,
        "quoteId" to response.getString("quoteId"),
        "recipient" to response.getString("recipient"),
        "chainId" to expectedChain,
        "token" to token,
        "amountAtoms" to amount,
        "confidentialAccount" to confidential,
        "refundOwner" to owner,
        "expiresAt" to expires,
        "expiresAtMs" to expires * 1000,
        "quotedAtMs" to System.currentTimeMillis(),
        "minimumCreditAtoms" to minimum,
        "providerFeeBps" to response.getInt("providerFeeBps"),
        "originAsset" to response.getString("originAsset"),
      )
    if (feePolicy != null) result["feePolicy"] = nativeEarnFeeMap(JSONObject(feePolicy))
    return result
  }

  suspend fun binding(proposal: JSONObject): NativeEarnRouteProof? {
    val proposal = JSONObject(proposal.toString())
    val kind = proposal.getString("kind")
    if (kind !in setOf("sourceFunding", "hoodTokenReturn", "returnUsdc", "returnEth")) return null
    if (kind in setOf("returnUsdc", "returnEth"))
      proposal.put("token", if (kind == "returnEth") ETH_NATIVE_TOKEN else ETH_EARN_USDC)
    val fields = routeFields
    val request = JSONObject()
    for (field in fields) request.put(field, proposal.get(field))
    val saved = quotes?.get(proposal.getString("operationId"), proposal.getInt("revision"))
    if (saved != null) {
      for (field in fields) check(
        if (field in routeAddresses)
          saved.get(field).toString().equals(proposal.get(field).toString(), true)
        else saved.get(field).toString() == proposal.get(field).toString()
      ) {
        "Protected quote changed"
      }
      request.put("recoveryEnvelope", saved.getString("recoveryEnvelope"))
    }
    val text = post("quote-binding", request.toString())
    val response = JSONObject(text)
    val feePolicy =
      nativeEarnFeePolicy(
        response,
        "providerFeeBps",
        when (kind) {
          "sourceFunding" -> "source"
          "hoodTokenReturn" -> "returnRobinhood"
          "returnEth" -> "returnEth"
          else -> "returnUsdc"
        },
      )
    val addresses = routeAddresses
    for (field in fields) {
      val received = response.get(field).toString()
      val expected = proposal.get(field).toString()
      check(if (field in addresses) received.equals(expected, true) else received == expected) {
        "Native quote binding changed"
      }
    }
    val expires = response.getLong("expiresAt")
    check(expires >= proposal.getLong("deadline") && expires > now() && expires <= now() + 600)
    // Local hash commits the independently obtained native TLS body, not a JS claimed hash.
    val minimum = response.getString("minimumCreditAtoms")
    earnNumberWord(minimum)
    check(minimum.toBigInteger().signum() > 0)
    val origin = response.getString("originAsset")
    check(
      origin ==
        when (kind) {
          "sourceFunding" -> EARN_MONAD_ASSET
          "hoodTokenReturn" -> EARN_HOOD_ASSET
          "returnEth" -> ETH_NATIVE_ORIGIN_ASSET
          else -> ETH_USDC_ORIGIN_ASSET
        }
    )
    val binding =
      NativeEarnQuoteBinding(
        response.getString("operationId"),
        response.getLong("revision").toULong(),
        response.getString("quoteId"),
        response.getLong("chainId").toULong(),
        response.getString("token"),
        response.getString("recipient"),
        response.getString("amountAtoms"),
        response.getString("confidentialAccount"),
        response.getString("refundOwner"),
        expires.toULong(),
        hashBody(text),
        feePolicy,
      )
    quotes?.save(response)
    return NativeEarnRouteProof(
      binding,
      minimum,
      origin,
      response.optString("recoveryEnvelope").takeIf { it.isNotEmpty() },
      response.optString("maximumCreditAtoms").takeIf { it.isNotEmpty() },
    )
  }
}

internal class EarnSponsoredStateLoader(
  private val rpc: TransferRpc,
  private val hashCode: (String) -> String = ::earnContractCodeHash,
) {
  suspend fun load(p: JSONObject): NativeSponsoredState {
    val chain = p.getLong("chainId")
    check(chain in setOf(143L, 4663L) && quantity(rpc.text("eth_chainId")) == chain.toBigInteger())
    val owner = p.getString("expectedFrom")
    val token = if (chain == 143L) MONAD_EARN_USDC else HOOD_EARN_USDG
    val block = rpc.call("eth_getBlockByNumber", JSONArray().put("latest").put(false)) as JSONObject
    requireFreshEarnBlock(block)
    val blockHash = earnHash(block.getString("hash"))
    val pinned = earnPinnedBlock(blockHash)
    suspend fun read(method: String, first: Any) =
      rpc.call(method, JSONArray().put(first).put(pinned)) as String
    suspend fun call(to: String, data: String) =
      read("eth_call", JSONObject().put("to", to).put("data", data))
    suspend fun uint(to: String, data: String) = earnAbiWord(call(to, data)).toString()
    val word = earnAddressWord(owner)
    val zero = "0".repeat(64)
    val epNonce = earnAbiWord(call(EARN_ENTRY_POINT, "0x35567e1a$word$zero"))
    val pending = quantity(rpc.text("eth_getTransactionCount", owner, "pending"))
    val latest = quantity(read("eth_getTransactionCount", owner))
    check(pending == latest && pending.bitLength() <= 63)
    val held = uint(token, "0x70a08231$word")
    val allowance = uint(token, "0xdd62ed3e$word${earnAddressWord(EARN_PAYMASTER)}")
    val decimals = earnAbiWord(call(token, "0x313ce567"))
    check(decimals == 6.toBigInteger())
    val ownerCode = read("eth_getCode", owner)
    val recipientCode =
      if (p.has("recipient")) read("eth_getCode", p.getString("recipient")) else "0x"
    suspend fun code(address: String): String =
      read("eth_getCode", address).also { check(it != "0x") }.let(hashCode)
    val tokenHash = code(token)
    val pmHash = code(EARN_PAYMASTER)
    val implementationHash = code(EARN_IMPLEMENTATION)
    val epHash = code(EARN_ENTRY_POINT)
    var shares = "0"
    var preview = "0"
    var maxRedeem = "0"
    var asset = token
    var vaultHash = "0x" + "0".repeat(64)
    var routerHash = vaultHash
    if (chain == 4663L) {
      shares = uint(HOOD_EARN_VAULT, "0x70a08231$word")
      preview =
        uint(
          HOOD_EARN_VAULT,
          "${if (p.has("requestedWithdrawalAtoms")) "0x4cdad506" else "0xef8b30f7"}${earnNumberWord(p.getString("amountAtoms"))}",
        )
      maxRedeem = uint(HOOD_EARN_VAULT, "0xd905777e$word")
      val value = call(HOOD_EARN_VAULT, "0x38d52e0f")
      earnAbiWord(value)
      check(value.substring(2, 26) == "0".repeat(24))
      asset = "0x" + value.takeLast(40)
      vaultHash = code(HOOD_EARN_VAULT)
      routerHash = code(HOOD_EARN_ROUTER)
    }
    val canonical =
      rpc.call("eth_getBlockByNumber", JSONArray().put(block.getString("number")).put(false))
        as JSONObject
    check(earnHash(canonical.getString("hash")) == blockHash)
    return NativeSponsoredState(
      chain.toULong(),
      owner,
      (System.currentTimeMillis() / 1000).toULong(),
      quantity(block.getString("number")).longValueExact().toULong(),
      blockHash,
      earnHash(block.getString("parentHash")),
      "0x" + epNonce.toString(16),
      pending.toLong().toULong(),
      latest.toLong().toULong(),
      held,
      allowance,
      shares,
      preview,
      maxRedeem,
      asset,
      6u,
      ownerCode,
      recipientCode,
      quantity(block.getString("baseFeePerGas")).toString(),
      tokenHash,
      pmHash,
      implementationHash,
      epHash,
      vaultHash,
      routerHash,
    )
  }
}

/** Server policy is obtained over fixed native TLS; JS never supplies this proof. */
internal fun nativeEarnFeePolicy(response: JSONObject, totalField: String, route: String): String? {
  val total = response.getInt(totalField)
  val p =
    if (response.has("feePolicy") && !response.isNull("feePolicy"))
      response.getJSONObject("feePolicy")
    else null
  if (p == null) {
    check(total == 2)
    return null
  }
  val identity = Regex("[a-zA-Z0-9_.:-]{1,128}")
  check(
    identity.matches(p.getString("version")) &&
      p.getString("route") == route &&
      p.getInt("totalBps") == total &&
      total in 0..100
  )
  check(p.getInt("integratorFeeBps") == 0 && p.getString("applicationFeeAtoms") == "0")
  check(p.isNull("referral") || identity.matches(p.getString("referral")))
  val fees = p.getJSONArray("appFees")
  check(fees.length() <= 8)
  var sum = 0
  val recipients = mutableSetOf<String>()
  for (i in 0 until fees.length()) {
    val f = fees.getJSONObject(i)
    val recipient = f.getString("recipient")
    val fee = f.getInt("fee")
    check(identity.matches(recipient) && recipients.add(recipient) && fee in 0..100)
    sum += fee
  }
  check(sum == total)
  return p.toString()
}

internal fun nativeEarnFeeMap(p: JSONObject): Map<String, Any?> =
  mapOf(
    "version" to p.getString("version"),
    "route" to p.getString("route"),
    "totalBps" to p.getInt("totalBps"),
    "integratorFeeBps" to 0,
    "applicationFeeAtoms" to "0",
    "referral" to if (p.isNull("referral")) null else p.getString("referral"),
    "appFees" to
      (0 until p.getJSONArray("appFees").length()).map {
        val f = p.getJSONArray("appFees").getJSONObject(it)
        mapOf("recipient" to f.getString("recipient"), "fee" to f.getInt("fee"))
      },
  )
