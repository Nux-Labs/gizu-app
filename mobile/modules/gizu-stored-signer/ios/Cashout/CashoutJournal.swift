import Foundation

internal struct CashoutSource: Codable, Equatable {
  var kind: String
  var profileChainId: UInt64
  var cycleIndex: UInt32
  var address: String
  var amountAtoms: String
}

internal struct CashoutProposal: Codable, Equatable {
  var operationId: String
  var amountAtoms: String
  var sources: [CashoutSource]
  var recipientIndices: [UInt32]
  var weightsBps: [UInt32]
}

internal struct CashoutPlan: Codable, Equatable {
  struct Child: Codable, Equatable {
    var source: Int
    var slot: Int
    var amountAtoms: String
  }
  var proposal: CashoutProposal
  var children: [Child]

  func validate() throws {
    let canonical = try confidentialWithdrawalPlan(proposal: EarnValues.json(proposal))
    let expected = try JSONDecoder().decode(Self.self, from: Data(canonical.utf8))
    try require(expected == self)
  }
}

internal struct CashoutChild: Codable, Equatable {
  var plan: CashoutPlan.Child
  var status = "needsReview"
  var minimumDestinationAtoms = "0"
  var receivedAtoms = "0"
  var preparedText: String?
  var balanceProof: String?
  var nonce: String?
  var nonceHistory: [String] = []
  var payloadHash: String?
  var reservationId: String?
  var signedData: String?
  var signingPending = false
  var intentHash: String?
  var routeSucceeded = false

  var canCancel: Bool {
    ["review", "needsReview", "cancelled"].contains(status)
      && signedData == nil && !signingPending
  }
  func evidence() throws -> String {
    guard let nonce, let payloadHash, let reservationId else { throw WalletFailure.invalid }
    return try CashoutJSON.text([
      "nonce": nonce, "payloadHash": payloadHash, "reservationId": reservationId,
      "reservedAtoms": plan.amountAtoms, "unresolved": false,
    ])
  }
}

internal struct CashoutRecord: Codable, Equatable {
  var walletId: String
  var operationId: String
  var revision: UInt32 = 1
  var plan: CashoutPlan
  var children: [CashoutChild]
  var cancelled = false
  var groupScan: [CashoutScan]?
  var groupReceipt: String?

  var terminal: Bool { cancelled || children.allSatisfy { $0.status == "paid" } }
  static func status(_ children: [CashoutChild]) -> String {
    let states = children.map(\.status)
    if states.allSatisfy({ $0 == "paid" }) { return "paid" }
    if states.allSatisfy({ $0 == "cancelled" }) { return "cancelled" }
    return ["conflict", "unknown", "pending", "needsReview"].first(where: states.contains)
      ?? "review"
  }
  func publicValue() throws -> [String: Any] {
    let state = Self.status(children)
    return [
      "walletId": walletId, "operationId": operationId, "revision": revision,
      "amountAtoms": plan.proposal.amountAtoms,
      "minimumDestinationAtoms": try earnAmountSum(values: children.map(\.minimumDestinationAtoms)),
      "receivedAtoms": try earnAmountSum(values: children.map(\.receivedAtoms)),
      "walletCount": plan.proposal.weightsBps.count, "weightsBps": plan.proposal.weightsBps,
      "status": state, "canResume": !["paid", "cancelled", "conflict"].contains(state),
      "canCancel": !terminal && children.allSatisfy(\.canCancel),
      "payouts": try plan.proposal.weightsBps.indices.map { slot -> [String: Any] in
        let selected = children.filter { $0.plan.slot == slot }
        return [
          "slot": slot,
          "amountAtoms": try earnAmountSum(values: selected.map { $0.plan.amountAtoms }),
          "minimumDestinationAtoms": try earnAmountSum(
            values: selected.map(\.minimumDestinationAtoms)),
          "receivedAtoms": try earnAmountSum(values: selected.map(\.receivedAtoms)),
          "status": Self.status(selected),
        ]
      },
    ]
  }
}

/// Serialized by the native ceremony. The generation-bound envelope retains all nonce history.
internal final class CashoutJournal {
  let walletId: String
  let generation: String
  private let store: WalletStorage
  private let name: String
  private let aad: Data
  private struct Contents: Codable {
    var version = 1
    var walletId: String
    var generation: String
    var operations: [CashoutRecord]
  }
  init(store: WalletStorage, record: WalletRecord) {
    self.store = store
    walletId = record.id
    generation = record.journalId
    name = "gizu-confidential-withdrawal-\(generation).enc"
    aad = Data("gizu-confidential-withdrawal:v1:\(walletId):\(generation)".utf8)
  }
  func all() throws -> [CashoutRecord] {
    guard try store.files.exists(name) else { return [] }
    guard let key = try store.keys.existing() else { throw WalletFailure.unavailable }
    var clear = try WalletEnvelope.decrypt(
      store.files.read(name, limit: 8 * 1024 * 1024), key: key, aad: aad)
    defer { clear.wipe() }
    let root = try JSONDecoder().decode(Contents.self, from: clear)
    try require(root.version == 1 && root.walletId == walletId && root.generation == generation)
    try require(Set(root.operations.map(\.operationId)).count == root.operations.count)
    try require(root.operations.filter { !$0.terminal }.count <= 1)
    for row in root.operations {
      try row.plan.validate()
      try require(
        row.walletId == walletId && row.revision > 0
          && row.operationId == row.plan.proposal.operationId
          && row.children.map(\.plan) == row.plan.children)
      try require(!row.cancelled || row.children.allSatisfy(\.canCancel))
      for child in row.children {
        try require(
          ["needsReview", "review", "pending", "unknown", "conflict", "paid", "cancelled"].contains(
            child.status))
        _ = try earnAmountWord(value: child.minimumDestinationAtoms)
        _ = try earnAmountWord(value: child.receivedAtoms)
        if child.signedData != nil {
          try require(
            child.preparedText != nil && child.nonce != nil
              && child.payloadHash != nil && child.reservationId != nil)
        }
        if child.status == "paid" {
          try require(child.signedData != nil && row.groupReceipt != nil)
        }
      }
    }
    return root.operations
  }
  private func write(_ rows: [CashoutRecord]) throws {
    var clear = try JSONEncoder().encode(
      Contents(walletId: walletId, generation: generation, operations: rows))
    defer { clear.wipe() }
    try require(clear.count < 8 * 1024 * 1024 - 1024)
    guard let key = try store.keys.existing() else { throw WalletFailure.unavailable }
    try store.files.write(name, bytes: WalletEnvelope.encrypt(clear, key: key, aad: aad))
  }
  func active() throws -> CashoutRecord? { try all().last { !$0.terminal } }
  func get(_ id: String) throws -> CashoutRecord {
    guard let row = try all().first(where: { $0.operationId == id }) else {
      throw WalletFailure.invalid
    }
    return row
  }
  func create(_ plan: CashoutPlan) throws -> CashoutRecord {
    try plan.validate()
    var rows = try all()
    try require(!rows.contains { !$0.terminal || $0.operationId == plan.proposal.operationId })
    let row = CashoutRecord(
      walletId: walletId, operationId: plan.proposal.operationId,
      plan: plan, children: plan.children.map { CashoutChild(plan: $0) })
    rows.append(row)
    try write(rows)
    return row
  }
  @discardableResult func update(
    _ old: CashoutRecord, _ change: (inout CashoutRecord) throws -> Void
  ) throws -> CashoutRecord {
    var rows = try all()
    guard let index = rows.firstIndex(where: { $0.operationId == old.operationId }),
      rows[index] == old, old.revision < UInt32.max
    else { throw WalletFailure.invalid }
    var next = old
    try change(&next)
    try require(
      next.walletId == old.walletId && next.operationId == old.operationId
        && next.plan == old.plan && next.children.map(\.plan) == old.children.map(\.plan)
        && (!old.cancelled || next == old))
    for (before, after) in zip(old.children, next.children) {
      try require(after.nonceHistory.starts(with: before.nonceHistory))
      if before.signedData != nil {
        try require(
          after.signedData == before.signedData && after.preparedText == before.preparedText
            && after.nonce == before.nonce && after.payloadHash == before.payloadHash
            && after.reservationId == before.reservationId)
      }
      if before.status == "paid" { try require(before == after) }
    }
    if next.cancelled { try require(next.children.allSatisfy(\.canCancel)) }
    next.revision += 1
    rows[index] = next
    try write(rows)
    return next
  }
  func cancel(_ row: CashoutRecord) throws -> CashoutRecord {
    try update(row) { value in
      try require(!value.terminal && value.children.allSatisfy(\.canCancel))
      value.cancelled = true
      for i in value.children.indices { value.children[i].status = "cancelled" }
    }
  }
  func assertFreshNonce(source: String, nonce: String, operationId: String, index: Int) throws {
    for row in try all() {
      for (i, child) in row.children.enumerated() {
        if row.operationId == operationId && i == index { continue }
        if row.plan.proposal.sources[child.plan.source].address.lowercased() == source.lowercased()
        {
          try require(child.nonce != nonce && !child.nonceHistory.contains(nonce))
        }
      }
    }
  }
}

internal enum CashoutJSON {
  static func text(_ value: Any) throws -> String {
    String(
      decoding: try JSONSerialization.data(
        withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes]),
      as: UTF8.self)
  }
  static func object(_ text: String) throws -> [String: Any] {
    try EarnValues.object(JSONSerialization.jsonObject(with: Data(text.utf8)))
  }
  static func string(_ object: [String: Any], _ key: String) throws -> String {
    guard let value = object[key] as? String else { throw WalletFailure.invalid }
    return value
  }
  static func uint(_ object: [String: Any], _ key: String) throws -> UInt64 {
    guard let value = object[key] else { throw WalletFailure.invalid }
    return try EarnValues.exactInteger(value)
  }
}
