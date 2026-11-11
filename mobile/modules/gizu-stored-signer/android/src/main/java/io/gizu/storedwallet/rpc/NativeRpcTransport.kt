package io.gizu.storedwallet

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

internal enum class RpcFailureCode {
  NETWORK,
  TIMEOUT,
  HTTP,
  RESPONSE_TOO_LARGE,
  RPC,
  INSUFFICIENT_FUNDS,
}

internal class RpcFailure(val code: RpcFailureCode) : Exception(code.name)

/** Private native transport. Endpoint injection is for JVM tests, never an Expo API. */
internal class NativeRpcTransport(
  private val endpoint: String = "https://testnet-rpc.monad.xyz",
  private val client: OkHttpClient =
    OkHttpClient.Builder()
      .followRedirects(false)
      .followSslRedirects(false)
      .retryOnConnectionFailure(false)
      .connectTimeout(8, TimeUnit.SECONDS)
      .readTimeout(20, TimeUnit.SECONDS)
      .writeTimeout(10, TimeUnit.SECONDS)
      .callTimeout(30, TimeUnit.SECONDS)
      .apply {
        // The read-only vault preview includes mainnet fork and paymaster calculations.
        if (
          endpoint == EARN_NATIVE_BACKEND.removeSuffix("/native") + "/robinhood/deposit-preview"
        ) {
          readTimeout(60, TimeUnit.SECONDS)
          callTimeout(70, TimeUnit.SECONDS)
        }
        if (
          endpoint in
            setOf(
              "$EARN_NATIVE_BACKEND/cashout/group-status",
              "$EARN_NATIVE_BACKEND/payout/group-status",
            )
        ) {
          // Read-only whole-plan verification uses bounded batches of route/receipt reads.
          readTimeout(180, TimeUnit.SECONDS)
          callTimeout(190, TimeUnit.SECONDS)
        }
        if (endpoint == "$EARN_NATIVE_BACKEND/settlement") {
          // Status, balance and optional exact history each use bounded provider requests.
          // Their worst-case aggregate exceeds the ordinary 30-second transport budget.
          readTimeout(80, TimeUnit.SECONDS)
          callTimeout(90, TimeUnit.SECONDS)
        }
      }
      .build(),
  private val requestHeaders: Map<String, String> = emptyMap(),
) {
  suspend fun post(payload: String): String {
    val (status, body) = execute("POST", endpoint, payload)
    if (status !in 200..299) {
      val service =
        when {
          endpoint.endsWith("/v1/earn/monad/funding-plan") -> "funding-plan"
          endpoint == "https://rpc.monad.xyz" -> "monad-rpc"
          endpoint == "https://rpc.mainnet.chain.robinhood.com" -> "robinhood-rpc"
          else -> "native-service"
        }
      android.util.Log.w("GizuRpc", "request failed: service=$service status=$status")
      if (endpoint.startsWith("$EARN_NATIVE_BACKEND/"))
        safeEarnGatewayFailure(body)?.let { throw it }
      throw RpcFailure(RpcFailureCode.HTTP)
    }
    return body
  }

  suspend fun execute(method: String, url: String, body: String?): Pair<Int, String> {
    if (method != "GET" && requiresRecoveryPersistence(url, body ?: ""))
      WalletRecoveryRuntime.beforeSubmission()
    return suspendCancellableCoroutine { continuation ->
      require(allowed(url) && (method == "GET" || method == "POST"))
      val request =
        Request.Builder()
          .url(url)
          .apply { requestHeaders.forEach { (name, value) -> header(name, value) } }
          .method(
            method,
            if (method == "GET") null
            else (body ?: "").toRequestBody("application/json".toMediaType()),
          )
          .build()
      val call = client.newCall(request)
      continuation.invokeOnCancellation { call.cancel() }
      call.enqueue(
        object : Callback {
          override fun onFailure(call: Call, e: IOException) {
            if (continuation.isActive)
              continuation.resumeWithException(
                RpcFailure(
                  if (e is java.io.InterruptedIOException) RpcFailureCode.TIMEOUT
                  else RpcFailureCode.NETWORK
                )
              )
          }

          override fun onResponse(call: Call, response: Response) {
            try {
              val result =
                response.use {
                  val payload = it.body ?: throw RpcFailure(RpcFailureCode.HTTP)
                  payload.byteStream().use { input ->
                    val output = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    while (true) {
                      val count = input.read(buffer)
                      if (count == -1) break
                      if (output.size() + count > 1_048_576)
                        throw RpcFailure(RpcFailureCode.RESPONSE_TOO_LARGE)
                      output.write(buffer, 0, count)
                    }
                    it.code to output.toString("UTF-8")
                  }
                }
              if (continuation.isActive) continuation.resume(result)
            } catch (failure: Exception) {
              val safe =
                failure as? RpcFailure
                  ?: RpcFailure(
                    if (failure is java.io.InterruptedIOException) RpcFailureCode.TIMEOUT
                    else RpcFailureCode.NETWORK
                  )
              if (continuation.isActive) continuation.resumeWithException(safe)
            }
          }
        }
      )
    }
  }

  companion object {
    fun allowed(url: String): Boolean {
      val local =
        url.startsWith("http://127.0.0.1:") ||
          url.startsWith("http://localhost:") ||
          url.startsWith("http://10.0.2.2:")
      return (url.startsWith("https://") || local) &&
        !url.contains('?') &&
        !url.contains('#') &&
        url.length <= 300
    }
  }
}

internal class EarnGatewayFailure(val code: String, message: String) : Exception(message)

internal fun safeEarnGatewayFailure(body: String): EarnGatewayFailure? {
  if (body.toByteArray().size > 4096) return null
  val code =
    try {
      org.json.JSONObject(body).getString("code")
    } catch (_: Exception) {
      return null
    }
  val message =
    when (code) {
      "EARN_AURORA_FEE_UNQUALIFIED" ->
        "Provider fee collectors and referral require qualification. No funds moved."
      "EARN_NATIVE_UPGRADE_REQUIRED" ->
        "Install the updated native Gizu build before starting this deposit or return. No funds moved."
      "EARN_SETTLEMENT_UNQUALIFIED" ->
        "Operation-specific settlement access requires qualification. No funds moved."
      "EARN_RECOVERY_UNAVAILABLE",
      "EARN_PAYOUT_RECOVERY_UNCONFIGURED" ->
        "Durable Earn recovery is unavailable. No new operation was signed."
      "EARN_NATIVE_QUOTE_UNAVAILABLE" -> "A fresh executable Earn quote could not be verified."
      "EARN_QUOTE_UNKNOWN_OR_EXPIRED" -> "Earn quote expired. Review fresh terms before signing."
      "EARN_QUOTE_BINDING_CHANGED",
      "EARN_PAYOUT_BINDING_CHANGED" ->
        "Earn quote terms changed. Review the saved operation before retrying."
      "EARN_QUOTE_RECOVERY_REJECTED",
      "EARN_PAYOUT_RECOVERY_REJECTED" ->
        "Saved Earn recovery could not be verified. Reconcile before retrying."
      "EARN_COORDINATION_CONFLICT" ->
        "Saved payout receipt evidence conflicts with an accepted proof. Recovery reconciliation is required."
      "EARN_COORDINATION_UNAVAILABLE" ->
        "Payout verification storage is temporarily unavailable. Saved progress is preserved."
      "EARN_SETTLEMENT_UNAVAILABLE" ->
        "Operation-specific confidential credit is unavailable. Reconcile before proceeding."
      "CONFIDENTIAL_PRIVATE_FUNDING_UNAVAILABLE" ->
        "The private funding provider is unavailable. Saved progress is preserved; retry the remaining deposit."
      "EARN_MINIMUM_RETURN_CONFLICT" ->
        "An earlier private observation overlaps this saved return. Retry reconciliation; do not withdraw from the vault again."
      "EARN_MINIMUM_RETURN_UNAVAILABLE" ->
        "The saved minimum private return could not be verified yet. Retry this check; do not withdraw from the vault again."
      "EARN_SETTLEMENT_HISTORY_UNAVAILABLE" ->
        "Your private balance can be checked on Home, but the exact return record could not be verified yet. Retry this check; do not withdraw from the vault again."
      else -> return null
    }
  return EarnGatewayFailure(code, message)
}

/**
 * Only financial submission routes trigger portable signed-record persistence; reads remain
 * available.
 */
internal fun requiresRecoveryPersistence(endpoint: String, payload: String): Boolean {
  val root = runCatching { org.json.JSONObject(payload) }.getOrNull()
  val method = root?.optString("method")
  return method in setOf("eth_sendRawTransaction", "eth_sendUserOperation") ||
    (endpoint.substringAfterLast('/') in setOf("submit", "submit-intent", "broadcast", "execute"))
}
