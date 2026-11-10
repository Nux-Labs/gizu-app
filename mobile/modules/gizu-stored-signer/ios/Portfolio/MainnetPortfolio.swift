import Foundation

internal struct MainnetPortfolio {
  static let usdc = "0x754704bc059f8c67012fed69bc8a327a5aafb603"
  let rpc: MainnetPortfolioRPC
  var clock: () -> UInt64 = { UInt64(Date().timeIntervalSince1970 * 1000) }

  /// Runs off the main actor; secrets are released before the first network request.
  func read(store: WalletStorage) async throws -> [String: Any] {
    let record = try store.load()
    let walletId = record.id
    let registry = record.roleRegistry
    let saved = StoredSwapFile(store: store, record: record)
    let accounts: [PortfolioAccount]
    do {
      defer { record.close() }
      try require(record.verified)
      accounts = try await Self.accounts(entropy: record.entropy, registry: registry)
    }
    try saved.portfolio.rememberActive(saved, gateway: "https://api.gizu.io")
    var value = try await read(walletId: walletId, registry: registry, accounts: accounts)
      .publicValue
    value["history"] = try saved.portfolio.history()
    return value
  }

  static func accounts(entropy: Data, registry: String) async throws -> [PortfolioAccount] {
    let count = try portfolioAccountIndices(registry: registry).count
    var accounts: [PortfolioAccount] = []
    for offset in stride(from: 0, to: count, by: 64) {
      try Task.checkCancellation()
      accounts += try derivePortfolioAccounts(
        entropy: entropy, registry: registry, offset: UInt32(offset),
        count: UInt32(min(64, count - offset)))
      await Task.yield()
    }
    try Task.checkCancellation()
    return accounts
  }

  func read(walletId: String, registry: String, accounts: [PortfolioAccount]) async throws
    -> PublicPortfolioSnapshot
  {
    try Task.checkCancellation()
    let expected = try portfolioAccountIndices(registry: registry)
    try require(accounts.map(\.accountIndex) == expected)
    let header = try await rpc.calls([
      PortfolioRequest(method: "eth_chainId", params: []),
      PortfolioRequest(method: "eth_getBlockByNumber", params: ["finalized", false]),
    ])
    guard header.count == 2, header[0] as? String == "0x8f",
      let block = header[1] as? [String: Any], let number = block["number"] as? String,
      number.range(of: "^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$", options: .regularExpression)
        != nil,
      let hash = block["hash"] as? String,
      hash.range(of: "^0x[0-9a-fA-F]{64}$", options: .regularExpression) != nil
    else { throw WalletFailure.invalid }

    var observations: [PortfolioObservation] = []
    // Four concurrent batches of at most 40 calls. All use the same canonical block hash.
    for start in stride(from: 0, to: accounts.count, by: 160) {
      try Task.checkCancellation()
      let end = min(accounts.count, start + 160)
      let batches = try await withThrowingTaskGroup(of: (Int, [PortfolioObservation]).self) {
        group in
        for offset in stride(from: start, to: end, by: 40) {
          let chunk = Array(accounts[offset..<min(end, offset + 40)])
          group.addTask {
            try Task.checkCancellation()
            let results = try await rpc.calls(
              chunk.map { account in
                PortfolioRequest(
                  method: "eth_call",
                  params: [
                    [
                      "to": Self.usdc,
                      "data": "0x70a08231" + String(repeating: "0", count: 24)
                        + account.address.dropFirst(2),
                    ],
                    ["blockHash": hash, "requireCanonical": true],
                  ])
              })
            try Task.checkCancellation()
            try require(results.count == chunk.count)
            return (
              offset,
              try zip(chunk, results).map { account, result in
                guard let hex = result as? String else { throw WalletFailure.invalid }
                return PortfolioObservation(
                  account: account, balanceAtoms: try decodePortfolioBalance(value: hex))
              }
            )
          }
        }
        var completed: [(Int, [PortfolioObservation])] = []
        for try await batch in group { completed.append(batch) }
        return completed.sorted { $0.0 < $1.0 }.flatMap { $0.1 }
      }
      observations += batches
    }
    let canonical = try await rpc.calls([
      PortfolioRequest(method: "eth_getBlockByNumber", params: [number, false])
    ])
    guard canonical.count == 1, let current = canonical[0] as? [String: Any],
      current["number"] as? String == number, current["hash"] as? String == hash
    else { throw WalletFailure.invalid }
    try Task.checkCancellation()
    return try buildPublicPortfolio(
      walletId: walletId, registry: registry, observations: observations,
      state: PortfolioReadState(
        checkedAt: clock(), block: number, complete: true, stale: false, syncPending: false))
  }
}

extension PublicPortfolioSnapshot {
  var publicValue: [String: Any] {
    [
      "walletId": walletId, "chainId": chainId, "asset": asset, "decimals": decimals,
      "fundingAddress": fundingAddress, "fundingAtoms": fundingAtoms, "returnAtoms": returnAtoms,
      "totalAtoms": totalAtoms, "checkedAt": checkedAt, "block": block,
      "balanceComplete": balanceComplete, "stale": stale, "syncPending": syncPending,
      "accounts": accounts.map {
        [
          "address": $0.address, "accountIndex": $0.accountIndex, "role": $0.role,
          "balanceAtoms": $0.balanceAtoms,
        ] as [String: Any]
      },
      "history": [],  // Wallet-scoped summaries are attached by read(store:).
    ]
  }
}
