import Foundation

@available(iOS 18.0, *)
@MainActor extension WalletCeremony {
  private func cashoutJournal(_ walletId: String) throws -> CashoutJournal {
    try checkAuthorization()
    let record = try store.load()
    defer { record.close() }
    try require(record.id == walletId && record.verified)
    return CashoutJournal(store: store, record: record)
  }
  func getCashout(walletId: String) throws -> Any {
    try cashoutJournal(walletId).active()?.publicValue() as Any? ?? NSNull()
  }
  func cancelCashout(_ request: [String: Any]) throws -> [String: Any] {
    try require(Set(request.keys) == ["walletId", "operationId"])
    let journal = try cashoutJournal(CashoutJSON.string(request, "walletId"))
    return try journal.cancel(journal.get(CashoutJSON.string(request, "operationId"))).publicValue()
  }
  private func cashoutEngine(_ walletId: String) async throws -> CashoutEngine {
    let journal = try cashoutJournal(walletId)
    let identity = try store.load()
    let credential = identity.credential
    identity.close()
    let screen = try await presentWalletUI()
    screen.networkLabel = "GIZU · MONAD MAINNET"
    try await screen.confirm(
      "Check private withdrawal balance",
      "Authenticate read-only checks of your wallet's confidential USDC accounts. Gizu and the confidential provider receive those account identities. This does not authorize spending. You will review the withdrawal and confirm your passkey separately before signing."
    )
    _ = try await authorize(
      credential, walletId: walletId, purpose: "cashout-read:v1:\(journal.generation)")
    try checkAuthorization()
    let api = ConfidentialBalance()
    func auth(_ source: CashoutSource, _ salt: Data) throws -> EarnReadAuthentication {
      try self.checkAuthorization()
      let record = try self.store.load()
      defer { record.close() }
      try require(
        record.id == walletId && record.journalId == journal.generation && record.verified)
      try require(
        try cashoutSources(record).contains {
          $0.kind == source.kind && $0.profileChainId == source.profileChainId
            && $0.cycleIndex == source.cycleIndex
            && $0.address.lowercased() == source.address.lowercased()
        })
      let started = UInt64(Date().timeIntervalSince1970 * 1000)
      let random = try randomBytes(7)
      return source.kind == "swap"
        ? try authenticateSwapRead(
          entropy: record.entropy, salt: salt, random: random, startedMs: started, nowMs: started)
        : try authenticateEarnCycleRead(
          entropy: record.entropy, chainId: source.profileChainId,
          cycleIndex: source.cycleIndex, salt: salt, random: random, startedMs: started,
          nowMs: started)
    }
    let gateway = NativeCashoutGateway(authenticate: { sources in
      try require((1...32).contains(sources.count))
      let salt = try await api.salt()
      let started = Date()
      let values = try sources.map { source -> [String: Any] in
        let proof = try auth(source, salt)
        return ["standard": "erc191", "payload": proof.payload, "signature": proof.signature]
      }
      try require(Date().timeIntervalSince(started) <= 45)
      return values
    })
    return CashoutEngine(
      store: store, journal: journal, gateway: gateway,
      read: { source in
        let salt = try await api.salt()
        let proof = try auth(source, salt)
        let result = try await api.read(proof, address: source.address)
        try self.checkAuthorization()
        return result
      }, authority: checkAuthorization, catalogue: cashoutSources,
      assertCanStart: { record in try assertCashoutCanStart(store: self.store, record: record) })
  }
  func prepareCashout(_ request: [String: Any]) async throws -> [String: Any] {
    try require(Set(request.keys) == ["walletId", "amountAtoms"])
    let engine = try await cashoutEngine(CashoutJSON.string(request, "walletId"))
    return try await engine.prepare(amount: CashoutJSON.string(request, "amountAtoms"))
  }
  func executeCashout(_ request: [String: Any], resume: Bool = false) async throws -> [String: Any]
  {
    try require(
      Set(request.keys)
        == (resume ? ["walletId", "operationId"] : ["walletId", "operationId", "revision"]))
    let wallet = try CashoutJSON.string(request, "walletId")
    let id = try CashoutJSON.string(request, "operationId")
    let journal = try cashoutJournal(wallet)
    let row = try journal.get(id)
    let revision = resume ? UInt64(row.revision) : try CashoutJSON.uint(request, "revision")
    try require(revision == UInt64(row.revision) && revision > 0)
    let engine = try await cashoutEngine(wallet)
    return try await engine.execute(id: id, revision: UInt32(revision)) { text, hash in
      let screen = try await self.presentWalletUI()
      try await screen.confirm("Review withdrawal", text, action: "Approve and unlock passkey")
      let record = try self.store.load()
      let credential = record.credential
      defer { record.close() }
      try require(record.id == wallet && record.journalId == journal.generation && record.verified)
      record.close()
      _ = try await self.authorize(
        credential, walletId: wallet,
        purpose: "cashout:v1:\(id):\(revision):\(hash)")
      try self.checkAuthorization()
      screen.show(
        "Submitting approved withdrawal",
        "Signed transfers cannot be cancelled. Interrupted withdrawals retain their original signed bytes for recovery."
      )
    }
  }
}
