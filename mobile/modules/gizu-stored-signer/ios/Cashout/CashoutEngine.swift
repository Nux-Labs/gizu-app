import Foundation

internal final class CashoutEngine {
  let journal: CashoutJournal
  private let store: WalletStorage
  private let gateway: CashoutGateway
  private let read: (CashoutSource) async throws -> [String: Any]
  private let authority: () throws -> Void
  private let catalogue: (WalletRecord) throws -> [CashoutSource]
  private let assertCanStart: (WalletRecord) throws -> Void

  init(
    store: WalletStorage, journal: CashoutJournal, gateway: CashoutGateway,
    read: @escaping (CashoutSource) async throws -> [String: Any],
    authority: @escaping () throws -> Void,
    catalogue: @escaping (WalletRecord) throws -> [CashoutSource],
    assertCanStart: @escaping (WalletRecord) throws -> Void
  ) {
    self.store = store
    self.journal = journal
    self.gateway = gateway
    self.read = read
    self.authority = authority
    self.catalogue = catalogue
    self.assertCanStart = assertCanStart
  }
  private func wallet<T>(_ action: (WalletRecord) throws -> T) throws -> T {
    try authority()
    try Task.checkCancellation()
    let record = try store.load()
    defer { record.close() }
    try require(
      record.verified && record.id == journal.walletId && record.journalId == journal.generation)
    return try action(record)
  }
  private func recipients(_ row: CashoutRecord) throws -> [String] {
    try wallet { record in
      try row.plan.proposal.recipientIndices.map {
        let addresses = try deriveAccountAddressRange(entropy: record.entropy, start: $0, count: 1)
        try require(addresses.count == 1)
        return addresses[0]
      }
    }
  }
  private func group(_ row: CashoutRecord) throws -> [String: Any] {
    ["plan": try CashoutJSON.object(EarnValues.json(row.plan)), "recipients": try recipients(row)]
  }
  func prepare(amount: String) async throws -> [String: Any] {
    guard let value = UInt64(amount), value > 0, String(value) == amount else {
      throw WalletFailure.invalid
    }
    var row: CashoutRecord
    if let active = try journal.active() {
      try require(active.plan.proposal.amountAtoms == amount)
      if active.children.contains(where: { $0.signedData != nil || $0.signingPending }) {
        return try active.publicValue()
      }
      row = active
    } else {
      let targets = try wallet { record -> [CashoutSource] in
        try assertCanStart(record)
        return try catalogue(record)
      }
      var remaining = value
      var sources: [CashoutSource] = []
      for var source in targets {
        if remaining == 0 { break }
        try authority()
        let balance = try await read(source)
        let available = try CashoutJSON.string(balance, "available")
        let debit =
          try EarnValues.atLeast(available, String(remaining)) ? remaining : UInt64(available)
        guard let debit else { throw WalletFailure.invalid }
        if debit > 0 {
          try require(sources.count < 32)
          source.amountAtoms = String(debit)
          sources.append(source)
          remaining -= debit
        }
      }
      try require(remaining == 0)
      var random = try randomBytes()
      defer { random.wipe() }
      let choice = try chooseBuyLegs(budgetAtoms: amount, random: random)
      let plan: CashoutPlan = try wallet { record in
        try assertCanStart(record)
        let allocation = try allocateSwapRecipientsN(
          registry: record.roleRegistry, count: choice.count)
        let registry = try CashoutJSON.object(allocation.registry)
        try require(try CashoutJSON.uint(registry, "nextRecipient") <= 8192)
        // Reserve receivers before saving the operation, including on persistence failure.
        try store.persistRegistry(allocation.registry, expectedId: record.id)
        let proposal = CashoutProposal(
          operationId: "cashout_" + UUID().uuidString.replacingOccurrences(of: "-", with: ""),
          amountAtoms: amount, sources: sources, recipientIndices: allocation.indices,
          weightsBps: choice.weights)
        return try JSONDecoder().decode(
          CashoutPlan.self,
          from: Data(confidentialWithdrawalPlan(proposal: EarnValues.json(proposal)).utf8))
      }
      row = try journal.create(plan)
    }
    return try await refresh(row).publicValue()
  }
  private func signer(_ row: CashoutRecord, _ index: Int) throws -> ConfidentialWithdrawalOperation
  {
    try wallet { record in
      try ConfidentialWithdrawalOperation(
        planJson: EarnValues.json(row.plan), childIndex: UInt32(index),
        entropy: record.entropy, registry: record.roleRegistry)
    }
  }
  private func prepareSigner(_ core: ConfidentialWithdrawalOperation, _ child: CashoutChild) throws
    -> String
  {
    guard let prepared = child.preparedText, let balance = child.balanceProof else {
      throw WalletFailure.invalid
    }
    return try core.prepare(
      preparedJson: prepared, balanceJson: balance, journalEvidence: child.evidence())
  }
  private func refresh(_ initial: CashoutRecord) async throws -> CashoutRecord {
    var row = initial
    let delivery = try group(row)
    var balances: [Int: String] = [:]
    for (i, source) in row.plan.proposal.sources.enumerated() {
      let unsigned = row.children.filter { $0.plan.source == i && $0.signedData == nil }
      if unsigned.isEmpty { continue }
      try require(unsigned.allSatisfy { !$0.signingPending })
      try authority()
      let balance = try await read(source)
      try require(
        try EarnValues.atLeast(
          CashoutJSON.string(balance, "available"),
          earnAmountSum(values: unsigned.map { $0.plan.amountAtoms })))
      balances[i] = try CashoutJSON.text(balance)
    }
    for i in row.children.indices {
      let child = row.children[i]
      if child.signedData != nil { continue }
      try authority()
      try Task.checkCancellation()
      if let text = child.preparedText, child.status == "review",
        child.minimumDestinationAtoms != "0",
        try CashoutJSON.uint(CashoutJSON.object(text), "expiresAtMs") > UInt64(
          Date().timeIntervalSince1970 * 1000) + 15000
      {
        row = try journal.update(row) { $0.children[i].balanceProof = balances[child.plan.source] }
        continue
      }
      var anchor: String?
      if let text = row.children.first(where: {
        $0.plan.slot == child.plan.slot && $0.preparedText != nil
      })?.preparedText {
        anchor = try CashoutJSON.string(CashoutJSON.object(text), "recoveryEnvelope")
      }
      let source = row.plan.proposal.sources[child.plan.source]
      let prepared = try await gateway.prepare(
        group: delivery, index: i, source: source, anchor: anchor)
      guard let rawIntent = prepared["intent"] else { throw WalletFailure.invalid }
      let payload = try CashoutJSON.string(EarnValues.object(rawIntent), "payload")
      let nonce = try CashoutJSON.string(CashoutJSON.object(payload), "nonce")
      try journal.assertFreshNonce(
        source: source.address, nonce: nonce, operationId: row.operationId, index: i)
      row = try journal.update(row) { next in
        next.children[i].preparedText = try CashoutJSON.text(prepared)
        next.children[i].balanceProof = balances[child.plan.source]
        next.children[i].nonce = nonce
        next.children[i].nonceHistory.append(nonce)
        next.children[i].payloadHash = try cashoutHash(payload)
        next.children[i].reservationId =
          "0x" + (try randomBytes()).map { String(format: "%02x", $0) }.joined()
        next.children[i].status = "needsReview"
        next.children[i].minimumDestinationAtoms = "0"
      }
      let core = try signer(row, i)
      defer { core.invalidate() }
      _ = try prepareSigner(core, row.children[i])
      row = try journal.update(row) {
        $0.children[i].status = "review"
        $0.children[i].minimumDestinationAtoms = try CashoutJSON.string(
          prepared, "minimumDestinationAtoms")
      }
    }
    return row
  }
  func execute(id: String, revision: UInt32, approve: (String, String) async throws -> Void)
    async throws -> [String: Any]
  {
    var row = try journal.get(id)
    try require(row.revision == revision && !row.cancelled)
    if row.terminal { return try row.publicValue() }
    if row.children.contains(where: { $0.signingPending && $0.signedData == nil }) {
      row = try journal.update(row) { next in
        for i in next.children.indices
        where next.children[i].signingPending && next.children[i].signedData == nil {
          next.children[i].signingPending = false
          next.children[i].status = "needsReview"
        }
      }
    }
    if row.children.contains(where: { $0.signedData != nil }) { row = try await reconcile(row) }
    if row.terminal { return try row.publicValue() }
    if row.children.contains(where: { $0.signedData == nil }) { row = try await refresh(row) }
    var cores: [Int: ConfidentialWithdrawalOperation] = [:]
    defer { for core in cores.values { core.invalidate() } }
    var texts: [String] = []
    var hashes: [String] = []
    for (i, child) in row.children.enumerated()
    where child.status != "paid" && !child.routeSucceeded {
      if child.signedData != nil {
        guard let hash = child.payloadHash else { throw WalletFailure.invalid }
        texts.append(
          "Retry saved child \(i + 1): \(child.plan.amountAtoms) input atoms. Only the original signed bytes will be submitted."
        )
        hashes.append(hash)
      } else {
        let core = try signer(row, i)
        cores[i] = core
        texts.append(try prepareSigner(core, child))
        hashes.append(try core.reviewHash())
      }
    }
    if texts.isEmpty { return try row.publicValue() }
    let minimum = try earnAmountSum(values: row.children.map(\.minimumDestinationAtoms))
    let deduction = try cashoutSubtract(row.plan.proposal.amountAtoms, minimum)
    let review =
      "WITHDRAW FROM GIZU\nExact private input: \(cashoutUSDC(row.plan.proposal.amountAtoms)) USDC, including route fees.\nGuaranteed net output: at least \(cashoutUSDC(minimum)) USDC.\nMaximum fees/route deduction: \(cashoutUSDC(deduction)) USDC.\n\(row.plan.proposal.recipientIndices.count) fresh receiving wallets; \(row.plan.proposal.sources.count) private sources.\n\n"
      + texts.joined(separator: "\n\n")
    try await approve(
      review, cashoutHash(EarnValues.json(row.plan) + hashes.joined(separator: "|")))
    for i in row.children.indices {
      let child = row.children[i]
      if child.status == "paid" || child.routeSucceeded { continue }
      try wallet { _ in () }
      if child.signedData == nil {
        guard let core = cores[i] else { throw WalletFailure.invalid }
        try core.approve(reviewHash: core.reviewHash())
        let balance = try await read(row.plan.proposal.sources[child.plan.source])
        let remaining = try earnAmountSum(
          values: row.children.filter {
            $0.plan.source == child.plan.source && $0.signedData == nil
          }.map { $0.plan.amountAtoms })
        try require(try EarnValues.atLeast(CashoutJSON.string(balance, "available"), remaining))
        try authority()
        try wallet { _ in () }
        row = try journal.update(row) { $0.children[i].signingPending = true }
        let signed = try core.sign(journalEvidence: child.evidence())
        // Never suspend between signing and persisting. Submission is strictly after this write.
        row = try journal.update(row) {
          $0.children[i].signedData = signed
          $0.children[i].signingPending = false
          $0.children[i].status = "unknown"
        }
      }
      try authority()
      try Task.checkCancellation()
      guard let signed = row.children[i].signedData else { throw WalletFailure.invalid }
      do {
        let response = try await gateway.submit(signed)
        row = try journal.update(row) {
          if let hash = response["intentHash"] as? String { $0.children[i].intentHash = hash }
          $0.children[i].status = "pending"
        }
      } catch {
        try authority()
        try Task.checkCancellation()
        return try row.publicValue()
      }
    }
    return try await reconcile(row).publicValue()
  }
  private func reconcile(_ row: CashoutRecord) async throws -> CashoutRecord {
    let receivers = try recipients(row)
    let requested = UInt64(Date().timeIntervalSince1970 * 1000)
    let result = try await gateway.status(row, recipients: receivers)
    try authority()
    try require(
      result["authenticated"] as? Bool == true && result["operationScoped"] as? Bool == true
        && result["operationId"] as? String == row.operationId
        && result["verification"] as? String == "destination-receipt-group-v1")
    try require(
      try result["groupId"] as? String
        == cashoutGroupIdentity(plan: row.plan, recipients: receivers))
    let received = try CashoutJSON.uint(result, "nativeReceivedAtMs")
    let observed = try CashoutJSON.uint(result, "observedAtMs")
    try require(
      received >= requested && received <= UInt64(Date().timeIntervalSince1970 * 1000)
        && Double(received) - Double(observed) >= -5000
        && Double(received) - Double(observed) <= 60000)
    guard let routes = result["routes"] as? [[String: Any]] else { throw WalletFailure.invalid }
    let indices = try routes.map { try CashoutJSON.uint($0, "index") }
    let expected = row.children.indices.filter { row.children[$0].signedData != nil }.map(
      UInt64.init)
    try require(Set(indices).count == indices.count && Set(indices) == Set(expected))
    for route in routes {
      try require(
        ["SUCCESS", "KNOWN_DEPOSIT_TX", "PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "PROCESSING"]
          .contains(try CashoutJSON.string(route, "status")))
    }
    let paid = result["status"] as? String == "paid"
    var allocations: [Int: String] = [:]
    if paid {
      try require(
        row.children.allSatisfy { $0.signedData != nil }
          && routes.allSatisfy { $0["status"] as? String == "SUCCESS" })
      guard let slots = result["slots"] as? [[String: Any]], slots.count == receivers.count else {
        throw WalletFailure.invalid
      }
      var events = Set<String>()
      for slot in receivers.indices {
        let proof = slots[slot]
        try require(
          try CashoutJSON.uint(proof, "slot") == UInt64(slot)
            && CashoutJSON.string(proof, "destinationRecipient").lowercased()
              == receivers[slot].lowercased()
        )
        let selected = row.children.indices.filter { row.children[$0].plan.slot == slot }
        let minimum = try earnAmountSum(
          values: selected.map { row.children[$0].minimumDestinationAtoms })
        try require(proof["minimumDestinationAtoms"] as? String == minimum)
        guard let receipts = proof["receipts"] as? [[String: Any]], !receipts.isEmpty else {
          throw WalletFailure.invalid
        }
        for receipt in receipts {
          let hash = try EarnValues.hash(CashoutJSON.string(receipt, "transactionHash"))
          let index = try CashoutJSON.uint(receipt, "logIndex")
          try require(events.insert("\(hash):\(index)").inserted)
        }
        let total = try CashoutJSON.string(proof, "receivedAtoms")
        try require(
          try total
            == earnAmountSum(values: receipts.map { try CashoutJSON.string($0, "receivedAtoms") }))
        var surplus = try cashoutSubtract(total, minimum)
        for index in selected {
          allocations[index] = row.children[index].minimumDestinationAtoms
          if index == selected.last {
            allocations[index] = try earnAmountSum(values: [
              row.children[index].minimumDestinationAtoms, surplus,
            ])
            surplus = "0"
          }
        }
      }
    } else {
      try require(["pending", "awaitingReceipt"].contains(result["status"] as? String ?? ""))
    }
    return try journal.update(row) { next in
      if let scans = result["groupScan"] {
        next.groupScan = try JSONDecoder().decode(
          [CashoutScan].self, from: JSONSerialization.data(withJSONObject: scans))
      }
      for (offset, route) in routes.enumerated() {
        let index = Int(indices[offset])
        if next.children[index].status == "paid" { continue }
        next.children[index].routeSucceeded = route["status"] as? String == "SUCCESS"
        if next.children[index].routeSucceeded || next.children[index].status != "unknown" {
          next.children[index].status = "pending"
        }
      }
      if paid {
        next.groupReceipt = try CashoutJSON.text(result)
        for (index, amount) in allocations {
          next.children[index].status = "paid"
          next.children[index].receivedAtoms = amount
        }
      }
    }
  }
}

internal func cashoutHash(_ text: String) throws -> String {
  try earnContractCodeHash(code: "0x" + Data(text.utf8).map { String(format: "%02x", $0) }.joined())
}

internal func cashoutUSDC(_ atoms: String) -> String {
  let padded = String(repeating: "0", count: max(0, 7 - atoms.count)) + atoms
  return String(padded.dropLast(6)) + "." + padded.suffix(6)
}

internal func cashoutSubtract(_ a: String, _ b: String) throws -> String {
  try require(try EarnValues.atLeast(a, b))
  let left = Array(a.utf8.reversed())
  let right = Array(b.utf8.reversed())
  var digits: [UInt8] = []
  var borrow = 0
  for i in left.indices {
    var value = Int(left[i]) - 48 - borrow - (i < right.count ? Int(right[i]) - 48 : 0)
    borrow = value < 0 ? 1 : 0
    if value < 0 { value += 10 }
    digits.append(UInt8(value + 48))
  }
  while digits.count > 1 && digits.last == 48 { digits.removeLast() }
  return String(decoding: digits.reversed(), as: UTF8.self)
}
