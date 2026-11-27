import Foundation

/// Wallet-generation scoped source ownership. Signed work is sticky until exact completion.
internal final class FundingReservations {
  private static let lock = NSRecursiveLock()
  private let store: WalletStorage
  private let walletId: String
  private let generation: String
  private var name: String { "gizu-funding-reservations-\(generation).enc" }
  private var aad: Data { Data("gizu-funding-reservations:v1:\(walletId):\(generation)".utf8) }
  private struct Entry: Codable {
    var parentId: String
    var sourceId: String
    var sourceChainId: Int
    var token: String
    var owner: String
    var budgetAtoms: String
    var operationId: String?
  }
  private struct Contents: Codable {
    var version = 2
    var walletId: String
    var generation: String
    var entries: [Entry]
  }
  init(store: WalletStorage, record: WalletRecord) {
    self.store = store
    walletId = record.id
    generation = record.journalId
  }
  private func load() throws -> Contents {
    let current = try store.load()
    defer { current.close() }
    try require(current.id == walletId && current.journalId == generation)
    guard try store.files.exists(name) else {
      return Contents(walletId: walletId, generation: generation, entries: [])
    }
    guard let key = try store.keys.existing() else { throw WalletFailure.unavailable }
    var bytes = try WalletEnvelope.decrypt(store.files.read(name), key: key, aad: aad)
    defer { bytes.wipe() }
    let root = try JSONDecoder().decode(Contents.self, from: bytes)
    try require(
      root.version == 2 && root.walletId == walletId && root.generation == generation
        && root.entries.count <= 256)
    var identities = Set<String>()
    for row in root.entries {
      try require(
        row.token == fundingUsdc(row.sourceChainId) && row.owner == row.owner.lowercased())
      _ = try FundingAtoms.validate(row.budgetAtoms)
      try require(
        row.budgetAtoms != "0" && identities.insert("\(row.parentId):\(row.sourceId)").inserted)
    }
    return root
  }
  private func save(_ root: Contents) throws {
    guard let key = try store.keys.existing() else { throw WalletFailure.unavailable }
    var bytes = try JSONEncoder().encode(root)
    defer { bytes.wipe() }
    try require(bytes.count <= WalletLimits.protectedFileBytes - 32)
    try store.files.write(name, bytes: WalletEnvelope.encrypt(bytes, key: key, aad: aad))
  }
  func reservedAtoms(chainId: Int, owner: String) throws -> String {
    Self.lock.lock()
    defer { Self.lock.unlock() }
    let token = try fundingUsdc(chainId)
    return try load().entries.filter {
      $0.sourceChainId == chainId && $0.token == token && $0.owner == owner.lowercased()
    }
    .reduce("0") { try FundingAtoms.add($0, $1.budgetAtoms) }
  }
  func reserve(parentId: String, sources: [[String: Any]]) throws {
    Self.lock.lock()
    defer { Self.lock.unlock() }
    var root = try load()
    try require(
      !parentId.isEmpty && parentId.count <= 128 && sources.count <= 128
        && !root.entries.contains { $0.parentId == parentId })
    for source in sources {
      guard let chain = source["sourceChainId"] as? Int, let owner = source["address"] as? String,
        let token = source["token"] as? String, let id = source["sourceId"] as? String,
        let budget = source["budgetAtoms"] as? String,
        let balance = source["balanceAtoms"] as? String
      else { throw WalletFailure.invalid }
      try require(
        token.lowercased() == fundingUsdc(chain)
          && owner.range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil)
      let debit = try FundingAtoms.validate(budget)
      let held = try FundingAtoms.validate(balance)
      try require(
        debit != "0" && !root.entries.contains { $0.parentId == parentId && $0.sourceId == id })
      let reserved = try root.entries.filter {
        $0.sourceChainId == chain && $0.owner == owner.lowercased()
      }.reduce("0") { try FundingAtoms.add($0, $1.budgetAtoms) }
      try require(!FundingAtoms.less(held, FundingAtoms.add(reserved, debit)))
      root.entries.append(
        Entry(
          parentId: parentId, sourceId: id, sourceChainId: chain, token: token.lowercased(),
          owner: owner.lowercased(), budgetAtoms: debit))
    }
    try save(root)
  }
  func markSigned(parentId: String, sourceId: String, operationId: String) throws {
    Self.lock.lock()
    defer { Self.lock.unlock() }
    var root = try load()
    guard
      let index = root.entries.firstIndex(where: {
        $0.parentId == parentId && $0.sourceId == sourceId
      })
    else { throw WalletFailure.invalid }
    try require(
      !operationId.isEmpty
        && (root.entries[index].operationId == nil
          || root.entries[index].operationId == operationId)
    )
    root.entries[index].operationId = operationId
    try save(root)
  }
  /// Recovery accepts only the immutable identity of an already persisted native signature.
  /// This restores ownership; it never grants capacity for a new signature.
  func adoptSigned(
    parentId: String, sourceId: String, chainId: Int, token: String, owner: String,
    budgetAtoms: String, operationId: String
  ) throws {
    Self.lock.lock()
    defer { Self.lock.unlock() }
    var root = try load()
    try require(
      !parentId.isEmpty && parentId.count <= 128 && !sourceId.isEmpty && sourceId.count <= 256)
    try require(
      token.lowercased() == fundingUsdc(chainId)
        && owner.range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil)
    try require(operationId.range(of: "^[-a-zA-Z0-9_]{1,128}$", options: .regularExpression) != nil)
    let budget = try FundingAtoms.validate(budgetAtoms)
    try require(budget != "0")
    try require(
      !root.entries.contains {
        $0.operationId == operationId && ($0.parentId != parentId || $0.sourceId != sourceId)
      })
    if let index = root.entries.firstIndex(where: {
      $0.parentId == parentId && $0.sourceId == sourceId
    }) {
      let row = root.entries[index]
      try require(
        row.sourceChainId == chainId && row.token == token.lowercased()
          && row.owner == owner.lowercased() && row.budgetAtoms == budget)
      try require(row.operationId == nil || row.operationId == operationId)
      if row.operationId == operationId { return }
      root.entries[index].operationId = operationId
    } else {
      try require(root.entries.count < 256)
      root.entries.append(
        Entry(
          parentId: parentId, sourceId: sourceId, sourceChainId: chainId,
          token: token.lowercased(), owner: owner.lowercased(), budgetAtoms: budget,
          operationId: operationId))
    }
    try save(root)
  }
  /// Call only after adopting signatures from the authenticated current native batch.
  func pruneOrphanUnsigned(activeParentIds: Set<String>) throws {
    Self.lock.lock()
    defer { Self.lock.unlock() }
    var root = try load()
    root.entries.removeAll { $0.operationId == nil && !activeParentIds.contains($0.parentId) }
    try save(root)
  }

  func releaseUnsigned(parentId: String) throws {
    Self.lock.lock()
    defer { Self.lock.unlock() }
    var root = try load()
    root.entries.removeAll { $0.parentId == parentId && $0.operationId == nil }
    try save(root)
  }
  func complete(parentId: String, sourceId: String, operationId: String) throws {
    Self.lock.lock()
    defer { Self.lock.unlock() }
    var root = try load()
    if let entry = root.entries.first(where: { $0.parentId == parentId && $0.sourceId == sourceId })
    {
      try require(entry.operationId == operationId)
      root.entries.removeAll { $0.parentId == parentId && $0.sourceId == sourceId }
      try save(root)
    }
  }
}
