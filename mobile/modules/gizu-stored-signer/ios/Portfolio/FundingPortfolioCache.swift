import Foundation

internal struct FundingNetworkSnapshot: Codable {
  let balances: [String: String]
  let checkedAt: UInt64
  let block: String
  var invalidated = false
}

/// Independent encrypted chain observations, scoped to the wallet restore generation.
internal struct FundingPortfolioCache {
  let store: WalletStorage
  let walletId: String
  let generation: String
  private func name(_ chain: Int) -> String { "gizu-public-balances-\(generation)-\(chain).enc" }
  private func aad(_ chain: Int) -> Data { Data("gizu-funding-observation:v1:\(walletId):\(generation):\(chain)".utf8) }
  func load(chain: Int) throws -> FundingNetworkSnapshot? {
    guard try store.files.exists(name(chain)) else { return nil }
    guard let key = try store.keys.existing() else { throw WalletFailure.unavailable }
    var clear = try WalletEnvelope.decrypt(store.files.read(name(chain), limit: 2 * 1024 * 1024), key: key, aad: aad(chain))
    defer { clear.wipe() }
    return try JSONDecoder().decode(FundingNetworkSnapshot.self, from: clear)
  }
  func save(_ snapshot: FundingNetworkSnapshot, chain: Int) throws {
    guard let key = try store.keys.existing() else { throw WalletFailure.unavailable }
    var clear = try JSONEncoder().encode(snapshot)
    defer { clear.wipe() }
    try require(clear.count <= 2 * 1024 * 1024)
    try store.files.write(name(chain), bytes: WalletEnvelope.encrypt(clear, key: key, aad: aad(chain)))
  }
}
