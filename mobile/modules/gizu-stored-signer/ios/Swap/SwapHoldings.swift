import Foundation

internal struct SwapHoldings {
  let rpc: MainnetPortfolioRPC

  static func excluded(_ record: WalletRecord) throws -> [UInt32] {
    guard let data = record.earnCycles.data(using: .utf8),
      let cycles = try JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else { throw WalletFailure.invalid }
    return try cycles.compactMap { cycle in
      guard let value = cycle["withdrawalIndex"] else { return nil }
      guard let index = value as? Int, index >= 3, index < 8192 else { throw WalletFailure.invalid }
      return UInt32(index)
    }
  }

  func read(store: WalletStorage, target: String) async throws -> [String: Any] {
    let record = try store.load()
    let saved = StoredSwapFile(store: store, record: record)
    let portfolio = saved.portfolio
    let indices: [UInt32]
    let accounts: [PortfolioAccount]
    do {
      defer { record.close() }
      try require(record.verified)
      indices = try swapHoldingIndices(
        registry: record.roleRegistry, excluded: Self.excluded(record))
      let selected = Set(indices)
      accounts = try await MainnetPortfolio.accounts(
        entropy: record.entropy, registry: record.roleRegistry
      )
      .filter { selected.contains($0.accountIndex) }
    }
    // Backfill pre-upgrade active journals without deleting or rewriting them.
    try portfolio.rememberActive(saved, gateway: "https://api.gizu.io")
    let requested = target.lowercased()
    if !requested.isEmpty { try SwapPortfolioStore.validateTarget(requested) }
    var targets = try portfolio.targets()
    if !requested.isEmpty && !targets.contains(requested) { targets.append(requested) }
    try require(targets.count <= 256)
    let snapshot = try await read(
      indices: indices, addresses: accounts.map(\.address), targets: targets)
    try Task.checkCancellation()
    if !requested.isEmpty { try portfolio.watch(requested) }
    return snapshot
  }

  func read(indices: [UInt32], addresses: [String], targets: [String]) async throws -> [String: Any]
  {
    try require(indices.count == addresses.count)
    let header = try await rpc.calls([
      PortfolioRequest(method: "eth_chainId", params: []),
      PortfolioRequest(method: "eth_getBlockByNumber", params: ["latest", false]),
    ])
    guard header.count == 2, header[0] as? String == "0x1237",
      let head = header[1] as? [String: Any], let block = head["number"] as? String,
      let hash = head["hash"] as? String,
      block.range(of: "^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$", options: .regularExpression) != nil,
      hash.range(of: "^0x[0-9a-fA-F]{64}$", options: .regularExpression) != nil
    else { throw WalletFailure.invalid }
    var holdings: [[String: Any]] = []
    func call(_ token: String, _ data: String) -> PortfolioRequest {
      PortfolioRequest(method: "eth_call", params: [["to": token, "data": data], block])
    }
    for token in targets {
      try Task.checkCancellation()
      try SwapPortfolioStore.validateTarget(token)
      let metadata = try await rpc.calls([call(token, "0x95d89b41"), call(token, "0x313ce567")])
      guard metadata.count == 2, let symbol = metadata[0] as? String,
        let decimals = metadata[1] as? String
      else { throw WalletFailure.invalid }
      var balances: [String] = []
      for start in stride(from: 0, to: addresses.count, by: 40) {
        try Task.checkCancellation()
        let chunk = addresses[start..<min(start + 40, addresses.count)]
        let results = try await rpc.calls(
          chunk.map {
            call(token, "0x70a08231" + String(repeating: "0", count: 24) + $0.dropFirst(2))
          })
        guard let values = results as? [String], values.count == chunk.count else {
          throw WalletFailure.invalid
        }
        balances += values
      }
      let encoded = try buildSwapHolding(
        targetAddress: token, indices: indices, balances: balances, symbolAbi: symbol,
        decimalsAbi: decimals)
      if encoded != "null" { holdings.append(try swapObject(encoded)) }
    }
    let final = try await rpc.calls([
      PortfolioRequest(method: "eth_getBlockByNumber", params: [block, false])
    ])
    guard final.count == 1, let current = final[0] as? [String: Any],
      current["number"] as? String == block, current["hash"] as? String == hash
    else { throw WalletFailure.invalid }
    try Task.checkCancellation()
    return [
      "holdings": holdings, "block": block,
      "checkedAt": UInt64(Date().timeIntervalSince1970 * 1000),
    ]
  }
}
