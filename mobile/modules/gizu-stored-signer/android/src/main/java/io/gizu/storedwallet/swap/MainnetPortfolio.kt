package io.gizu.storedwallet.swap

import android.content.Context
import io.gizu.storedwallet.*
import io.gizu.storedwallet.portfolio.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
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
    cachedOnly: Boolean = false,
    forceRefresh: Boolean = false,
  ): Map<String, Any?> = coroutineScope {
    val owned = async {
      try {
        if (includeOwned) NativeOwnedPortfolio(context).read(record, cachedOnly, forceRefresh)
        else emptyMap()
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
    // Exactly three chain contexts run concurrently, each with its own cache and deadline.
    val snapshots =
      listOf(143, 8453, 42161)
        .map { chain ->
          async {
            val owners =
              accounts.filter { chain == 143 || it.accountIndex == 1u }.map { it.address }
            val sync = publicUsdcSync(record, chain)
            val snapshot =
              try {
                if (cachedOnly)
                  sync.cachedSnapshot(owners, System.currentTimeMillis())
                    ?: TokenSnapshot(emptyMap(), "0x0", 0, false, true, true)
                else sync.read(owners, System.currentTimeMillis(), forceRefresh)
              } catch (cancelled: CancellationException) {
                throw cancelled
              } catch (_: Exception) {
                sync.cachedSnapshot(owners, System.currentTimeMillis())?.copy(stale = true)
                  ?: TokenSnapshot(emptyMap(), "0x0", 0, false, true, true)
              }
            chain to snapshot
          }
        }
        .awaitAll()
        .toMap()
    val snapshot = snapshots.getValue(143)
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
    val reservations = FundingReservations(context, record)
    val funding =
      fundingPortfolio(
        snapshots.flatMap { (chain, state) ->
          accounts
            .filter { fundingCandidate(it.accountIndex.toInt(), chain) }
            .map { account ->
              FundingObservation(
                chain,
                account.accountIndex.toInt(),
                account.address,
                state.balances[account.address.lowercase()],
                state.checkedAt,
                state.complete,
                state.stale,
                state.syncPending,
                try {
                  reservations.reservedAtoms(account.address, chain)
                } catch (_: Exception) {
                  null
                },
              )
            }
        }
      )
    val ownedValue = owned.await()
    currentCoroutineContext().ensureActive()
    walletStore(context).load().use { current ->
      check(current.id == record.id && current.journalId == record.journalId) {
        "Wallet changed during portfolio observation"
      }
    }
    public.toPublicMap() + funding + mapOf("history" to history) + ownedValue
  }

  private fun publicUsdcSync(record: WalletRecord, chain: Int = 143): TokenBalanceSync {
    val network = fundingNetwork(chain)
    return mainnetUsdcBalanceSync(
      AndroidWalletFile(
        context,
        "gizu-public-balances-${record.journalId}${if (chain == 143) "" else "-$chain"}.enc",
        4 * 1024 * 1024,
      ),
      { checkNotNull(AndroidWalletKeys().existing()) },
      record.id,
      PortfolioReadBudget().wrap(NativePortfolioRpc(network.rpc), chain.toLong()),
      chain,
    )
  }

  /** Receiver credits and source debits must bypass the 30-second public USDC cache. */
  fun invalidate(record: WalletRecord) {
    for (chain in listOf(143, 8453, 42161)) publicUsdcSync(record, chain).invalidate()
  }

  /** After durable credit verification, the exact source's pre-credit observation is obsolete. */
  fun invalidateConfirmedFunding(record: WalletRecord, sourceChainId: Int, owner: String) {
    publicUsdcSync(record, sourceChainId).invalidateConfirmedFunding(owner)
    NativeOwnedPortfolio(context).invalidateConfirmedFunding(record, sourceChainId.toLong(), owner)
  }

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
  chain: Int = 143,
) =
  TokenBalanceSync(
    file,
    key,
    walletId,
    chain.toLong(),
    fundingNetwork(chain).token,
    rpc,
    ::decodePortfolioBalance,
  )
