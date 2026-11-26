import Foundation

internal struct MainnetPortfolio {
  static let usdc = "0x754704bc059f8c67012fed69bc8a327a5aafb603"
  let rpc: MainnetPortfolioRPC
  /// Injectable native observation transports; action destination routing is unrelated.
  var fundingRPC: ((Int) -> MainnetPortfolioRPC)? = nil
  var privateBalance: (@MainActor (WalletRecord) async throws -> [String: Any])? = nil
  var privateReadAuthority: @MainActor () throws -> Void = {}
  var reservedAtoms: (Int, String) -> String? = { _, _ in "0" }
  var clock: () -> UInt64 = { UInt64(Date().timeIntervalSince1970 * 1000) }

  /// Runs off the main actor; secrets are released before the first network request.
  func read(store: WalletStorage, forceRefresh: Bool = false) async throws -> [String: Any] {
    let record = try store.load()
    let walletId = record.id
    let registry = record.roleRegistry
    let generation = record.journalId
    let privateAddress = try deriveAccountAddressRange(entropy: record.entropy, start: 2, count: 1)[
      0]
    let saved = StoredSwapFile(store: store, record: record)
    let accounts: [PortfolioAccount]
    do {
      defer { record.close() }
      try require(record.verified)
      accounts = try await Self.accounts(entropy: record.entropy, registry: registry)
    }
    try saved.portfolio.rememberActive(saved, gateway: "https://api.gizu.io")
    let cache = FundingPortfolioCache(store: store, walletId: walletId, generation: generation)
    let snapshots = try await withThrowingTaskGroup(of: (Int, FundingNetworkSnapshot).self) {
      group in
      for chain in [143, 8453, 42161] {
        let selected = accounts.filter { chain == 143 || $0.accountIndex == 1 }
        group.addTask {
          try Task.checkCancellation()
          let old = try? cache.load(chain: chain)
          if let old, !forceRefresh, !old.invalidated, clock() >= old.checkedAt,
            clock() - old.checkedAt < 30_000,
            selected.allSatisfy({ old.balances[$0.address.lowercased()] != nil })
          {
            return (chain, old)
          }
          do {
            let (observations, state) = try await readObservations(chain: chain, accounts: selected)
            let snapshot = FundingNetworkSnapshot(
              balances: Dictionary(
                uniqueKeysWithValues: observations.map {
                  ($0.account.address.lowercased(), $0.balanceAtoms!)
                }),
              checkedAt: state.checkedAt, block: state.block)
            try Task.checkCancellation()
            try cache.save(snapshot, chain: chain)
            return (chain, snapshot)
          } catch is CancellationError { throw CancellationError() } catch {
            let unavailable = FundingNetworkSnapshot(
              balances: old?.balances ?? [:], checkedAt: old?.checkedAt ?? 0,
              block: old?.block ?? "0x0", invalidated: true)
            // A failed forced refresh cannot leave a previously fresh disk cache spendable.
            try? cache.save(unavailable, chain: chain)
            return (chain, unavailable)
          }
        }
      }
      var result = [Int: FundingNetworkSnapshot]()
      for try await (chain, snapshot) in group { result[chain] = snapshot }
      return result
    }
    try Task.checkCancellation()
    // A wallet restore/replacement during a slow RPC cannot publish the old generation.
    let current = try store.load()
    defer { current.close() }
    try require(current.id == walletId && current.journalId == generation)
    let monad = snapshots[143]!
    let complete =
      !monad.invalidated && accounts.allSatisfy { monad.balances[$0.address.lowercased()] != nil }
    var value = try buildPublicPortfolio(
      walletId: walletId, registry: registry,
      observations: accounts.map {
        PortfolioObservation(account: $0, balanceAtoms: monad.balances[$0.address.lowercased()])
      },
      state: PortfolioReadState(
        checkedAt: monad.checkedAt, block: monad.block, complete: complete,
        stale: !complete, syncPending: !complete)
    ).publicValue
    let funding = try fundingPortfolio(
      [143, 8453, 42161].flatMap { chain in
        let snapshot = snapshots[chain]!
        return accounts.filter { chain == 143 ? $0.accountIndex != 0 : $0.accountIndex == 1 }.map {
          account in
          FundingObservation(
            sourceChainId: chain, accountIndex: account.accountIndex, owner: account.address,
            balanceAtoms: snapshot.balances[account.address.lowercased()],
            checkedAt: snapshot.checkedAt,
            complete: !snapshot.invalidated, stale: snapshot.invalidated,
            syncPending: snapshot.invalidated,
            reservedAtoms: reservedAtoms(chain, account.address))
        }
      })
    value.merge(funding) { _, new in new }
    value["history"] = try saved.portfolio.history()
    let privateSnapshot = try await privateObservation(
      store: store, cache: cache,
      walletId: walletId, generation: generation, address: privateAddress,
      forceRefresh: forceRefresh)
    let privateAtoms = privateSnapshot.balances[privateAddress.lowercased()]
    let privateComplete = !privateSnapshot.invalidated && privateAtoms != nil
    value["ownedAssets"] = [
      [
        "assetId": "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
        "chainId": 143, "token": "confidential:monad-usdc", "symbol": "USDC (private)",
        "decimals": 6, "owner": privateAddress,
        "observedAtoms": privateAtoms ?? "0",
        "balanceAtoms": privateComplete ? privateAtoms! as Any : NSNull(),
        "valueUsdcAtoms": privateComplete ? privateAtoms! as Any : NSNull(),
        "valuationUnavailable": !privateComplete, "complete": privateComplete,
        "stale": !privateComplete, "checkedAt": privateSnapshot.checkedAt,
      ]
    ]
    value["confidentialKnownAtoms"] = privateAtoms ?? "0"
    value["confidentialComplete"] = privateComplete
    value["confidentialStale"] = !privateComplete
    value["confidentialSyncPending"] = !privateComplete
    value["confidentialReadRequired"] = !privateComplete
    let finalIdentity = try store.load()
    defer { finalIdentity.close() }
    try require(finalIdentity.id == walletId && finalIdentity.journalId == generation)
    return value
  }

  private func privateObservation(
    store: WalletStorage, cache: FundingPortfolioCache,
    walletId: String, generation: String, address: String, forceRefresh: Bool
  ) async throws -> FundingNetworkSnapshot {
    let old = try? cache.load(chain: 0)
    guard let privateBalance else {
      return FundingNetworkSnapshot(
        balances: old?.balances ?? [:], checkedAt: old?.checkedAt ?? 0,
        block: "private", invalidated: true)
    }
    do {
      try await privateReadAuthority()
      let identity = try store.load()
      defer { identity.close() }
      try require(identity.verified && identity.id == walletId && identity.journalId == generation)
      let observation = try ConfidentialBalance.publicBalance(
        try await privateBalance(identity), address: address, now: Int64(clock()))
      try Task.checkCancellation()
      try await privateReadAuthority()
      let current = try store.load()
      defer { current.close() }
      try require(current.id == walletId && current.journalId == generation && current.verified)
      let snapshot = FundingNetworkSnapshot(
        balances: [address.lowercased(): observation["available"] as! String],
        checkedAt: UInt64(observation["timestampMs"] as! Int64), block: "private")
      try cache.save(snapshot, chain: 0)
      return snapshot
    } catch is CancellationError { throw CancellationError() } catch {
      let stale = FundingNetworkSnapshot(
        balances: old?.balances ?? [:], checkedAt: old?.checkedAt ?? 0,
        block: "private", invalidated: true)
      try? cache.save(stale, chain: 0)
      return stale
    }
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
    let (observations, state) = try await readObservations(chain: 143, accounts: accounts)
    return try buildPublicPortfolio(
      walletId: walletId, registry: registry, observations: observations, state: state)
  }

  private func readObservations(chain: Int, accounts: [PortfolioAccount]) async throws -> (
    [PortfolioObservation], PortfolioReadState
  ) {
    let token = try fundingUsdc(chain)
    let upstream: MainnetPortfolioRPC
    if let fundingRPC {
      upstream = fundingRPC(chain)
    } else if chain == 143 {
      upstream = rpc
    } else {
      upstream = NativeMainnetPortfolioRPC(network: chain == 8453 ? .base : .arbitrum)
    }
    let transport = BudgetedPortfolioRPC(upstream: upstream)
    let header = try await transport.calls([
      PortfolioRequest(method: "eth_chainId", params: []),
      PortfolioRequest(
        method: "eth_getBlockByNumber", params: [chain == 143 ? "finalized" : "latest", false]),
    ])
    guard header.count == 2, header[0] as? String == "0x" + String(chain, radix: 16),
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
            let results = try await transport.calls(
              chunk.map { account in
                PortfolioRequest(
                  method: "eth_call",
                  params: [
                    [
                      "to": token,
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
    let canonical = try await transport.calls([
      PortfolioRequest(method: "eth_getBlockByNumber", params: [number, false])
    ])
    guard canonical.count == 1, let current = canonical[0] as? [String: Any],
      current["number"] as? String == number, current["hash"] as? String == hash
    else { throw WalletFailure.invalid }
    try Task.checkCancellation()
    return (
      observations,
      PortfolioReadState(
        checkedAt: clock(), block: number, complete: true, stale: false, syncPending: false)
    )
  }

  static func invalidate(store: WalletStorage) throws {
    let record = try store.load()
    defer { record.close() }
    let cache = FundingPortfolioCache(
      store: store, walletId: record.id, generation: record.journalId)
    for chain in [0, 143, 8453, 42161] {
      if var old = try cache.load(chain: chain) {
        old.invalidated = true
        try cache.save(old, chain: chain)
      }
    }
  }

  /// Only after durable verification of private credit from this exact public source.
  static func invalidateConfirmedFunding(store: WalletStorage, sourceChainId: Int, owner: String)
    throws
  {
    _ = try fundingUsdc(sourceChainId)
    try require(owner.range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil)
    let record = try store.load()
    defer { record.close() }
    let cache = FundingPortfolioCache(
      store: store, walletId: record.id, generation: record.journalId)
    guard let old = try cache.load(chain: sourceChainId) else { return }
    var balances = old.balances
    balances.removeValue(forKey: owner.lowercased())
    try cache.save(
      FundingNetworkSnapshot(
        balances: balances, checkedAt: old.checkedAt,
        block: old.block, invalidated: true), chain: sourceChainId)
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
