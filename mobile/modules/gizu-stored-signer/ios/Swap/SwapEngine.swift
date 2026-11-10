import Foundation

internal enum StoredSwapUi {
  case review(String)
  case unlock
  case done([String: Any])
}

internal final class StoredSwapEngine {
  private let storage: WalletStorage
  private let saved: StoredSwapFile
  private let gateway: String
  private var operation: SwapOperation?
  private var fundingAddress: String?
  /// New swaps draw their wallet count and shares at random (buy) or return to as many wallets
  /// as they sell from (sell). Turning this off restores the fixed three-wallet 30/30/40 plan.
  private static let randomLegs = true

  init(storage: WalletStorage, saved: StoredSwapFile, gateway: String) {
    self.storage = storage
    self.saved = saved
    self.gateway = gateway
  }

  func start(record: WalletRecord, target: String, amountAtoms: String?, payout: Bool = false)
    throws
  {
    try require(record.verified && record.id == saved.walletId && operation == nil)
    if let existing = try saved.load(), let state = existing["state"] as? String {
      let previous = try SwapOperation.restore(state: state, gateway: gateway)
      let phase = try statusObject(previous.publicStatus())["phase"] as? String
      try require(phase == "CANCELLED" || phase == "COMPLETE")
      try saved.portfolio.remember(state: state, status: previous.publicStatus())
    }
    try require(target.range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil)
    if let amountAtoms {
      try require(amountAtoms.range(of: "^[1-9][0-9]{0,8}$", options: .regularExpression) != nil)
      try require((Int(amountAtoms) ?? 0) <= 10_000_000)
    }
    // A buy with a budget draws its wallet count and shares once, before review; a buy from the
    // existing private balance has no budget to size from and keeps the fixed three-wallet plan.
    var legs: SwapLegChoice?
    if Self.randomLegs, !payout, let amountAtoms {
      legs = try chooseBuyLegs(budgetAtoms: amountAtoms, random: randomBytes(32))
    }
    let reserved: RecipientAllocation
    if let legs {
      reserved = try allocateSwapRecipientsN(registry: record.roleRegistry, count: legs.count)
    } else {
      reserved = try allocateSwapRecipients(registry: record.roleRegistry)
    }
    try storage.persistRegistry(reserved.registry, expectedId: record.id)
    var plan: [String: Any] = [
      "kind": payout ? "confidentialPayout" : "confidentialSwap", "target": target,
      "recipientIndices": reserved.indices.map { Int($0) },
    ]
    if let legs { plan["weights"] = legs.weights.map { Int($0) } }
    if let amountAtoms { plan["amountAtoms"] = amountAtoms }
    fundingAddress = try deriveAccountAddressRange(entropy: record.entropy, start: 1, count: 1)
      .first
    operation = try SwapOperation.start(
      plan: String(data: JSONSerialization.data(withJSONObject: plan), encoding: .utf8)!,
      entropy: record.entropy, gateway: gateway, nowMs: now())
    try persist()
  }

  func startSell(record: WalletRecord, holdingId: String? = nil) throws {
    try require(record.verified && record.id == saved.walletId && operation == nil)
    let existing = try saved.load()
    if let state = existing?["state"] as? String {
      let previous = try SwapOperation.restore(state: state, gateway: gateway)
      let phase = try swapObject(previous.publicStatus())["phase"] as? String
      // An explicit resume must handle unfinished work; never replace its journal.
      try require(phase == "COMPLETE" || phase == "CANCELLED")
      try saved.portfolio.remember(state: state, status: previous.publicStatus())
    }
    let target: String
    let holders: [UInt32]
    if let holdingId {
      let selected = try selectSwapHolding(
        id: holdingId, registry: record.roleRegistry, excluded: SwapHoldings.excluded(record),
        tracked: saved.portfolio.targets())
      target = selected.target
      holders = selected.indices
    } else {
      guard let state = existing?["state"] as? String,
        let plan = try swapObject(state)["plan"] as? [String: Any],
        let kind = plan["kind"] as? String,
        ["confidentialSwap", "confidentialPayout"].contains(kind),
        let token = plan["target"] as? String
      else { throw WalletFailure.invalid }
      let previous = try SwapOperation.restore(state: state, gateway: gateway)
      try require(try swapObject(previous.publicStatus())["phase"] as? String == "COMPLETE")
      let selected = try selectSwapHolding(
        id: "\(token.lowercased()):all", registry: record.roleRegistry,
        excluded: SwapHoldings.excluded(record), tracked: saved.portfolio.targets())
      target = selected.target
      holders = selected.indices
    }
    var next: [String: Any]
    if holdingId == nil || holdingId?.hasSuffix(":all") == true {
      // The shared selector freezes owned holders, including partial groups and excluding Earn.
      // Private sales need no new public receiving accounts.
      next = [
        "kind": "confidentialSell", "completionTarget": "confidential", "target": target,
        "holderIndices": holders, "recipientIndices": holders,
      ]
    } else {
      let owned = Set(
        try swapHoldingIndices(
          registry: record.roleRegistry, excluded: SwapHoldings.excluded(record))
      )
      try require(
        holders.count == 3 && Set(holders).count == 3 && holders.allSatisfy { owned.contains($0) })
      // A sell returns to as many fresh wallets as it sells from.
      // Like a buy, a sell pays out to a randomly sized set of fresh wallets: reserve the most it
      // can use and let the engine draw the count and shares once the sale is priced.
      let reserved: RecipientAllocation
      if Self.randomLegs {
        reserved = try allocateSwapRecipientsN(registry: record.roleRegistry, count: 5)
      } else {
        reserved = try allocateSwapRecipients(registry: record.roleRegistry)
      }
      try storage.persistRegistry(reserved.registry, expectedId: record.id)
      next = [
        "kind": "confidentialSell", "target": target, "holderIndices": holders,
        "recipientIndices": reserved.indices,
      ]
      if Self.randomLegs {
        next["legsRandom"] = try randomBytes(32).map { String(format: "%02x", $0) }.joined()
      }
    }
    fundingAddress = try deriveAccountAddressRange(entropy: record.entropy, start: 1, count: 1)
      .first
    operation = try SwapOperation.start(
      plan: String(data: JSONSerialization.data(withJSONObject: next), encoding: .utf8)!,
      entropy: record.entropy, gateway: gateway, nowMs: now())
    try persist()
  }

  func startRecovery(record: WalletRecord, target: String) throws {
    try require(record.verified && record.id == saved.walletId && operation == nil)
    try SwapPortfolioStore.validateTarget(target.lowercased())
    if let root = try saved.load(), let state = root["state"] as? String {
      let previous = try SwapOperation.restore(state: state, gateway: gateway)
      let phase = try swapObject(previous.publicStatus())["phase"] as? String
      // Recovery cannot overwrite an existing incomplete operation.
      if phase != "COMPLETE" && phase != "CANCELLED" {
        fundingAddress = root["fundingAddress"] as? String
        operation = previous
        try retry()
        return
      }
      try saved.portfolio.remember(state: state, status: previous.publicStatus())
    }
    let end = try registryNext(record.roleRegistry)
    try require(end >= 6 && end <= 8192)
    let plan: [String: Any] = [
      "kind": "confidentialRecovery", "target": target,
      "recipientIndices": [3, 4, 5], "scanTo": end,
    ]
    fundingAddress = try deriveAccountAddressRange(entropy: record.entropy, start: 1, count: 1)
      .first
    operation = try SwapOperation.start(
      plan: String(data: JSONSerialization.data(withJSONObject: plan), encoding: .utf8)!,
      entropy: record.entropy, gateway: gateway, nowMs: now())
    try persist()
  }

  func retry() throws {
    try current().retry()
    try persist()
  }

  func restore() throws {
    let root = try saved.load()
    fundingAddress = root?["fundingAddress"] as? String
    guard let state = root?["state"] as? String, fundingAddress != nil else {
      throw WalletFailure.invalid
    }
    operation = try SwapOperation.restore(state: state, gateway: gateway)
  }

  func advance(onProgress: @MainActor ([String: Any]) -> Void = { _ in }) async throws
    -> StoredSwapUi
  {
    let op = try current()
    while true {
      try Task.checkCancellation()
      await onProgress(try view())
      try Task.checkCancellation()
      switch try op.nextStep(nowMs: now()) {
      case .review(let text): return .review(text)
      case .unlock: return .unlock
      case .finished, .paused:
        try persist()
        return .done(try view())
      case .wait(let millis):
        try persist()
        try await Task.sleep(nanoseconds: min(millis, 30_000) * 1_000_000)
      case .request(let id, let method, let url, let body):
        try require(StoredSwapHTTP.allowed(url))
        try persist()
        let response = await StoredSwapHTTP.execute(method, url, body)
        try Task.checkCancellation()
        try op.onResponse(id: id, status: response.0, body: response.1, nowMs: now())
        try persist()
      }
    }
  }

  func approve(record: WalletRecord) throws {
    // The ceremony calls this only after a successful passkey assertion. Restored operations
    // have no in-memory key, and a long review may have outlived the previous session.
    try require(record.verified && record.id == saved.walletId)
    try current().unlock(entropy: record.entropy, nowMs: now())
    try current().approve(nowMs: now())
    try persist()
  }

  func unlock(record: WalletRecord) throws {
    try require(record.id == saved.walletId)
    try current().unlock(entropy: record.entropy, nowMs: now())
    try persist()
  }

  func cancel() throws {
    try current().cancel()
    try persist()
  }

  func view() throws -> [String: Any] {
    let status = try statusObject(current().publicStatus())
    return [
      "operationId": status["operationId"] as Any, "phase": status["phase"] as Any,
      "step": status["step"] as Any, "pausedCode": status["pausedCode"] as Any,
      "targetSymbol": status["targetSymbol"] as Any,
      "targetDecimals": status["targetDecimals"] as Any,
      "sourceAtoms": status["sourceAtoms"] as Any, "creditedAtoms": status["creditedAtoms"] as Any,
      "payoutsSubmitted": status["payoutsSubmitted"] as Any,
      "ordersComplete": status["ordersComplete"] as Any,
      "receivedTargetAtoms": status["receivedTargetAtoms"] as Any,
      "direction": status["direction"] as Any,
      "completionTarget": status["completionTarget"] as Any,
      "privateCreditedAtoms": status["privateCreditedAtoms"] as Any,
      "soldAtoms": status["soldAtoms"] as Any,
      "receivedUsdgAtoms": status["receivedUsdgAtoms"] as Any,
      "returnAddresses": returnAddresses(), "fundingAddress": fundingAddress as Any,
    ]
  }

  private func returnAddresses() -> [String] {
    guard let existing = try? saved.load(), let state = existing["state"] as? String,
      let data = state.data(using: .utf8),
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let plan = root["plan"] as? [String: Any], plan["kind"] as? String == "confidentialSell",
      plan["completionTarget"] as? String != "confidential",
      let recipients = root["recipients"] as? [String]
    else { return [] }
    return recipients
  }

  func close() { operation = nil }

  private func current() throws -> SwapOperation {
    guard let operation else { throw WalletFailure.invalid }
    return operation
  }

  private func persist() throws {
    let op = try current()
    guard let fundingAddress else { throw WalletFailure.invalid }
    let state = try op.exportState()
    // Commit recoverable transaction state before its independently rebuildable public summary.
    try saved.save(operationId: op.operationId(), state: state, fundingAddress: fundingAddress)
    try saved.portfolio.remember(state: state, status: op.publicStatus())
  }

  private func now() -> UInt64 { UInt64(Date().timeIntervalSince1970 * 1000) }

  private func statusObject(_ json: String) throws -> [String: Any] {
    guard let data = json.data(using: .utf8),
      let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { throw WalletFailure.invalid }
    return object
  }
}

internal enum StoredSwapHTTP {
  static func allowed(_ url: String) -> Bool {
    let local =
      url.hasPrefix("http://127.0.0.1:") || url.hasPrefix("http://localhost:")
      || url.hasPrefix("http://10.0.2.2:")
    return (url.hasPrefix("https://") || local) && !url.contains("?") && !url.contains("#")
      && url.count <= 300
  }

  static func execute(_ method: String, _ url: String, _ body: String?) async -> (UInt16, String) {
    guard allowed(url), method == "GET" || method == "POST", let endpoint = URL(string: url) else {
      return (0, "")
    }
    var request = URLRequest(url: endpoint)
    request.httpMethod = method
    request.timeoutInterval = 30
    if method == "POST" {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = Data((body ?? "").utf8)
    }
    let config = URLSessionConfiguration.ephemeral
    config.urlCache = nil
    config.httpCookieStorage = nil
    do {
      let (data, response) = try await URLSession(configuration: config).data(for: request)
      guard data.count <= 1_048_576, let http = response as? HTTPURLResponse else { return (0, "") }
      return (UInt16(http.statusCode), String(decoding: data, as: UTF8.self))
    } catch {
      return (0, "")
    }
  }
}
