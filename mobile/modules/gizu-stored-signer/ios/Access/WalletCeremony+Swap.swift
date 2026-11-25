import CryptoKit
import Foundation

@available(iOS 18.0, *)
@MainActor extension WalletCeremony {
  func swapDeposit() throws -> [String: Any] {
    let record = try store.load()
    defer { record.close() }
    try require(record.verified)
    let address = try deriveAccountAddressRange(entropy: record.entropy, start: 1, count: 1).first
    return ["fundingAddress": address as Any]
  }

  func startSwap(target: String, amountAtoms: String?, gateway: String, chainId: UInt64)
    async throws -> [String: Any]
  {
    try await runSwap(gateway: gateway, intent: .buy(target, amountAtoms, chainId))
  }

  func startSell(gateway: String) async throws -> [String: Any] {
    try await runSwap(gateway: gateway, intent: .sell(nil))
  }

  func resumeSwap(gateway: String) async throws -> [String: Any] {
    try await runSwap(gateway: gateway, intent: .resume)
  }

  func sellSwapHolding(id: String, gateway: String) async throws -> [String: Any] {
    try await runSwap(gateway: gateway, intent: .sell(id))
  }

  func startRecovery(target: String, gateway: String, chainId: UInt64) async throws -> [String:
    Any]
  {
    try await runSwap(gateway: gateway, intent: .recover(target, chainId))
  }

  func startPayout(target: String, gateway: String, chainId: UInt64) async throws -> [String: Any]
  {
    try await runSwap(gateway: gateway, intent: .payout(target, chainId))
  }

  /// Buys and recoveries carry the chain their target trades on; sells resolve it from the ledger.
  private enum SwapIntent {
    case buy(String, String?, UInt64)
    case sell(String?)
    case resume
    case recover(String, UInt64)
    case payout(String, UInt64)
  }

  func swapStatus(gateway: String) throws -> [String: Any] {
    let record = try store.load()
    defer { record.close() }
    let saved = try StoredSwapFile(store: store, record: record)
    if try saved.load() == nil { return ["phase": "NONE"] }
    let engine = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    defer { engine.close() }
    try engine.restore()
    return try engine.view()
  }

  func cancelSwap(gateway: String) throws -> [String: Any] {
    let record = try store.load()
    defer { record.close() }
    let engine = try StoredSwapEngine(
      storage: store, saved: StoredSwapFile(store: store, record: record), gateway: gateway)
    defer { engine.close() }
    try engine.restore()
    try engine.cancel()
    return try engine.view()
  }

  private func runSwap(gateway: String, intent: SwapIntent) async throws
    -> [String: Any]
  {
    try require(StoredSwapHTTP.allowed(gateway))
    let record = try store.load()
    defer { record.close() }
    try assertCashoutInactive(store: store, record: record)
    let credential = record.credential
    let walletId = record.id
    let engine = try StoredSwapEngine(
      storage: store, saved: StoredSwapFile(store: store, record: record), gateway: gateway)
    defer {
      record.close()
      engine.close()
    }
    try require(record.verified)
    switch intent {
    case .resume:
      try engine.restore()
      try engine.retry()
    case .sell(let id): try engine.startSell(record: record, holdingId: id)
    case .buy(let target, let amount, let chain):
      try engine.start(record: record, target: target, amountAtoms: amount, chainId: chain)
    case .recover(let target, let chain):
      try engine.startRecovery(record: record, target: target, chainId: chain)
    case .payout(let target, let chain):
      try engine.start(record: record, target: target, amountAtoms: nil, payout: true, chainId: chain)
    }
    record.close()
    let screen = try await presentWalletUI()
    screen.networkLabel = "GIZU · MAINNET"
    while true {
      try checkAuthorization()
      switch try await engine.advance(onProgress: { view in
        let phase = view["phase"] as? String ?? "Preparing"
        let step = view["step"] as? String ?? ""
        screen.show(
          "Swap in progress",
          "\(phase) · \(step)\nKeep this screen open. You can close it and resume later from Swap.")
      }) {
      case .review(let text):
        try await screen.confirm("Review swap", text, action: "Approve for 15 minutes")
        let digest = Data(SHA256.hash(data: Data(text.utf8))).map { String(format: "%02x", $0) }
          .joined()
        let id = try engine.view()["operationId"] as? String ?? ""
        _ = try await authorize(credential, walletId: walletId, purpose: "swap:v1:\(id):\(digest)")
        let fresh = try store.load()
        defer { fresh.close() }
        try checkAuthorization()
        try engine.approve(record: fresh)
      case .unlock:
        try await screen.confirm(
          "New unlock required",
          "The 15-minute authorization ended. Unlock the same plan to continue.",
          action: "Unlock")
        let id = try engine.view()["operationId"] as? String ?? ""
        _ = try await authorize(credential, walletId: walletId, purpose: "swap-unlock:v1:\(id)")
        let fresh = try store.load()
        defer { fresh.close() }
        try checkAuthorization()
        try engine.unlock(record: fresh)
      case .done(let view):
        return view
      }
    }
  }
}
