import CryptoKit
import Foundation

internal struct CashoutScan: Codable, Equatable {
  var transactionHashes: [String] = []
  var nextScanBlock: String
  var complete = false
}

internal struct CashoutReceipt: Codable, Equatable {
  var transactionHash: String
  var logIndex: UInt64
  var receivedAtoms: String
  var blockNumber: String
  var blockHash: String
  var identity: String { "\(transactionHash):\(logIndex)" }
}

/// Fixed Monad policy. Public delivery is verified independently of confidential route status.
internal final class CashoutReceipts {
  private let rpc: MainnetPortfolioRPC
  private let now: () -> UInt64
  init(
    rpc: MainnetPortfolioRPC = NativeMainnetPortfolioRPC(),
    now: @escaping () -> UInt64 = { UInt64(Date().timeIntervalSince1970 * 1000) }
  ) {
    self.rpc = rpc
    self.now = now
  }
  private func call(_ method: String, _ params: [Any]) async throws -> Any {
    let values = try await rpc.calls([PortfolioRequest(method: method, params: params)])
    try require(values.count == 1)
    return values[0]
  }
  private func block(_ tag: String) async throws -> [String: Any] {
    try EarnValues.object(await call("eth_getBlockByNumber", [tag, false]))
  }
  private func quantity(_ row: [String: Any], _ key: String) throws -> UInt64 {
    try EarnValues.uint(CashoutJSON.string(row, key))
  }
  private func reference(_ quote: [String: Any]) async throws -> UInt64 {
    guard let chain = try await call("eth_chainId", []) as? String else {
      throw WalletFailure.invalid
    }
    try require(
      try EarnValues.uint(chain) == 143 && CashoutJSON.uint(quote, "destinationChainId") == 143)
    try require(
      try CashoutJSON.string(quote, "destinationToken").lowercased() == MainnetPortfolio.usdc)
    let raw = try CashoutJSON.string(quote, "referenceBlock")
    guard let number = UInt64(raw), String(number) == raw, number < UInt64.max - 4096 else {
      throw WalletFailure.invalid
    }
    let saved = try await block("0x" + String(number, radix: 16))
    try require(
      try quantity(saved, "number") == number
        && EarnValues.hash(CashoutJSON.string(saved, "hash"))
          == EarnValues.hash(CashoutJSON.string(quote, "referenceHash"))
    )
    return number
  }
  private func transfer(_ log: [String: Any], _ quote: [String: Any]) throws -> String? {
    let topic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
    guard
      try CashoutJSON.string(log, "address").lowercased()
        == CashoutJSON.string(quote, "destinationToken").lowercased(),
      log["removed"] as? Bool != true,
      let topics = log["topics"] as? [String], topics.count == 3,
      topics[0].lowercased() == topic,
      topics[2].lowercased() == "0x"
        + (try EarnValues.addressWord(CashoutJSON.string(quote, "destinationRecipient")))
    else { return nil }
    _ = try EarnValues.hash(topics[1])
    let data = try EarnValues.hash(CashoutJSON.string(log, "data"))
    // The shared parser accepts canonical quantities, not padded ABI words.
    let digits = data.dropFirst(2).drop(while: { $0 == "0" })
    if digits.isEmpty { return nil }
    return try earnQuantityValue(value: "0x" + digits)
  }
  func scan(quote: [String: Any], saved: CashoutScan?) async throws -> CashoutScan {
    let anchor = try await reference(quote)
    let raw = saved?.nextScanBlock ?? String(anchor + 1)
    guard let from = UInt64(raw), String(from) == raw, from > anchor, from < UInt64.max - 4096
    else { throw WalletFailure.invalid }
    let head = try await block("finalized")
    let last = try quantity(head, "number")
    var hashes = try (saved?.transactionHashes ?? []).map(EarnValues.hash)
    try require(Set(hashes).count == hashes.count && hashes.count <= 128)
    let end = min(last, from + 4095)
    if from <= last {
      let filter: [String: Any] = [
        "address": try CashoutJSON.string(quote, "destinationToken"),
        "fromBlock": "0x" + String(from, radix: 16), "toBlock": "0x" + String(end, radix: 16),
        "topics": [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", NSNull(),
          "0x" + (try EarnValues.addressWord(CashoutJSON.string(quote, "destinationRecipient"))),
        ] as [Any],
      ]
      guard let logs = try await call("eth_getLogs", [filter]) as? [[String: Any]],
        logs.count <= 4096
      else { throw WalletFailure.invalid }
      for log in logs {
        try require(try (from...end).contains(quantity(log, "blockNumber")))
        if try transfer(log, quote) != nil {
          let hash = try EarnValues.hash(CashoutJSON.string(log, "transactionHash"))
          if !hashes.contains(hash) { hashes.append(hash) }
        }
      }
    }
    try require(hashes.count <= 128)
    return CashoutScan(
      transactionHashes: hashes, nextScanBlock: String(from > last ? from : end + 1),
      complete: from > last || end == last)
  }
  func confirm(quote: [String: Any], transactionHash: String) async throws -> [CashoutReceipt] {
    let anchor = try await reference(quote)
    let hash = try EarnValues.hash(transactionHash)
    let receipt = try EarnValues.object(await call("eth_getTransactionReceipt", [hash]))
    try require(
      try CashoutJSON.string(receipt, "status") == "0x1"
        && EarnValues.hash(CashoutJSON.string(receipt, "transactionHash")) == hash)
    let number = try quantity(receipt, "blockNumber")
    try require(number > anchor)
    let blockHash = try EarnValues.hash(CashoutJSON.string(receipt, "blockHash"))
    let tag = "0x" + String(number, radix: 16)
    let canonical = try await block(tag)
    try require(
      try quantity(canonical, "number") == number
        && EarnValues.hash(CashoutJSON.string(canonical, "hash")) == blockHash)
    let seconds = try quantity(canonical, "timestamp")
    try require(seconds <= UInt64.max / 1000)
    let timestamp = seconds * 1000
    let observed = try CashoutJSON.uint(
      quote, quote["receiptObservedAtMs"] == nil ? "observedAtMs" : "receiptObservedAtMs")
    try require(timestamp >= (observed > 1000 ? observed - 1000 : 0) && timestamp <= now() + 5000)
    let finalized = try await block("finalized")
    try require(try quantity(finalized, "number") >= number)
    guard let logs = receipt["logs"] as? [[String: Any]], logs.count <= 4096 else {
      throw WalletFailure.invalid
    }
    var seen = Set<UInt64>()
    var result: [CashoutReceipt] = []
    for log in logs {
      guard let amount = try transfer(log, quote) else { continue }
      try require(
        try EarnValues.hash(CashoutJSON.string(log, "transactionHash")) == hash
          && quantity(log, "blockNumber") == number
          && EarnValues.hash(CashoutJSON.string(log, "blockHash")) == blockHash)
      let index = try quantity(log, "logIndex")
      try require(index <= UInt64(Int32.max) && seen.insert(index).inserted)
      result.append(
        CashoutReceipt(
          transactionHash: hash, logIndex: index, receivedAtoms: amount,
          blockNumber: String(number), blockHash: blockHash))
    }
    try require(!result.isEmpty)
    let checked = try await block(tag)
    try require(
      try quantity(checked, "number") == number
        && EarnValues.hash(CashoutJSON.string(checked, "hash")) == blockHash)
    return result
  }
}

/// Schema order is part of the backend commitment; JSONEncoder's key order is not used.
internal func cashoutGroupIdentity(plan: CashoutPlan, recipients: [String]) throws -> String {
  try plan.validate()
  try require(recipients.count == plan.proposal.recipientIndices.count)
  func string(_ value: String) throws -> String { try CashoutJSON.text(value) }
  func object(_ fields: [(String, String)]) throws -> String {
    "{" + (try fields.map { try string($0.0) + ":" + $0.1 }).joined(separator: ",") + "}"
  }
  func array(_ values: [String]) -> String { "[" + values.joined(separator: ",") + "]" }
  let p = plan.proposal
  let sources = try p.sources.map { s in
    try object([
      ("kind", string(s.kind)), ("profileChainId", String(s.profileChainId)),
      ("cycleIndex", String(s.cycleIndex)), ("address", string(s.address.lowercased())),
      ("amountAtoms", string(s.amountAtoms)),
    ])
  }
  let proposal = try object([
    ("operationId", string(p.operationId)), ("amountAtoms", string(p.amountAtoms)),
    ("sources", array(sources)), ("recipientIndices", array(p.recipientIndices.map(String.init))),
    ("weightsBps", array(p.weightsBps.map(String.init))),
  ])
  let children = try plan.children.map { c in
    try object([
      ("source", String(c.source)), ("slot", String(c.slot)),
      ("amountAtoms", string(c.amountAtoms)),
    ])
  }
  let canonical = try object([
    ("plan", object([("proposal", proposal), ("children", array(children))])),
    ("recipients", array(try recipients.map { try string($0.lowercased()) })),
  ])
  return SHA256.hash(data: Data(("gizu-cashout-group:v1\0" + canonical).utf8)).map {
    String(format: "%02x", $0)
  }.joined()
}
