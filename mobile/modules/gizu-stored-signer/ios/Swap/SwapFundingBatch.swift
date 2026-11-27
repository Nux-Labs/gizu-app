import Foundation

internal struct SwapFundingChild: Codable {
  var sourceId: String
  var sourceChainId: Int
  var token: String
  var sourceIndex: UInt32
  var address: String
  var budgetAtoms: String
  var balanceAtoms: String
  var state: String?
  var operationId: String?
  var creditedAtoms: String?
  var originObservationInvalidated: Bool?
}

/// Provenance in the existing encrypted Swap journal; each child is an existing Rust operation.
internal struct SwapFundingBatch: Codable {
  var version = 2
  var operationId: String
  var generation: String
  var target: String
  var chainId: UInt64
  var budgetAtoms: String
  var approvedExistingPrivateAtoms: String
  var recipientIndices: [UInt32]
  var weights: [UInt32]
  var sources: [SwapFundingChild]
  var reviewed = false
  var cancelRequested = false
  var paused = false
  var terminal: String?
  var downstreamState: String?
  var fundedAtoms: String?

  var activeSource: Int? { sources.firstIndex { $0.creditedAtoms == nil } }
  func validate(walletId: String, generation: String) throws {
    try require(
      version == 2 && self.generation == generation && !operationId.isEmpty
        && operationId.count <= 128)
    try require(
      SwapChain(rawValue: chainId) != nil && UInt64(budgetAtoms) != nil && budgetAtoms != "0")
    _ = try FundingAtoms.validate(approvedExistingPrivateAtoms)
    try require(!FundingAtoms.less(budgetAtoms, approvedExistingPrivateAtoms))
    try require(
      (1...5).contains(recipientIndices.count) && weights.count == recipientIndices.count
        && weights.reduce(UInt64(0)) { $0 + UInt64($1) } == 10_000)
    try require(
      Set(recipientIndices).count == recipientIndices.count
        && recipientIndices.allSatisfy { $0 >= 3 } && sources.count <= 128)
    var ids = Set<String>()
    var operations = Set<String>()
    var incomplete = false
    var gross = approvedExistingPrivateAtoms
    for source in sources {
      try require(
        ids.insert(source.sourceId).inserted && source.token == fundingUsdc(source.sourceChainId))
      try require(source.sourceChainId == 143 || source.sourceIndex == 1)
      gross = try FundingAtoms.add(gross, source.budgetAtoms)
      if let state = source.state {
        let root = try swapObject(state)
        let plan = try EarnValues.object(root["plan"] as Any)
        try require(
          plan["kind"] as? String == "confidentialFunding"
            && plan["sourceChainId"] as? Int == source.sourceChainId
            && plan["amountAtoms"] as? String == source.budgetAtoms)
        try require(root["id"] as? String == source.operationId)
        try require(
          (root["source"] as? String)?.lowercased() == source.address.lowercased()
            && plan["sourceIndex"] as? UInt32 == source.sourceIndex)
        try require(
          plan["chainId"] as? UInt64 == chainId
            && (plan["target"] as? String)?.lowercased() == target.lowercased())
        if let credit = source.creditedAtoms {
          let data = try EarnValues.object(root["data"] as Any)
          try require(
            data["creditBasis"] as? String == "authenticated_balance_delta"
              && data["fundingRouteConfirmed"] as? Bool == true && data["privateBaseline"] != nil
              && !(data["privateBaseline"] is NSNull) && data["signedOperation"] != nil
              && !(data["signedOperation"] is NSNull))
          let restored = try SwapOperation.restore(state: state, gateway: "https://api.gizu.io")
          let status = try swapObject(restored.publicStatus())
          try require(
            status["phase"] as? String == "COMPLETE" && status["creditedAtoms"] as? String == credit
          )
        }
      }
      if let credit = source.creditedAtoms {
        try require(!incomplete && credit != "0" && source.state != nil)
        _ = try FundingAtoms.validate(credit)
        try require(!FundingAtoms.less(source.budgetAtoms, credit))
        try require(
          operations.insert(source.operationId ?? "").inserted && source.operationId != nil)
      } else {
        incomplete = true
      }
    }
    try require(gross == budgetAtoms)
    if let downstreamState {
      try require(!incomplete && fundedAtoms == combinedAmount())
      let plan = try EarnValues.object(swapObject(downstreamState)["plan"] as Any)
      try require(
        plan["kind"] as? String == "confidentialPayout"
          && plan["amountAtoms"] as? String == fundedAtoms
          && plan["recipientIndices"] as? [UInt32] == recipientIndices
          && plan["weights"] as? [UInt32] == weights && plan["chainId"] as? UInt64 == chainId
          && (plan["target"] as? String)?.lowercased() == target.lowercased())
    }
    if let terminal { try require(["COMPLETE", "CANCELLED"].contains(terminal)) }
  }
  func combinedAmount() throws -> String {
    try require(sources.allSatisfy { $0.creditedAtoms != nil })
    let credits = try sources.map { source -> [String: String] in
      guard let operation = source.operationId, let credit = source.creditedAtoms else {
        throw WalletFailure.invalid
      }
      return ["sourceId": source.sourceId, "operationId": operation, "creditedAtoms": credit]
    }
    return try fundedPrivateAmount(
      approvedExistingPrivateAtoms: approvedExistingPrivateAtoms,
      creditsJson: String(decoding: JSONSerialization.data(withJSONObject: credits), as: UTF8.self))
  }
  func review() -> String {
    let rows = sources.map {
      "Network \($0.sourceChainId), account \($0.sourceIndex): gross \($0.budgetAtoms) USDC atoms including source gas."
    }.joined(separator: "\n")
    return
      "SWAP FUNDING\nOriginal total budget \(budgetAtoms) USDC atoms including fees.\nApproved existing private USDC \(approvedExistingPrivateAtoms) atoms.\n\(rows)\nConfirm each funding quote, then one private-funded Swap on chain \(chainId).\nSaved recipients \(recipientIndices.map(String.init).joined(separator: ", ")); weights \(weights.map(String.init).joined(separator: ", ")) bps.\nOnly approved private funds and confirmed source credits fund this Swap. Partial funding stays private and can be resumed."
  }
}

internal struct SwapFundingServices {
  var sources: (WalletStorage) async throws -> [[String: Any]]
  var privateBalance: (WalletRecord) async throws -> [String: Any]
  var fee: (Int, String, String, String) async throws -> String

  static func enabledChains(status: UInt16, body: String) throws -> [Int] {
    if status == 404 { return [143] }
    try require(status == 200)
    let row = try swapObject(body)
    try require(try EarnValues.exactInteger(row["fundingContractVersion"] as Any) == 2)
    guard let raw = row["fundingChainIds"] as? [Any], !raw.isEmpty, raw.count <= 3 else {
      throw WalletFailure.invalid
    }
    let chains = try raw.map { Int(try EarnValues.exactInteger($0)) }
    try require(
      Set(chains).count == chains.count && chains.allSatisfy { [143, 8453, 42161].contains($0) })
    return chains
  }

  @MainActor static func readPrivateBalance(
    _ record: WalletRecord, authority: () throws -> Void = {}
  ) async throws -> [String: Any] {
    try Task.checkCancellation()
    try authority()
    let api = ConfidentialBalance()
    let salt = try await api.salt()
    try Task.checkCancellation()
    try authority()
    let started = UInt64(Date().timeIntervalSince1970 * 1000)
    let proof = try authenticateSwapRead(
      entropy: record.entropy, salt: salt, random: randomBytes(7),
      startedMs: started, nowMs: started)
    let address = try deriveAccountAddressRange(entropy: record.entropy, start: 2, count: 1)[0]
    let result = try await api.read(proof, address: address)
    try Task.checkCancellation()
    try authority()
    return result
  }

  static func native(
    gateway: String,
    transport: @escaping (String, String, String?) async -> (UInt16, String) = StoredSwapHTTP
      .execute
  ) -> Self {
    Self(
      sources: { storage in
        let capability = await transport(
          "GET", gateway + "/v1/funding/capabilities", nil)
        let enabled = try enabledChains(status: capability.0, body: capability.1)
        let record = try storage.load()
        defer { record.close() }
        let ledger = FundingReservations(store: storage, record: record)
        let snapshot = try await MainnetPortfolio(
          rpc: NativeMainnetPortfolioRPC(),
          reservedAtoms: { chain, owner in try? ledger.reservedAtoms(chainId: chain, owner: owner) }
        ).read(store: storage, forceRefresh: true)
        guard let rows = snapshot["fundingSources"] as? [[String: Any]] else {
          throw WalletFailure.invalid
        }
        return rows.filter {
          enabled.contains($0["sourceChainId"] as? Int ?? 0) && $0["complete"] as? Bool == true
            && $0["stale"] as? Bool == false
        }
      },
      privateBalance: { record in try await readPrivateBalance(record) },
      fee: { chain, owner, recipient, budget in
        let payload: [String: Any] = [
          "owner": owner, "recipient": recipient, "amount": "1", "budget": budget,
        ]
        let response = await transport(
          "POST",
          gateway + (chain == 143 ? "/v1/earn/monad/funding-plan" : "/v1/funding/\(chain)/plan"),
          String(decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self))
        try require(response.0 == 200)
        let row = try swapObject(response.1)
        try require(
          (chain == 143 && row["sourceChainId"] == nil || row["sourceChainId"] as? Int == chain)
            && row["chainId"] as? Int == chain
            && (row["owner"] as? String)?.lowercased() == owner.lowercased()
            && (row["token"] as? String)?.lowercased() == fundingUsdc(chain))
        guard let fee = row["feeCap"] as? String else { throw WalletFailure.invalid }
        return try FundingAtoms.validate(fee)
      })
  }
}
