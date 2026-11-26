import Foundation

/// Wallet-scoped public summaries, independent of the replaceable active journal.
internal final class SwapPortfolioStore {
  private let store: WalletStorage
  private let name: String
  private let aad: Data
  private let walletId: String
  private struct Summary: Codable {
    let operationId: String
    let phase: String
    let direction: String
    let symbol: String
    let receivedAtoms: String
    let recordedAt: UInt64
    // Optional fields keep historical public-sale summaries decodable.
    let completionTarget: String?
    let privateCreditedAtoms: String?
    /// Absent in summaries recorded before Base support, which are all Robinhood.
    var chainId: UInt64? = nil
    var publicValue: [String: Any] {
      var value: [String: Any] = [
        "operationId": operationId, "phase": phase, "direction": direction,
        "symbol": symbol, "receivedAtoms": receivedAtoms, "recordedAt": recordedAt,
        "completionTarget": completionTarget ?? "public",
        "chainId": chainId ?? SwapChain.robinhood.rawValue,
      ]
      if let privateCreditedAtoms { value["privateCreditedAtoms"] = privateCreditedAtoms }
      return value
    }
  }
  /// One token a swap bought, on one chain. Public data only.
  private struct Asset: Codable, Equatable {
    let chainId: UInt64
    let token: String
  }
  private struct Contents: Codable {
    var version = 2
    let walletId: String
    /// Version 1 only: bare Robinhood tokens, moved into `assets` when loaded.
    var tokens: [String]?
    var assets: [Asset]? = []
    var history: [String: Summary] = [:]
  }
  init(store: WalletStorage, record: WalletRecord) {
    self.store = store
    walletId = record.id
    name = "gizu-holdings-\(record.journalId).enc"
    aad = Data("gizu-holdings:v1:\(record.id):\(record.journalId)".utf8)
  }
  private func load() throws -> Contents {
    guard try store.files.exists(name) else { return Contents(walletId: walletId) }
    guard let key = try store.keys.existing() else { throw WalletFailure.unavailable }
    var clear = try WalletEnvelope.decrypt(
      store.files.read(name, limit: 1_048_576), key: key, aad: aad)
    defer { clear.wipe() }
    var root = try JSONDecoder().decode(Contents.self, from: clear)
    try require(root.walletId == walletId)
    switch root.version {
    case 1:
      // Version 1 tracked Robinhood tokens only; the next save writes version 2.
      try require(root.assets == nil || root.assets == [])
      root.assets = (root.tokens ?? []).map {
        Asset(chainId: SwapChain.robinhood.rawValue, token: $0)
      }
      root.tokens = nil
      root.version = 2
    case 2: try require(root.tokens == nil)
    default: throw WalletFailure.invalid
    }
    let assets = root.assets ?? []
    for asset in assets {
      try require(SwapChain(rawValue: asset.chainId) != nil)
      try Self.validateTarget(asset.token)
    }
    try require(Set(assets.map { "\($0.chainId):\($0.token)" }).count == assets.count)
    for chain in SwapChain.allCases {
      try require(assets.filter { $0.chainId == chain.rawValue }.count <= 256)
    }
    return root
  }
  private func save(_ root: Contents) throws {
    var clear = try JSONEncoder().encode(root)
    defer { clear.wipe() }
    try require(clear.count <= 1_048_000)
    guard let key = try store.keys.existing() else { throw WalletFailure.unavailable }
    try store.files.write(name, bytes: WalletEnvelope.encrypt(clear, key: key, aad: aad))
  }
  static func validateTarget(_ target: String) throws {
    try require(target.range(of: "^0x[0-9a-f]{40}$", options: .regularExpression) != nil)
  }
  /// Tracked tokens on one chain, in the order they were first seen.
  func targets(chainId: UInt64 = SwapChain.robinhood.rawValue) throws -> [String] {
    try (load().assets ?? []).filter { $0.chainId == chainId }.map(\.token)
  }
  /// The one chain whose ledger tracks `token`; a token on two chains is refused, not guessed.
  func chainOf(_ token: String) throws -> UInt64 {
    let chains = Set(
      try (load().assets ?? []).filter { $0.token == token.lowercased() }.map(\.chainId))
    guard chains.count == 1, let chain = chains.first else { throw WalletFailure.invalid }
    return chain
  }
  func history() throws -> [[String: Any]] {
    try load().history.values.sorted { $0.recordedAt > $1.recordedAt }.map(\.publicValue)
  }
  func watch(_ target: String, chainId: UInt64 = SwapChain.robinhood.rawValue) throws {
    let token = target.lowercased()
    try Self.validateTarget(token)
    try require(SwapChain(rawValue: chainId) != nil)
    var root = try load()
    var assets = root.assets ?? []
    let asset = Asset(chainId: chainId, token: token)
    if !assets.contains(asset) {
      try require(assets.filter { $0.chainId == chainId }.count < 256)
      assets.append(asset)
      root.assets = assets
      try save(root)
    }
  }
  func remember(state: String, status: String) throws {
    let plan = try swapObject(state)["plan"] as? [String: Any]
    guard let target = plan?["target"] as? String else { throw WalletFailure.invalid }
    // Plans saved before Base support carry no chain and are Robinhood.
    let chainId = try Self.chainId(plan?["chainId"])
    try watch(target, chainId: chainId)
    let view = try swapObject(status)
    guard let phase = view["phase"] as? String else { throw WalletFailure.invalid }
    guard ["COMPLETE", "CANCELLED"].contains(phase) else { return }
    guard let id = view["operationId"] as? String,
      let direction = view["direction"] as? String
    else { throw WalletFailure.invalid }
    var root = try load()
    // Repeated reads retain the original timestamp; completion cannot be downgraded.
    if let old = root.history[id], old.phase == "COMPLETE" || old.phase == phase { return }
    root.history[id] = Summary(
      operationId: id, phase: phase, direction: direction,
      symbol: view["targetSymbol"] as? String ?? "",
      receivedAtoms: view[
        view["completionTarget"] as? String == "confidential"
          ? "privateCreditedAtoms" : "receivedTargetAtoms"] as? String ?? "0",
      recordedAt: UInt64(Date().timeIntervalSince1970 * 1000),
      completionTarget: view["completionTarget"] as? String,
      privateCreditedAtoms: view["privateCreditedAtoms"] as? String, chainId: chainId)
    try save(root)
  }
  /// A plan's `chainId`, Robinhood when absent; anything unsupported is refused.
  static func chainId(_ value: Any?) throws -> UInt64 {
    guard let value, !(value is NSNull) else { return SwapChain.robinhood.rawValue }
    guard let number = value as? NSNumber, let chain = SwapChain(rawValue: number.uint64Value),
      NSNumber(value: chain.rawValue) == number
    else { throw WalletFailure.invalid }
    return chain.rawValue
  }
  func rememberActive(_ saved: StoredSwapFile, gateway: String) throws {
    if let root = try saved.load(), let state = root["state"] as? String {
      if root["version"] as? Int == 2, let batch = root["batch"] as? [String: Any],
        batch["downstreamState"] == nil || batch["downstreamState"] is NSNull
      {
        return
      }
      let op = try SwapOperation.restore(state: state, gateway: gateway)
      try remember(state: state, status: op.publicStatus())
    }
  }
}

internal func swapObject(_ json: String) throws -> [String: Any] {
  guard let data = json.data(using: .utf8),
    let result = try JSONSerialization.jsonObject(with: data) as? [String: Any]
  else { throw WalletFailure.invalid }
  return result
}
