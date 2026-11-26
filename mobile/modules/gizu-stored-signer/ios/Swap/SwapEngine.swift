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
  private var batch: SwapFundingBatch?
  private let transport: (String, String, String?) async -> (UInt16, String)
  /// New swaps draw their wallet count and shares at random (buy) or return to as many wallets
  /// as they sell from (sell). Turning this off restores the fixed three-wallet 30/30/40 plan.
  private static let randomLegs = true

  init(
    storage: WalletStorage, saved: StoredSwapFile, gateway: String,
    transport: @escaping (String, String, String?) async -> (UInt16, String) = StoredSwapHTTP
      .execute
  ) {
    self.transport = transport
    self.storage = storage
    self.saved = saved
    self.gateway = gateway
  }

  func start(
    record: WalletRecord, target: String, amountAtoms: String?, payout: Bool = false,
    chainId: UInt64 = SwapChain.robinhood.rawValue
  ) throws {
    try require(record.verified && record.id == saved.walletId && operation == nil)
    try require(SwapChain(rawValue: chainId) != nil)
    if let existing = try saved.load(), let state = existing["state"] as? String {
      try requireBatchFinished(existing)
      let previous = try SwapOperation.restore(state: state, gateway: gateway)
      let phase = try statusObject(previous.publicStatus())["phase"] as? String
      try require(phase == "CANCELLED" || phase == "COMPLETE")
      try saved.portfolio.remember(state: state, status: previous.publicStatus())
    }
    try require(target.range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil)
    if let amountAtoms {
      try require(
        UInt64(amountAtoms) != nil
          && amountAtoms.range(of: "^[1-9][0-9]{0,19}$", options: .regularExpression) != nil)
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
      "chainId": chainId, "recipientIndices": reserved.indices.map { Int($0) },
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

  /// The ceremony authorizes the initial private balance read before calling this method.
  func startFunding(
    record: WalletRecord, target: String, amountAtoms: String, chainId: UInt64,
    services: SwapFundingServices? = nil
  ) async throws {
    try require(
      record.verified && record.id == saved.walletId && record.journalId == saved.generation
        && operation == nil)
    try require(
      SwapChain(rawValue: chainId) != nil && UInt64(amountAtoms) != nil && amountAtoms != "0")
    try SwapPortfolioStore.validateTarget(target.lowercased())
    // Reuse native destination admission before reserving or funding an ignored fund-only target.
    let validation: [String: Any] = [
      "kind": "confidentialPayout", "target": target, "chainId": chainId,
      "amountAtoms": amountAtoms, "recipientIndices": [3], "weights": [10_000],
    ]
    _ = try SwapOperation.start(
      plan: String(decoding: JSONSerialization.data(withJSONObject: validation), as: UTF8.self),
      entropy: record.entropy, gateway: gateway, nowMs: now())
    let previous = try saved.load()
    let admissionLedger = FundingReservations(store: storage, record: record)
    var activeParents = Set<String>()
    if let previous, previous["version"] as? Int == 2 {
      let old = try JSONDecoder().decode(
        SwapFundingBatch.self,
        from: JSONSerialization.data(withJSONObject: previous["batch"] as Any))
      fundingAddress = previous["fundingAddress"] as? String
      // The authenticated saved signatures acquire sticky ownership before any orphan pruning.
      _ = try adoptSavedSourceOwnership(old, record: record, state: previous["state"] as! String)
      if old.terminal == nil { activeParents.insert(old.operationId) }
    }
    try admissionLedger.pruneOrphanUnsigned(activeParentIds: activeParents)
    if let previous {
      if previous["version"] as? Int == 2 {
        let old = try JSONDecoder().decode(
          SwapFundingBatch.self,
          from: JSONSerialization.data(withJSONObject: previous["batch"] as Any))
        try require(old.terminal != nil)
      } else {
        let old = try SwapOperation.restore(state: previous["state"] as! String, gateway: gateway)
        try require(
          ["COMPLETE", "CANCELLED"].contains(
            try statusObject(old.publicStatus())["phase"] as? String ?? ""))
      }
    }
    try assertCashoutInactive(store: storage, record: record)
    let api = services ?? .native(gateway: gateway)
    let privateAddress = try deriveAccountAddressRange(entropy: record.entropy, start: 2, count: 1)[
      0]
    let balance = try ConfidentialBalance.publicBalance(
      try await api.privateBalance(record), address: privateAddress, now: Int64(now()))
    let privateHeld = balance["available"] as! String
    let approvedPrivate = FundingAtoms.less(privateHeld, amountAtoms) ? privateHeld : amountAtoms
    let requested = FundingAtoms.subtract(amountAtoms, approvedPrivate)
    let ledger = FundingReservations(store: storage, record: record)
    var sources: [SwapFundingChild] = []
    if requested != "0" {
      let observed = try await api.sources(storage)
      var candidates: [[String: Any]] = []
      var capacity = "0"
      let ordered = try observed.map { row -> ([String: Any], Bool) in
        guard let chain = row["sourceChainId"] as? Int,
          let owner = row["owner"] as? String,
          let held = row["balanceAtoms"] as? String
        else { return (row, false) }
        let free = FundingAtoms.subtract(
          try FundingAtoms.validate(held),
          try ledger.reservedAtoms(chainId: chain, owner: owner))
        return (row, !FundingAtoms.less(free, requested))
      }.sorted {
        ($0.1 ? 0 : 1, $0.0["accountIndex"] as? Int ?? 0, $0.0["sourceChainId"] as? Int ?? 0)
          < ($1.1 ? 0 : 1, $1.0["accountIndex"] as? Int ?? 0, $1.0["sourceChainId"] as? Int ?? 0)
      }.map { $0.0 }
      for row in ordered.prefix(128) {
        guard let chain = row["sourceChainId"] as? Int, let index = row["accountIndex"] as? Int,
          let owner = row["owner"] as? String, let held = row["balanceAtoms"] as? String
        else { continue }
        try require(index > 0 && index < 8192 && (chain == 143 || index == 1))
        let token = try fundingUsdc(chain)
        try require(
          (row["token"] as? String)?.lowercased() == token && row["decimals"] as? Int == 6)
        let derived = try deriveAccountAddressRange(
          entropy: record.entropy, start: UInt32(index), count: 1)[0]
        try require(owner.lowercased() == derived.lowercased())
        let reserved = try ledger.reservedAtoms(chainId: chain, owner: owner)
        let free = FundingAtoms.subtract(try FundingAtoms.validate(held), reserved)
        if free == "0" { continue }
        let cap = try await api.fee(chain, owner, privateAddress, free)
        if !FundingAtoms.less(cap, free) { continue }
        candidates.append([
          "sourceIndex": index, "sourceChainId": chain, "token": token, "decimals": 6,
          "address": owner, "balanceAtoms": held, "reservedAtoms": reserved,
          "fundingFeeAtoms": cap, "executionReserveAtoms": "0",
        ])
        capacity = try FundingAtoms.add(capacity, free)
        if !FundingAtoms.less(capacity, requested) { break }
      }
      let allocation = try swapObject(
        planPublicSourceAllocation(
          registry: record.roleRegistry, requestedBudgetAtoms: requested,
          sourcesJson: String(
            decoding: JSONSerialization.data(withJSONObject: candidates), as: UTF8.self)))
      guard let legs = allocation["legs"] as? [[String: Any]] else { throw WalletFailure.invalid }
      for leg in legs {
        let chain = leg["sourceChainId"] as! Int
        let index = leg["sourceIndex"] as! Int
        let owner = leg["address"] as! String
        let observed = candidates.first {
          $0["sourceChainId"] as? Int == chain && $0["sourceIndex"] as? Int == index
        }!
        sources.append(
          SwapFundingChild(
            sourceId: "\(chain):\(try fundingUsdc(chain)):\(owner.lowercased())",
            sourceChainId: chain, token: try fundingUsdc(chain), sourceIndex: UInt32(index),
            address: owner, budgetAtoms: leg["budgetAtoms"] as! String,
            balanceAtoms: observed["balanceAtoms"] as! String))
      }
    }
    try Task.checkCancellation()
    let fresh = try storage.load()
    defer { fresh.close() }
    try require(fresh.id == record.id && fresh.journalId == record.journalId && fresh.verified)
    let choice = try chooseBuyLegs(budgetAtoms: amountAtoms, random: randomBytes(32))
    let recipients = try allocateSwapRecipientsN(registry: fresh.roleRegistry, count: choice.count)
    try storage.persistRegistry(recipients.registry, expectedId: fresh.id)
    let parent = "funding_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    var next = SwapFundingBatch(
      operationId: parent, generation: record.journalId, target: target, chainId: chainId,
      budgetAtoms: amountAtoms, approvedExistingPrivateAtoms: approvedPrivate,
      recipientIndices: recipients.indices, weights: choice.weights, sources: sources)
    try ledger.reserve(
      parentId: parent,
      sources: sources.map {
        [
          "sourceId": $0.sourceId, "sourceChainId": $0.sourceChainId, "token": $0.token,
          "address": $0.address, "budgetAtoms": $0.budgetAtoms, "balanceAtoms": $0.balanceAtoms,
        ]
      })
    fundingAddress = try deriveAccountAddressRange(entropy: fresh.entropy, start: 1, count: 1)[0]
    batch = next
    try startNextBatchOperation(record: fresh)
    next = batch!
    try next.validate(walletId: fresh.id, generation: fresh.journalId)
    try persist()
  }

  private func startNextBatchOperation(record: WalletRecord) throws {
    guard var parent = batch else { throw WalletFailure.invalid }
    try require(
      record.verified && record.id == saved.walletId && record.journalId == parent.generation)
    let plan: [String: Any]
    if let index = parent.activeSource {
      let source = parent.sources[index]
      try require(
        source.state == nil && parent.sources.prefix(index).allSatisfy { $0.creditedAtoms != nil })
      plan = [
        "kind": "confidentialFunding", "target": parent.target, "chainId": parent.chainId,
        "sourceChainId": source.sourceChainId, "sourceIndex": source.sourceIndex,
        "amountAtoms": source.budgetAtoms, "recipientIndices": [],
      ]
    } else {
      try require(parent.downstreamState == nil)
      let funded = try parent.combinedAmount()
      parent.fundedAtoms = funded
      plan = [
        "kind": "confidentialPayout", "target": parent.target, "chainId": parent.chainId,
        "amountAtoms": funded, "recipientIndices": parent.recipientIndices,
        "weights": parent.weights,
      ]
    }
    let op = try SwapOperation.start(
      plan: String(decoding: JSONSerialization.data(withJSONObject: plan), as: UTF8.self),
      entropy: record.entropy, gateway: gateway, nowMs: now())
    if let index = parent.activeSource {
      parent.sources[index].operationId = op.operationId()
    } else {
      parent.downstreamState = try op.exportState()
    }
    batch = parent
    operation = op
    try persist()
  }

  private func requireBatchFinished(_ root: [String: Any]) throws {
    if root["version"] as? Int == 2 {
      let previous = try JSONDecoder().decode(
        SwapFundingBatch.self, from: JSONSerialization.data(withJSONObject: root["batch"] as Any))
      try require(previous.terminal != nil)
    }
  }

  func startSell(record: WalletRecord, holdingId: String? = nil) throws {
    try require(record.verified && record.id == saved.walletId && operation == nil)
    let existing = try saved.load()
    if let state = existing?["state"] as? String {
      try requireBatchFinished(existing!)
      let previous = try SwapOperation.restore(state: state, gateway: gateway)
      let phase = try swapObject(previous.publicStatus())["phase"] as? String
      // An explicit resume must handle unfinished work; never replace its journal.
      try require(phase == "COMPLETE" || phase == "CANCELLED")
      try saved.portfolio.remember(state: state, status: previous.publicStatus())
    }
    let target: String
    let holders: [UInt32]
    let chainId: UInt64
    if let holdingId {
      // A holding ID names its token; the ledger knows which chain that token lives on.
      chainId = try saved.portfolio.chainOf(String(holdingId.prefix { $0 != ":" }))
      let selected = try selectSwapHolding(
        id: holdingId, registry: record.roleRegistry, excluded: SwapHoldings.excluded(record),
        tracked: saved.portfolio.targets(chainId: chainId))
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
      chainId = try SwapPortfolioStore.chainId(plan["chainId"])
      let selected = try selectSwapHolding(
        id: "\(token.lowercased()):all", registry: record.roleRegistry,
        excluded: SwapHoldings.excluded(record), tracked: saved.portfolio.targets(chainId: chainId))
      target = selected.target
      holders = selected.indices
    }
    var next: [String: Any]
    if holdingId == nil || holdingId?.hasSuffix(":all") == true {
      // The shared selector freezes owned holders, including partial groups and excluding Earn.
      // Private sales need no new public receiving accounts.
      next = [
        "kind": "confidentialSell", "completionTarget": "confidential", "target": target,
        "chainId": chainId, "holderIndices": holders, "recipientIndices": holders,
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
        "kind": "confidentialSell", "target": target, "chainId": chainId,
        "holderIndices": holders, "recipientIndices": reserved.indices,
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

  func startRecovery(
    record: WalletRecord, target: String, chainId: UInt64 = SwapChain.robinhood.rawValue
  ) throws {
    try require(record.verified && record.id == saved.walletId && operation == nil)
    try require(SwapChain(rawValue: chainId) != nil)
    try SwapPortfolioStore.validateTarget(target.lowercased())
    if let root = try saved.load(), let state = root["state"] as? String {
      if root["version"] as? Int == 2 {
        try restore()
        if batch?.terminal == nil {
          try retry()
          return
        }
      }
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
      "chainId": chainId, "recipientIndices": [3, 4, 5], "scanTo": end,
    ]
    fundingAddress = try deriveAccountAddressRange(entropy: record.entropy, start: 1, count: 1)
      .first
    operation = try SwapOperation.start(
      plan: String(data: JSONSerialization.data(withJSONObject: plan), encoding: .utf8)!,
      entropy: record.entropy, gateway: gateway, nowMs: now())
    try persist()
  }

  func retry() throws {
    if batch != nil { batch!.paused = false }
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
    if root?["version"] as? Int == 2 {
      batch = try JSONDecoder().decode(
        SwapFundingBatch.self, from: JSONSerialization.data(withJSONObject: root!["batch"] as Any))
      let record = try storage.load()
      defer { record.close() }
      batch = try adoptSavedSourceOwnership(batch!, record: record, state: state)
      try FundingReservations(store: storage, record: record).pruneOrphanUnsigned(
        activeParentIds: batch!.terminal == nil ? [batch!.operationId] : [])
    }
  }

  private func adoptSavedSourceOwnership(
    _ parent: SwapFundingBatch, record: WalletRecord, state: String
  ) throws -> SwapFundingBatch {
    var recovered = parent
    let ledger = FundingReservations(store: storage, record: record)
    for index in recovered.sources.indices {
      let source = recovered.sources[index]
      guard let savedState = source.state else { continue }
      let data = try EarnValues.object(swapObject(savedState)["data"] as Any)
      guard data["signedOperation"] != nil && !(data["signedOperation"] is NSNull) else { continue }
      guard let operationId = source.operationId else { throw WalletFailure.invalid }
      try ledger.adoptSigned(
        parentId: parent.operationId, sourceId: source.sourceId,
        chainId: source.sourceChainId, token: source.token, owner: source.address,
        budgetAtoms: source.budgetAtoms, operationId: operationId)
      if source.creditedAtoms != nil {
        if source.originObservationInvalidated != true {
          try MainnetPortfolio.invalidateConfirmedFunding(
            store: storage,
            sourceChainId: source.sourceChainId, owner: source.address)
          recovered.sources[index].originObservationInvalidated = true
          guard let fundingAddress else { throw WalletFailure.invalid }
          // Mark this exact cache suppression durably; replay must preserve later deposits.
          try saved.saveBatch(recovered, state: state, fundingAddress: fundingAddress)
        }
        try ledger.complete(
          parentId: parent.operationId, sourceId: source.sourceId, operationId: operationId)
      }
    }
    return recovered
  }

  func advance(onProgress: @MainActor ([String: Any]) -> Void = { _ in }) async throws
    -> StoredSwapUi
  {
    if let parent = batch, parent.terminal != nil || parent.paused { return .done(try view()) }
    if let parent = batch, !parent.reviewed { return .review(parent.review()) }
    while true {
      let op = try current()
      try Task.checkCancellation()
      await onProgress(try view())
      try Task.checkCancellation()
      switch try op.nextStep(nowMs: now()) {
      case .review(let text): return .review(text)
      case .unlock: return .unlock
      case .finished:
        if var parent = batch {
          let record = try storage.load()
          defer { record.close() }
          try require(record.id == saved.walletId && record.journalId == parent.generation)
          let status = try statusObject(op.publicStatus())
          if let index = parent.sources.firstIndex(where: { $0.operationId == op.operationId() }) {
            if parent.sources[index].creditedAtoms == nil {
              guard status["phase"] as? String == "COMPLETE",
                let credit = status["creditedAtoms"] as? String
              else { throw WalletFailure.invalid }
              try require(
                credit != "0" && !FundingAtoms.less(parent.sources[index].budgetAtoms, credit))
              parent.sources[index].state = try op.exportState()
              batch = parent
              // This durable write is the barrier before another source captures its baseline.
              try persist()
              try MainnetPortfolio.invalidateConfirmedFunding(
                store: storage,
                sourceChainId: parent.sources[index].sourceChainId,
                owner: parent.sources[index].address)
              parent.sources[index].creditedAtoms = credit
              parent.sources[index].originObservationInvalidated = true
              batch = parent
              try persist()
              try FundingReservations(store: storage, record: record).complete(
                parentId: parent.operationId, sourceId: parent.sources[index].sourceId,
                operationId: op.operationId())
            }
            if parent.cancelRequested {
              parent.terminal = "CANCELLED"
              batch = parent
              try FundingReservations(store: storage, record: record).releaseUnsigned(
                parentId: parent.operationId)
              try persist()
              return .done(try view())
            }
            try startNextBatchOperation(record: record)
            continue
          }
          parent.terminal = status["phase"] as? String == "COMPLETE" ? "COMPLETE" : nil
          batch = parent
        }
        try persist()
        return .done(try view())
      case .paused:
        try persist()
        return .done(try view())
      case .wait(let millis):
        try persist()
        try await Task.sleep(nanoseconds: min(millis, 30_000) * 1_000_000)
      case .request(let id, let method, let url, let body):
        try require(StoredSwapHTTP.allowed(url))
        try persist()
        if batch != nil { try MainnetPortfolio.invalidate(store: storage) }
        let response = await transport(method, url, body)
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
    if let batch { try require(record.journalId == batch.generation) }
    try current().unlock(entropy: record.entropy, nowMs: now())
    if batch != nil && !batch!.reviewed {
      batch!.reviewed = true
    } else {
      try current().approve(nowMs: now())
    }
    try persist()
  }

  func unlock(record: WalletRecord) throws {
    try require(record.id == saved.walletId)
    if let batch { try require(record.verified && record.journalId == batch.generation) }
    try current().unlock(entropy: record.entropy, nowMs: now())
    try persist()
  }

  func cancel() throws {
    if var parent = batch {
      parent.cancelRequested = true
      parent.paused = true
      let state = try swapObject(current().exportState())
      let data = try EarnValues.object(state["data"] as Any)
      let hasSigned =
        !(data["signedOperation"] is NSNull) && data["signedOperation"] != nil
        || ((data["payouts"] as? [[String: Any]]) ?? []).contains {
          $0["signed"] != nil && !($0["signed"] is NSNull)
        }
      if !hasSigned {
        try current().cancel()
        parent.terminal = "CANCELLED"
      }
      batch = parent
      let record = try storage.load()
      defer { record.close() }
      if let root = try saved.load(), root["version"] as? Int == 2 {
        let committed = try JSONDecoder().decode(
          SwapFundingBatch.self,
          from: JSONSerialization.data(withJSONObject: root["batch"] as Any))
        let recovered = try adoptSavedSourceOwnership(
          committed, record: record, state: root["state"] as! String)
        for index in parent.sources.indices
        where recovered.sources[index].originObservationInvalidated == true {
          parent.sources[index].originObservationInvalidated = true
        }
        batch = parent
      }
      try FundingReservations(store: storage, record: record).releaseUnsigned(
        parentId: parent.operationId)
    } else {
      try current().cancel()
    }
    try persist()
  }

  func view() throws -> [String: Any] {
    let status = try statusObject(current().publicStatus())
    var result: [String: Any] = [
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
    if let parent = batch {
      result["operationId"] = parent.operationId
      result["phase"] =
        parent.terminal
        ?? (parent.paused
          ? "PAUSED"
          : (!parent.reviewed
            ? "REVIEW"
            : (parent.downstreamState == nil
              ? "FUNDING" : (status["phase"] as? String ?? "PLANNING"))))
      result["fundingContractVersion"] = 2
      result["budgetAtoms"] = parent.budgetAtoms
      result["fundedAtoms"] = parent.fundedAtoms ?? "0"
      result["confirmedFundingSources"] = parent.sources.filter { $0.creditedAtoms != nil }.count
      result["fundingSourceCount"] = parent.sources.count
    }
    return result
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
    if var parent = batch {
      let identity = try storage.load()
      defer { identity.close() }
      try require(
        identity.verified && identity.id == saved.walletId
          && identity.journalId == parent.generation)
      if let index = parent.sources.firstIndex(where: { $0.operationId == op.operationId() }) {
        parent.sources[index].state = state
      } else {
        parent.downstreamState = state
      }
      batch = parent
      try saved.saveBatch(parent, state: state, fundingAddress: fundingAddress)
      if let index = parent.sources.firstIndex(where: { $0.operationId == op.operationId() }),
        parent.sources[index].creditedAtoms == nil
      {
        let data = try EarnValues.object(swapObject(state)["data"] as Any)
        if data["signedOperation"] != nil && !(data["signedOperation"] is NSNull) {
          let record = try storage.load()
          defer { record.close() }
          let source = parent.sources[index]
          try FundingReservations(store: storage, record: record).adoptSigned(
            parentId: parent.operationId, sourceId: source.sourceId, chainId: source.sourceChainId,
            token: source.token, owner: source.address, budgetAtoms: source.budgetAtoms,
            operationId: op.operationId())
        }
      }
      if parent.downstreamState != nil {
        try saved.portfolio.remember(state: state, status: op.publicStatus())
      }
    } else {
      try saved.save(operationId: op.operationId(), state: state, fundingAddress: fundingAddress)
      try saved.portfolio.remember(state: state, status: op.publicStatus())
    }
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
