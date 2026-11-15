import Foundation

@available(iOS 18.0, *)
@MainActor extension WalletCeremony {
  private func earnVaultJournal(_ walletId: String) throws -> EarnVaultJournal {
    let record = try store.load()
    defer { record.close() }
    try EarnVaultEngine.requireWallet(record, walletId: walletId)
    return EarnVaultJournal(store: store, record: record)
  }
  func listEarnVaultOperations(walletId: String) async throws -> [[String: Any]] {
    let journal = try earnVaultJournal(walletId)
    try await reconcileEarnVault(journal, rpc: EarnVaultRPC())
    try checkAuthorization()
    let record = try store.load()
    defer { record.close() }
    try EarnVaultEngine.requireWallet(record, walletId: walletId)
    try require(record.journalId == journal.generation)
    return try journal.all().filter { Int($0.proposal.cycleIndex) == record.earnCycleIndex }.map {
      try $0.publicValue
    }
  }
  func cancelEarnVaultOperation(walletId: String, id: String, revision: Int) throws -> [String: Any]
  {
    let journal = try earnVaultJournal(walletId)
    guard let revision = UInt32(exactly: revision) else { throw WalletFailure.invalid }
    let record = try store.load()
    defer { record.close() }
    try require(try Int(journal.get(id).proposal.cycleIndex) == record.earnCycleIndex)
    return try journal.update(id, revision: revision) { $0.cancelled = true }.publicValue
  }
  func earnVault(
    _ request: [String: Any]?, walletId: String, id: String? = nil, revision: Int? = nil
  ) async throws -> [String: Any] {
    let identity = try store.load()
    defer { identity.close() }
    try assertCashoutInactive(store: store, record: identity)
    identity.close()
    let journal = try earnVaultJournal(walletId)
    let engine = EarnVaultEngine(store: store, journal: journal, rpc: EarnVaultRPC())
    defer { engine.close() }
    let screen = try await presentWalletUI()
    screen.networkLabel = "GIZU · ETHEREUM MAINNET"
    screen.show(
      "Preparing vault operation",
      "Checking live balances, contract state and prior transactions. Nothing has been signed.")
    let op: EarnVaultRecord
    if let request {
      op = try await engine.create(request)
    } else {
      guard let id, let revision else { throw WalletFailure.invalid }
      op = try journal.get(id)
      try require(Int(op.revision) == revision)
    }
    let review = try await engine.prepare(op.operationId, revision: op.revision)
    try checkAuthorization()
    try await screen.confirm(
      op.proposal.kind == "vaultDeposit"
        ? "Review vault investment" : "Review full vault withdrawal",
      review.text, action: "Approve and unlock passkey")
    let record = try store.load()
    let credential = record.credential
    record.close()
    _ = try await authorize(
      credential, walletId: walletId,
      purpose: "earn-vault:v1:\(review.id):\(review.revision):\(review.hash)")
    try checkAuthorization()
    screen.show(
      "Submitting approved transaction",
      "Already submitted transactions cannot be undone. Status refresh never submits another transaction."
    )
    do { try await engine.execute(review, authority: checkAuthorization) } catch {
      try checkAuthorization()
      // Preserve and expose a locked unknown outcome when signing was durably recorded.
      if try journal.get(op.operationId).unresolved.isEmpty { throw error }
    }
    return try journal.get(op.operationId).publicValue
  }
}
