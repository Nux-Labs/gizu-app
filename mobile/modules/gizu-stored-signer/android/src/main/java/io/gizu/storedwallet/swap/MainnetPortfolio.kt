package io.gizu.storedwallet.swap

import android.content.Context
import io.gizu.storedwallet.*
import io.gizu.storedwallet.portfolio.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import uniffi.gizu_stored_signer_core.*

/**
 * One device-owned snapshot shared by Swap and Earn; refreshes never upload an account catalogue.
 */
internal class MainnetPortfolio(private val context: Context) {
  suspend fun read(
    record: WalletRecord,
    history: List<Map<String, Any?>>,
    includeOwned: Boolean = true,
  ): Map<String, Any?> = coroutineScope {
    val owned = async {
      try {
        if (includeOwned) NativeOwnedPortfolio(context).read(record) else emptyMap()
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (failure: Exception) {
        PortfolioDiagnostics.event(
          PortfolioDiagnostics.Stage.MAINNET_OWNED,
          PortfolioDiagnostics.Reason.UNAVAILABLE,
          failure = failure,
        )
        mapOf(
          "ownedAssets" to emptyList<Any>(),
          "positions" to emptyList<Any>(),
          "ownedStale" to true,
          "ownedBalanceComplete" to false,
          "ownedSyncPending" to true,
          "valuationComplete" to false,
        )
      }
    }
    val indices = publicAccountIndices(record)
    val accounts =
      indices.indices.toList().chunked(64).flatMap { chunk ->
        currentCoroutineContext().ensureActive()
        derivePortfolioAccounts(
          record.entropy,
          record.roleRegistry,
          chunk.first().toUInt(),
          chunk.size.toUInt(),
        )
      }
    val addresses = accounts.map { it.address }
    val sync = publicUsdcSync(record)
    val snapshot =
      try {
        sync.read(addresses, System.currentTimeMillis())
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: Exception) {
        sync.cachedSnapshot(addresses, System.currentTimeMillis())?.copy(stale = true)
          ?: TokenSnapshot(emptyMap(), "0x0", 0, false, true, true)
      }
    val public =
      buildPublicPortfolio(
        record.id,
        record.roleRegistry,
        accounts.map { PortfolioObservation(it, snapshot.balances[it.address.lowercase()]) },
        PortfolioReadState(
          snapshot.checkedAt.toULong(),
          snapshot.block,
          snapshot.complete,
          snapshot.stale,
          snapshot.syncPending,
        ),
      )
    public.toPublicMap() + mapOf("history" to history) + owned.await()
  }

  private fun publicUsdcSync(record: WalletRecord) =
    mainnetUsdcBalanceSync(
      AndroidWalletFile(context, "gizu-public-balances-${record.journalId}.enc", 4 * 1024 * 1024),
      { checkNotNull(AndroidWalletKeys().existing()) },
      record.id,
      PortfolioReadBudget().wrap(NativePortfolioRpc("https://rpc.monad.xyz"), 143L),
    )

  /** Receiver credits and source debits must bypass the 30-second public USDC cache. */
  fun invalidate(record: WalletRecord) = publicUsdcSync(record).invalidate()

  companion object {
    const val USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603"
  }
}

/** Shared by read/invalidate so the encrypted cache identity cannot diverge. */
internal fun mainnetUsdcBalanceSync(
  file: WalletFile,
  key: () -> javax.crypto.SecretKey,
  walletId: String,
  rpc: PortfolioRpc,
) = TokenBalanceSync(file, key, walletId, 143, MainnetPortfolio.USDC, rpc, ::decodePortfolioBalance)
