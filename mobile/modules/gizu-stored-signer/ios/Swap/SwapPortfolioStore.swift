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
    var publicValue: [String: Any] {
      var value: [String: Any] = [
        "operationId": operationId, "phase": phase, "direction": direction,
        "symbol": symbol, "receivedAtoms": receivedAtoms, "recordedAt": recordedAt,
        "completionTarget": completionTarget ?? "public",
      ]
      if let privateCreditedAtoms { value["privateCreditedAtoms"] = privateCreditedAtoms }
      return value
    }
  }
  private struct Contents: Codable {
    var version = 1
    let walletId: String
    var tokens: [String] = []
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
    let root = try JSONDecoder().decode(Contents.self, from: clear)
    try require(root.version == 1 && root.walletId == walletId && root.tokens.count <= 256)
    for token in root.tokens { try Self.validateTarget(token) }
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
  func targets() throws -> [String] { try load().tokens }
  func history() throws -> [[String: Any]] {
    try load().history.values.sorted { $0.recordedAt > $1.recordedAt }.map(\.publicValue)
  }
  func watch(_ target: String) throws {
    let token = target.lowercased()
    try Self.validateTarget(token)
    var root = try load()
    if !root.tokens.contains(token) {
      try require(root.tokens.count < 256)
      root.tokens.append(token)
      try save(root)
    }
  }
  func remember(state: String, status: String) throws {
    let plan = try swapObject(state)["plan"] as? [String: Any]
    guard let target = plan?["target"] as? String else { throw WalletFailure.invalid }
    try watch(target)
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
      privateCreditedAtoms: view["privateCreditedAtoms"] as? String)
    try save(root)
  }
  func rememberActive(_ saved: StoredSwapFile, gateway: String) throws {
    if let root = try saved.load(), let state = root["state"] as? String {
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
