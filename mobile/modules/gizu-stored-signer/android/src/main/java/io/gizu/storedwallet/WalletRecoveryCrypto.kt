package io.gizu.storedwallet

import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** RFC5869 independent domains, recoverable from the entropy in every released backup. */
internal class WalletRecoveryCrypto(entropy: ByteArray) : AutoCloseable {
  private val prk = hmac("gizu-wallet-recovery:v1:hkdf-sha256".toByteArray(), entropy)

  private fun derive(domain: String) =
    hmac(prk, "gizu-wallet-recovery:v1:$domain".toByteArray() + byteArrayOf(1))

  val locator = hex(derive("locator"))
  val token = hex(derive("authentication"))
  private val encryption = derive("encryption")

  fun pageLocator(ciphertext: String) = hex(hmac(derive("pages"), ciphertext.toByteArray()))

  private fun aad(id: String, revision: Long) = "gizu-wallet-recovery:$id:1:$revision".toByteArray()

  fun encrypt(id: String, revision: Long, clear: ByteArray): String {
    require(revision > 0)
    return Base64.getUrlEncoder()
      .withoutPadding()
      .encodeToString(
        CryptoEnvelope.encrypt(SecretKeySpec(encryption, "AES"), clear, aad(id, revision))
      )
  }

  fun decrypt(id: String, revision: Long, ciphertext: String): ByteArray {
    require(
      revision > 0 && ciphertext.length <= 1_398_102 && ciphertext.matches(Regex("[A-Za-z0-9_-]+"))
    )
    return CryptoEnvelope.decrypt(
      SecretKeySpec(encryption, "AES"),
      Base64.getUrlDecoder().decode(ciphertext),
      aad(id, revision),
    )
  }

  override fun close() {
    prk.fill(0)
    encryption.fill(0)
  }

  companion object {
    private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
      Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256"))
        doFinal(data)
      }

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
  }
}
