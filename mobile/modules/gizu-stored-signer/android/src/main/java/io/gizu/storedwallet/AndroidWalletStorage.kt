package io.gizu.storedwallet

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

internal fun walletStore(context: Context) =
  WalletStore(AndroidWalletFile(context, limit = 16 * 1024 * 1024), AndroidWalletKeys())

internal class AndroidWalletFile(
  context: Context,
  name: String = "gizu-stored-wallet-v1.enc",
  limit: Int = 8192,
) : WalletFile {
  companion object {
    private val locks = java.util.concurrent.ConcurrentHashMap<String, Any>()
  }

  private val lock = locks.getOrPut(File(context.noBackupFilesDir, name).absolutePath) { Any() }
  private val delegate =
    PagedWalletFile(
      AndroidAtomicWalletFile(context, name, maxOf(limit, 64 * 1024)),
      { id -> AndroidAtomicWalletFile(context, "$name.page-$id", PagedWalletFile.PAGE_BYTES) },
      maxOf(limit, 16 * 1024 * 1024),
      { keep ->
        context.noBackupFilesDir
          .listFiles()
          ?.filter {
            it.name.startsWith("$name.page-") && it.name.removePrefix("$name.page-") !in keep
          }
          ?.forEach { it.delete() }
      },
    )

  override fun exists() = synchronized(lock) { delegate.exists() }

  override fun read() = synchronized(lock) { delegate.read() }

  override fun write(bytes: ByteArray) = synchronized(lock) { delegate.write(bytes) }
}

internal class AndroidAtomicWalletFile(
  context: Context,
  name: String = "gizu-stored-wallet-v1.enc",
  private val limit: Int = 8192,
) : WalletFile {
  private val base = File(context.noBackupFilesDir, name)
  private val pending = File(base.path + ".new")

  private fun syncDirectory() {
    val descriptor = Os.open(base.parentFile!!.path, OsConstants.O_RDONLY, 0)
    try {
      Os.fsync(descriptor)
    } finally {
      Os.close(descriptor)
    }
  }

  private fun recoverLegacyBackup() {
    val backup = File(base.path + ".bak")
    if (backup.exists()) {
      Os.rename(backup.path, base.path)
      syncDirectory()
    }
  }

  override fun exists() = base.exists() || File(base.path + ".bak").exists()

  override fun read(): ByteArray {
    recoverLegacyBackup()
    return base.inputStream().use { input ->
      // Bounded before allocation even if local data is corrupt.
      val buffer = ByteArray(limit + 1)
      var used = 0
      while (used < buffer.size) {
        val n = input.read(buffer, used, buffer.size - used)
        if (n < 0) break
        used += n
      }
      require(used <= limit)
      buffer.copyOf(used)
    }
  }

  override fun write(bytes: ByteArray) {
    require(bytes.size <= limit)
    recoverLegacyBackup()
    commitWalletFile(
      bytes,
      object : WalletFileCommit {
        override fun writeAndSync(bytes: ByteArray) {
          FileOutputStream(pending).use { stream ->
            stream.write(bytes)
            stream.fd.sync()
          }
        }

        override fun replace() {
          Os.rename(pending.path, base.path)
        }

        override fun syncParent() {
          syncDirectory()
        }

        override fun readCommitted() = read()

        override fun discardPending() {
          pending.delete()
        }
      },
    )
  }
}

internal class AndroidWalletKeys : WalletKeys {
  private val alias = "io.gizu.storedwallet.v1.wallet-aes"

  private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  override fun existing(): SecretKey? = store().getKey(alias, null) as? SecretKey

  override fun reset(): SecretKey {
    store().deleteEntry(alias)
    return create()
  }

  override fun create(): SecretKey {
    check(!store().containsAlias(alias))
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
      .apply {
        init(
          KeyGenParameterSpec.Builder(
              alias,
              KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(false)
            .build()
        )
      }
      .generateKey()
  }
}
