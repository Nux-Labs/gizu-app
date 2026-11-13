import ExpoModulesCore
import UIKit

public final class GizuStoredSignerModule: Module {
  @MainActor private static var occupied = false
  @MainActor private var ceremony: WalletCeremony?
  @MainActor private var task: Task<Void, Never>?
  private static var supported: Bool { WalletBuildPolicy.isAvailable() }

  private func run(
    _ promise: Promise, operation: StaticString, timeout: UInt64 = 120_000_000_000,
    action: @escaping @MainActor (WalletCeremony) async throws -> Any
  ) {
    Task { @MainActor in
      let diagnostics = WalletDiagnostics(operation: operation)
      diagnostics.mark("presenter-check")
      guard Self.supported, #available(iOS 18.0, *),
        let presenter = self.appContext?.utilities?.currentViewController(),
        presenter.view.window != nil
      else {
        diagnostics.failed(WalletFailure.unavailable)
        promise.reject("UNAVAILABLE", "iOS wallet unavailable in this build.")
        return
      }

      diagnostics.mark("occupancy-check")
      guard !Self.occupied else {
        diagnostics.failed(WalletFailure.busy)
        promise.reject("BUSY", "A native wallet operation is already in progress.")
        return
      }

      Self.occupied = true
      self.task = Task { @MainActor in
        var timeoutTask: Task<Void, Never>?
        var timedOut = false
        defer {
          diagnostics.mark("cleanup")
          timeoutTask?.cancel()
          self.ceremony?.close()
          self.ceremony = nil
          self.task = nil
          Self.occupied = false
          diagnostics.event("released")
        }

        do {
          diagnostics.mark("storage-initialization")
          let scope = try WalletCeremony(
            presenter: presenter, diagnostics: diagnostics,
            window: timeout == 900_000_000_000 ? .swap : .wallet)
          self.ceremony = scope
          scope.cancelTask = { [weak self] in self?.task?.cancel() }
          timeoutTask = Task { @MainActor [weak scope] in
            do {
              try await Task.sleep(nanoseconds: timeout)
              timedOut = true
              diagnostics.event("timeout")
              scope?.cancel()
            } catch {}
          }

          try scope.checkAuthorization()
          let result = try await action(scope)
          try scope.checkAuthorization()
          diagnostics.mark("resolve")
          promise.resolve(result)
        } catch WalletFailure.insufficientBalance {
          diagnostics.failed(WalletFailure.insufficientBalance)
          promise.reject(
            "INSUFFICIENT_BALANCE",
            "Not enough testnet MON for the transfer amount and maximum network fees.")
        } catch {
          diagnostics.failed(error)
          promise.reject(
            timedOut ? "WALLET_TIMEOUT" : WalletDiagnostics.bridgeCode(error),
            "Wallet operation stopped, expired or failed. Check wallet state and refresh transfer status before retrying. No existing wallet is replaced automatically."
          )
        }
      }
    }
  }
  public func definition() -> ModuleDefinition {
    Name("GizuStoredSigner")
    AsyncFunction("getCapabilities") { () -> [String: Any] in
      [
        "contractVersion": 1, "available": Self.supported, "walletStorage": Self.supported,
        "backup": Self.supported, "transfers": Self.supported, "swaps": Self.supported,
        "earnWallets": Self.supported,
        "earnVaultExecution": Self.supported,
        "earnSponsoredExecution": false,
        "earnPrivatePayoutExecution": false,
        "earnEthereumLiquidityExecution": false,
        "earnDepositJourney": false,
        "earnBalanceDeltaSettlement": false,
      ]
    }

    AsyncFunction("getWalletState") { (promise: Promise) in
      self.run(promise, operation: "getWalletState") { try $0.publicState() }
    }

    AsyncFunction("createWallet") { (promise: Promise) in
      self.run(promise, operation: "createWallet") { try await $0.create() }
    }

    AsyncFunction("openWallet") { (promise: Promise) in
      self.run(promise, operation: "openWallet") { try await $0.open() }
    }
    AsyncFunction("backupWallet") { (promise: Promise) in
      self.run(promise, operation: "backupWallet") { try await $0.backup() }
    }

    AsyncFunction("restoreWallet") { (promise: Promise) in
      self.run(promise, operation: "restoreWallet") { try await $0.restore() }
    }

    // Keep the contract named on both platforms. iOS cannot sign vault operations until
    // pinned chain state, durable raw-byte recovery and receipt semantics have parity.
    AsyncFunction("prepareEarnSourceQuote") { (_: String, _: String, _: String, _: Int, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native sponsored earn execution is unavailable on iOS in this build.")
    }
    AsyncFunction("prepareEarnReturnQuote") { (_: String, _: String, _: String, _: Int, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native sponsored earn execution is unavailable on iOS in this build.")
    }
    AsyncFunction("executeEarnSponsored") { (_: [String: Any], promise: Promise) in
      promise.reject("UNAVAILABLE", "Native sponsored earn execution is unavailable on iOS in this build.")
    }
    AsyncFunction("listEarnSponsoredOperations") { (_: String, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native sponsored earn execution is unavailable on iOS in this build.")
    }
    AsyncFunction("listEarnCycleOperations") { (_: String, _: Int, _: Int, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native sponsored earn execution is unavailable on iOS in this build.")
    }
    AsyncFunction("resumeEarnSponsoredOperation") { (_: String, _: String, _: Int, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native sponsored earn execution is unavailable on iOS in this build.")
    }
    AsyncFunction("cancelEarnSponsoredOperation") { (_: String, _: String, _: Int, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native sponsored earn execution is unavailable on iOS in this build.")
    }
    AsyncFunction("readEarnSponsoredSettlement") { (_: String, _: String, _: Int, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native sponsored earn execution is unavailable on iOS in this build.")
    }

    AsyncFunction("executeEarnPrivatePayout") { (_: [String: Any], promise: Promise) in
      promise.reject("UNAVAILABLE", "Native private payout execution is unavailable on iOS in this build.")
    }
    AsyncFunction("listEarnPrivatePayoutOperations") { (_: String, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native private payout execution is unavailable on iOS in this build.")
    }
    AsyncFunction("resumeEarnPrivatePayoutOperation") { (_: String, _: String, _: Int, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native private payout execution is unavailable on iOS in this build.")
    }
    AsyncFunction("cancelEarnPrivatePayoutOperation") { (_: String, _: String, _: Int, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native private payout execution is unavailable on iOS in this build.")
    }
    AsyncFunction("readEarnPrivatePayoutSettlement") { (_: String, _: String, _: Int, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native private payout execution is unavailable on iOS in this build.")
    }

    AsyncFunction("prepareEarnFusionQuote") { (_: [String: Any], promise: Promise) in
      promise.reject("UNAVAILABLE", "Native Ethereum liquidity is unavailable on iOS in this build.")
    }
    AsyncFunction("prepareEarnEthereumReturnQuote") { (_: String, _: String, _: String, _: Int, _: String, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native Ethereum liquidity is unavailable on iOS in this build.")
    }
    AsyncFunction("executeEarnEthereumLiquidity") { (_: [String: Any], promise: Promise) in
      promise.reject("UNAVAILABLE", "Native Ethereum liquidity is unavailable on iOS in this build.")
    }
    AsyncFunction("listEarnEthereumLiquidityOperations") { (_: String, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native Ethereum liquidity is unavailable on iOS in this build.")
    }
    AsyncFunction("resumeEarnEthereumLiquidityOperation") { (_: String, _: String, _: Int, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native Ethereum liquidity is unavailable on iOS in this build.")
    }
    AsyncFunction("cancelEarnEthereumLiquidityOperation") { (_: String, _: String, _: Int, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native Ethereum liquidity is unavailable on iOS in this build.")
    }
    AsyncFunction("cancelPendingEarnEthereumLiquidityOperation") { (_: String, _: String, _: Int, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native Ethereum liquidity cancellation is unavailable on iOS in this build.")
    }
    AsyncFunction("readEarnEthereumLiquiditySettlement") { (_: String, _: String, _: Int, promise: Promise) in
      promise.reject("UNAVAILABLE", "Native Ethereum liquidity is unavailable on iOS in this build.")
    }

    AsyncFunction("executeEarnVault") { (request: [String: Any], promise: Promise) in
      self.run(promise, operation: "executeEarnVault") { scope in
        guard let walletId = request["walletId"] as? String else { throw WalletFailure.invalid }
        return try await scope.earnVault(request, walletId: walletId)
      }
    }
    AsyncFunction("listEarnVaultOperations") { (walletId: String, promise: Promise) in
      self.run(promise, operation: "listEarnVaultOperations") {
        try await $0.listEarnVaultOperations(walletId: walletId)
      }
    }
    AsyncFunction("resumeEarnVaultOperation") { (walletId: String, id: String, revision: Int, promise: Promise) in
      self.run(promise, operation: "resumeEarnVaultOperation") {
        try await $0.earnVault(nil, walletId: walletId, id: id, revision: revision)
      }
    }
    AsyncFunction("cancelEarnVaultOperation") { (walletId: String, id: String, revision: Int, promise: Promise) in
      self.run(promise, operation: "cancelEarnVaultOperation") {
        try $0.cancelEarnVaultOperation(walletId: walletId, id: id, revision: revision)
      }
    }

    AsyncFunction("executeOperation") { (proposal: [String: Any], promise: Promise) in
      self.run(promise, operation: "executeOperation") { try await $0.transfer(proposal) }
    }
    AsyncFunction("getEarnIntent") { (walletId: String, promise: Promise) in
      self.run(promise, operation: "getEarnIntent") { try $0.earnIntent(walletId: walletId) }
    }
    AsyncFunction("readEarnBalance") { (walletId: String, promise: Promise) in
      self.run(promise, operation: "readEarnBalance") { try await $0.readEarnBalance(walletId:walletId) }
    }
    AsyncFunction("prepareEarnIntent") { (walletId: String, profile: String, promise: Promise) in
      self.run(promise, operation: "prepareEarnIntent") { try await $0.prepareEarnIntent(walletId: walletId, profile: profile) }
    }

    AsyncFunction("listOperations") { (promise: Promise) in
      self.run(promise, operation: "listOperations") { scope in
        let journal = try scope.journal()
        try await reconcile(journal, rpc: StoredMonadRPC())
        return try journal.all().map(\.publicValue)
      }
    }

    AsyncFunction("getOperationStatus") { (id: String, promise: Promise) in
      self.run(promise, operation: "getOperationStatus") { scope in
        let journal = try scope.journal()
        try await reconcile(journal, rpc: StoredMonadRPC())
        return try journal.get(id).publicValue
      }
    }

    AsyncFunction("resumeOperation") { (id: String, revision: Int, promise: Promise) in
      self.run(promise, operation: "resumeOperation") {
        try await $0.transfer(nil, id: id, revision: revision)
      }
    }

    AsyncFunction("cancelOperation") { (id: String, promise: Promise) in
      Task { @MainActor in
        if self.ceremony?.operationId == id {
          self.ceremony?.cancel()
          await self.task?.value
        }

        self.run(promise, operation: "cancelOperation") { scope in
          try scope.journal().update(id) { $0.cancelled = true }.publicValue
        }
      }
    }

    AsyncFunction("getSwapDeposit") { (promise: Promise) in
      self.run(promise, operation: "getSwapDeposit") { try $0.swapDeposit() }
    }
    AsyncFunction("getMainnetPortfolio") { (promise: Promise) in
      self.run(promise, operation: "getMainnetPortfolio") { scope in
        try await MainnetPortfolio(rpc: NativeMainnetPortfolioRPC()).read(store: scope.store)
      }
    }
    AsyncFunction("startSwap") {
      (target: String, amountAtoms: String, gateway: String, promise: Promise) in
      self.run(promise, operation: "startSwap", timeout: 900_000_000_000) {
        try await $0.startSwap(
          target: target, amountAtoms: amountAtoms.isEmpty ? nil : amountAtoms, gateway: gateway)
      }
    }
    AsyncFunction("getSwapHoldings") { (target: String, promise: Promise) in
      self.run(promise, operation: "getSwapHoldings") { scope in
        try await SwapHoldings(rpc: NativeMainnetPortfolioRPC(network: .robinhood))
          .read(store: scope.store, target: target)
      }
    }
    AsyncFunction("sellSwapHolding") { (id: String, gateway: String, promise: Promise) in
      self.run(promise, operation: "sellSwapHolding", timeout: 900_000_000_000) {
        try await $0.sellSwapHolding(id: id, gateway: gateway)
      }
    }
    AsyncFunction("startRecovery") { (target: String, gateway: String, promise: Promise) in
      self.run(promise, operation: "startRecovery", timeout: 900_000_000_000) {
        try await $0.startRecovery(target: target, gateway: gateway)
      }
    }
    AsyncFunction("startPayout") { (target: String, gateway: String, promise: Promise) in
      self.run(promise, operation: "startPayout", timeout: 900_000_000_000) {
        try await $0.startPayout(target: target, gateway: gateway)
      }
    }
    AsyncFunction("startSell") { (gateway: String, promise: Promise) in
      self.run(promise, operation: "startSell", timeout: 900_000_000_000) {
        try await $0.startSell(gateway: gateway)
      }
    }
    AsyncFunction("resumeSwap") { (gateway: String, promise: Promise) in
      self.run(promise, operation: "resumeSwap", timeout: 900_000_000_000) {
        try await $0.resumeSwap(gateway: gateway)
      }
    }
    AsyncFunction("getSwapStatus") { (gateway: String, promise: Promise) in
      self.run(promise, operation: "getSwapStatus") { try $0.swapStatus(gateway: gateway) }
    }
    AsyncFunction("cancelSwap") { (gateway: String, promise: Promise) in
      self.run(promise, operation: "cancelSwap") { try $0.cancelSwap(gateway: gateway) }
    }
    Function("lock") {
      Task { @MainActor in
        self.task?.cancel()
        self.ceremony?.cancel()
      }
    }

    OnDestroy {
      Task { @MainActor in
        self.task?.cancel()
        self.ceremony?.cancel()
      }
    }
  }
}
