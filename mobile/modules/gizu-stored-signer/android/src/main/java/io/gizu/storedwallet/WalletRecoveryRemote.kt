package io.gizu.storedwallet

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

internal data class RecoveryObject(val revision: Long, val ciphertext: String)

internal class WalletRecoveryFailure(val code: String) : Exception(code)

internal interface WalletRecoveryRemote {
  suspend fun get(id: String, token: String): RecoveryObject?

  suspend fun delete(id: String, token: String)

  suspend fun put(id: String, token: String, expected: Long, ciphertext: String): RecoveryObject
}

internal class HttpWalletRecoveryRemote : WalletRecoveryRemote {
  private val client =
    OkHttpClient.Builder()
      .followRedirects(false)
      .followSslRedirects(false)
      .retryOnConnectionFailure(false)
      .callTimeout(30, TimeUnit.SECONDS)
      .build()
  private val base = EARN_NATIVE_BACKEND.substringBefore("/v1/earn") + "/wallet-recovery/v1/"

  override suspend fun get(id: String, token: String) = request(id, token, null)

  override suspend fun put(id: String, token: String, expected: Long, ciphertext: String) =
    checkNotNull(
      request(
        id,
        token,
        JSONObject().put("expectedRevision", expected).put("ciphertext", ciphertext).toString(),
      )
    )

  override suspend fun delete(id: String, token: String) =
    withContext(Dispatchers.IO) {
      require(id.matches(Regex("[0-9a-f]{64}")) && token.matches(Regex("[0-9a-f]{64}")))
      val request =
        Request.Builder()
          .url(base + id)
          .header("Authorization", "Bearer $token")
          .header("Cache-Control", "no-store")
          .delete()
          .build()
      try {
        client.newCall(request).execute().use {
          if (it.code != 204) throw WalletRecoveryFailure("RECOVERY_UNAVAILABLE")
        }
      } catch (e: WalletRecoveryFailure) {
        throw e
      } catch (_: Exception) {
        throw WalletRecoveryFailure("RECOVERY_UNAVAILABLE")
      }
    }

  private suspend fun request(id: String, token: String, body: String?): RecoveryObject? =
    withContext(Dispatchers.IO) {
      require(id.matches(Regex("[0-9a-f]{64}")) && token.matches(Regex("[0-9a-f]{64}")))
      val request =
        Request.Builder()
          .url(base + id)
          .header("Authorization", "Bearer $token")
          .header("Cache-Control", "no-store")
          .method(
            if (body == null) "GET" else "PUT",
            body?.toRequestBody("application/json".toMediaType()),
          )
          .build()
      try {
        client.newCall(request).execute().use { response ->
          if (response.code == 404 && body == null) return@withContext null
          if (!response.isSuccessful)
            throw WalletRecoveryFailure(
              if (response.code == 409) "RECOVERY_CONFLICT" else "RECOVERY_UNAVAILABLE"
            )
          val stream = checkNotNull(response.body).byteStream()
          val bytes = stream.use { it.readBytesBounded(1_400_000) }
          val root = JSONObject(String(bytes, Charsets.UTF_8))
          require(root.getInt("version") == 1 && root.getLong("revision") > 0)
          RecoveryObject(root.getLong("revision"), root.getString("ciphertext"))
        }
      } catch (e: WalletRecoveryFailure) {
        throw e
      } catch (_: Exception) {
        throw WalletRecoveryFailure("RECOVERY_UNAVAILABLE")
      }
    }
}

internal fun java.io.InputStream.readBytesBounded(limit: Int): ByteArray {
  val out = java.io.ByteArrayOutputStream()
  val buffer = ByteArray(8192)
  while (true) {
    val n = read(buffer)
    if (n < 0) break
    require(out.size() + n <= limit)
    out.write(buffer, 0, n)
  }
  return out.toByteArray()
}
