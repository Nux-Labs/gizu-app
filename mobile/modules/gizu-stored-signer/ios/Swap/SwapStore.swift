import Foundation

internal final class StoredSwapFile {
  let portfolio: SwapPortfolioStore
  let walletId: String
  let generation: String
  private let files: WalletFiles
  private let keys: WalletKeyStore
  private let name: String
  private let aad: Data

  init(store: WalletStorage, record: WalletRecord) {
    portfolio = SwapPortfolioStore(store: store, record: record)
    walletId = record.id
    generation = record.journalId
    files = store.files
    keys = store.keys
    name = "gizu-swap-\(record.journalId).enc"
    aad = Data("gizu-swap:v1:\(record.id):\(record.journalId)".utf8)
  }

  func load() throws -> [String: Any]? {
    guard try files.exists(name) else { return nil }
    guard let key = try keys.existing() else { throw WalletFailure.unavailable }
    var clear = try WalletEnvelope.decrypt(
      files.read(name, limit: WalletLimits.swapFileBytes), key: key, aad: aad)
    defer { clear.wipe() }
    guard let root = try JSONSerialization.jsonObject(with: clear) as? [String: Any],
      [1, 2].contains(root["version"] as? Int ?? 0), root["walletId"] as? String == walletId,
      let state = root["state"] as? String, state.utf8.count <= WalletLimits.swapStateBytes
    else { throw WalletFailure.invalid }
    if root["version"] as? Int == 2 {
      guard let value = root["batch"] else { throw WalletFailure.invalid }
      let batch = try JSONDecoder().decode(
        SwapFundingBatch.self, from: JSONSerialization.data(withJSONObject: value))
      try batch.validate(walletId: walletId, generation: generation)
      try require(root["operationId"] as? String == batch.operationId)
    }
    return root
  }

  func saveBatch(_ batch: SwapFundingBatch, state: String, fundingAddress: String) throws {
    try batch.validate(walletId: walletId, generation: generation)
    try require(state.utf8.count <= WalletLimits.swapStateBytes)
    let value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(batch))
    try write([
      "version": 2, "walletId": walletId, "operationId": batch.operationId,
      "fundingAddress": fundingAddress, "state": state, "batch": value,
    ])
  }
  private func write(_ root: [String: Any]) throws {
    var clear = try JSONSerialization.data(withJSONObject: root)
    defer { clear.wipe() }
    try require(clear.count + 32 <= WalletLimits.swapFileBytes)
    guard let key = try keys.existing() else { throw WalletFailure.unavailable }
    try files.write(name, bytes: WalletEnvelope.encrypt(clear, key: key, aad: aad))
  }
  func save(operationId: String, state: String, fundingAddress: String) throws {
    try require(state.utf8.count <= WalletLimits.swapStateBytes && fundingAddress.hasPrefix("0x"))
    let root: [String: Any] = [
      "version": 1, "walletId": walletId, "operationId": operationId,
      "fundingAddress": fundingAddress, "state": state,
    ]
    var clear = try JSONSerialization.data(withJSONObject: root)
    defer { clear.wipe() }
    try require(clear.count + 32 <= WalletLimits.swapFileBytes)
    guard let key = try keys.existing() else { throw WalletFailure.unavailable }
    try files.write(name, bytes: WalletEnvelope.encrypt(clear, key: key, aad: aad))
  }
}
