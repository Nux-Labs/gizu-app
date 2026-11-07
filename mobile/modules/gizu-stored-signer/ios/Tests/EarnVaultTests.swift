import XCTest

@testable import GizuStoredSignerNative

private final class VaultRPC: StoredTransferRPC {
  var sent: [String] = []
  var nonce = "0x4"
  var receipt: Any = NSNull()
  var transaction: Any = NSNull()
  var canonicalHash = "0x" + String(repeating: "11", count: 32)
  var canonicalBlocks: [String: [String: String]] = [:]
  var beforeSend: (() throws -> Void)?
  func text(_ method: String, _ params: [Any]) async throws -> String {
    switch method {
    case "eth_chainId": return "0x1"
    case "eth_getTransactionCount": return nonce
    case "eth_sendRawTransaction":
      try beforeSend?()
      sent.append(params[0] as! String)
      throw WalletFailure.unavailable
    default: throw WalletFailure.invalid
    }
  }
  func call(_ method: String, _ params: [Any]) async throws -> Any {
    switch method {
    case "eth_getTransactionReceipt": return receipt
    case "eth_getTransactionByHash": return transaction
    case "eth_getBlockByNumber":
      if let number = params[0] as? String, let block = canonicalBlocks[number] { return block }
      return ["number": "0x64", "hash": canonicalHash]
    default: throw WalletFailure.invalid
    }
  }
}

private final class VaultFailingFiles: WalletFiles {
  let base: WalletFiles
  var failure: Bool?
  init(_ base: WalletFiles) { self.base = base }
  func url(_ name: String) throws -> URL { try base.url(name) }
  func exists(_ name: String) throws -> Bool { try base.exists(name) }
  func read(_ name: String, limit: Int) throws -> Data { try base.read(name, limit: limit) }
  func write(_ name: String, bytes: Data) throws {
    if failure == false { throw WalletFailure.unavailable }
    try base.write(name, bytes: bytes)
    if failure == true { throw WalletFailure.unavailable }
  }
}

final class EarnVaultTests: WalletTestCase {
  private let owner = "0xB5927c0bbE474886EA8A87a2E9a761386Dec63bc"
  private func request() -> [String: Any] {
    [
      "walletId": id, "kind": "vaultDeposit", "operationId": "ios-deposit", "revision": 1,
      "chainId": 1, "expectedFrom": owner, "vault": EarnValues.vault, "token": EarnValues.usdc,
      "router": EarnValues.router, "amountAtoms": "1000000",
      "deadline": Int(Date().timeIntervalSince1970) + 300,
      "slippageBps": 10, "nonce": 4, "gasLimits": [65000, 300000], "maxFeePerGasWei": "10000000000",
      "priorityFeePerGasWei": "1000000000", "maximumGasCostWei": "3650000000000000",
      "withdrawalReserveWei": "1000000000000000",
    ]
  }
  private func state() -> EarnExecutionState {
    EarnExecutionState(
      chainId: 1, owner: owner, nonce: 4, observedAt: UInt64(Date().timeIntervalSince1970),
      blockNumber: 100, blockHash: "0x" + String(repeating: "11", count: 32),
      parentHash: "0x" + String(repeating: "22", count: 32),
      nativeBalanceWei: "1000000000000000000", baseFeeWei: "1000000000",
      usdcBalanceAtoms: "1000000",
      shares: "2000000", allowanceAtoms: "0", previewDepositShares: "1000000",
      maxRedeemShares: "2000000",
      vaultAsset: EarnValues.usdc, tokenDecimals: 6, senderCode: "0x",
      tokenCodeHash: "0x" + String(repeating: "33", count: 32),
      vaultCodeHash: "0x" + String(repeating: "44", count: 32),
      routerCodeHash: "0x" + String(repeating: "55", count: 32))
  }
  private func setup() throws -> (WalletStorage, EarnVaultJournal) {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    try store.bindEarnChain(wallet, chain: 1)
    let bound = try store.load()
    defer { bound.close() }
    return (store, EarnVaultJournal(store: store, record: bound))
  }
  func testProposalRejectsUnknownFieldsWrongOwnerAndNonIntegers() throws {
    for (field, value) in [
      ("nonce", 4.5 as Any), ("revision", true), ("walletId", "other"),
      ("expectedFrom", EarnValues.router), ("chainId", 143), ("unexpected", "yes"),
    ] {
      var input = request()
      input[field] = value
      XCTAssertThrowsError(try EarnVaultProposal.parse(input, walletId: id, owner: owner), field)
    }
    XCTAssertEqual(try EarnVaultProposal.parse(request(), walletId: id, owner: owner).cycleIndex, 0)
  }
  func testLongReviewRechecksCanonicalAnchorAndSignsOriginalReviewedTransaction() async throws {
    let (store, journal) = try setup()
    let rpc = VaultRPC()
    let nextHash = "0x" + String(repeating: "66", count: 32)
    rpc.canonicalBlocks["0x67"] = ["number": "0x67", "hash": nextHash]
    var reads = 0
    let engine = EarnVaultEngine(
      store: store, journal: journal, rpc: rpc,
      state: { _, _, _ in
        var current = self.state()
        if reads > 0 {
          current.blockNumber = 103
          current.blockHash = nextHash
        }
        reads += 1
        return current
      })
    let op = try await engine.create(request())
    let review = try await engine.prepare(op.operationId, revision: op.revision)
    do {
      try await engine.execute(review, authority: {})
      XCTFail("The test transport loses the broadcast response")
    } catch {}
    XCTAssertEqual(rpc.sent.count, 1)
    let saved = try journal.get(op.operationId)
    let signed = saved.steps[0]
    XCTAssertEqual(saved.reviewHash, review.hash)
    XCTAssertEqual(signed.nonce, "4")
    XCTAssertEqual(signed.gasLimit, "65000")
    XCTAssertEqual(signed.maxFeePerGasWei, "10000000000")
  }
  func testJournalLocksSenderRejectsDuplicatesAndStaleWrites() throws {
    let (_, journal) = try setup()
    let proposal = try EarnVaultProposal.parse(request(), walletId: id, owner: owner)
    let op = try journal.create(proposal)
    XCTAssertThrowsError(try journal.create(proposal))
    var next = request()
    next["operationId"] = "second"
    let nextProposal = try EarnVaultProposal.parse(next, walletId: id, owner: owner)
    XCTAssertThrowsError(try journal.create(nextProposal))
    _ = try journal.update(op.operationId, revision: op.revision) { $0.cancelled = true }
    XCTAssertThrowsError(
      try journal.update(op.operationId, revision: op.revision) { $0.cancelled = false })
    XCTAssertFalse(try journal.get(op.operationId).blocked)
    XCTAssertEqual(try journal.create(nextProposal).operationId, "second")
  }
  func testUncertainBroadcastSurvivesRestartAndRetriesExactBytesOnlyAfterApproval() async throws {
    let (store, journal) = try setup()
    let rpc = VaultRPC()
    let engine = EarnVaultEngine(
      store: store, journal: journal, rpc: rpc, state: { _, _, _ in self.state() })
    let op = try await engine.create(request())
    let review = try await engine.prepare(op.operationId, revision: op.revision)
    rpc.beforeSend = {
      XCTAssertEqual(try journal.get(op.operationId).steps[0].status, "unknown")
      XCTAssertNotNil(try journal.get(op.operationId).steps[0].raw)
    }
    do {
      try await engine.execute(review, authority: {})
      XCTFail("Expected lost response")
    } catch {}
    engine.close()
    XCTAssertEqual(rpc.sent.count, 1)
    XCTAssertEqual(try journal.get(op.operationId).steps[1].status, "planned")
    let wallet = try store.load()
    defer { wallet.close() }
    let restarted = EarnVaultJournal(store: store, record: wallet)
    try await reconcileEarnVault(restarted, rpc: rpc)
    XCTAssertEqual(rpc.sent.count, 1, "Status must never rebroadcast")
    let pending = try restarted.get(op.operationId)
    XCTAssertTrue(pending.blocked)
    XCTAssertTrue(pending.canResume)
    let resumedEngine = EarnVaultEngine(
      store: store, journal: restarted, rpc: rpc, state: { _, _, _ in self.state() })
    let review2 = try await resumedEngine.prepare(op.operationId, revision: pending.revision)
    XCTAssertTrue(review2.retry)
    do {
      try await resumedEngine.execute(review2, authority: { throw WalletFailure.cancelled })
      XCTFail()
    } catch {}
    XCTAssertEqual(rpc.sent.count, 1)
    do {
      try await resumedEngine.execute(review2, authority: {})
      XCTFail()
    } catch {}
    XCTAssertEqual(rpc.sent, [rpc.sent[0], rpc.sent[0]])
    let publicJSON = try JSONSerialization.data(
      withJSONObject: restarted.get(op.operationId).publicValue)
    XCTAssertFalse(String(decoding: publicJSON, as: UTF8.self).contains(rpc.sent[0]))
    rpc.nonce = "0x5"
    try await reconcileEarnVault(restarted, rpc: rpc)
    let conflict = try restarted.get(op.operationId)
    XCTAssertTrue(conflict.blocked)
    XCTAssertFalse(conflict.canResume)
    XCTAssertTrue(conflict.steps[0].conflict)
    _ = try restarted.update(op.operationId, revision: conflict.revision) { $0.cancelled = true }
    XCTAssertTrue(
      try restarted.get(op.operationId).blocked, "Cancel must preserve unresolved nonce lock")
  }
  func testCancellationBeforeSigningAndChangedStateNeverBroadcast() async throws {
    let (store, journal) = try setup()
    let rpc = VaultRPC()
    var changed = false
    let engine = EarnVaultEngine(
      store: store, journal: journal, rpc: rpc,
      state: { _, _, _ in
        var state = self.state()
        if changed { state.routerCodeHash = state.tokenCodeHash }
        return state
      })
    let op = try await engine.create(request())
    let review = try await engine.prepare(op.operationId, revision: op.revision)
    do {
      try await engine.execute(review, authority: { throw WalletFailure.cancelled })
      XCTFail()
    } catch {}
    XCTAssertNil(try journal.get(op.operationId).steps[0].raw)
    changed = true
    do {
      try await engine.execute(review, authority: {})
      XCTFail()
    } catch {}
    XCTAssertTrue(rpc.sent.isEmpty)
    XCTAssertNil(try journal.get(op.operationId).steps[0].raw)
  }
  func testFinalizedApprovalRequiresFreshReviewForDepositAndReorgRelocks() async throws {
    let (store, journal) = try setup()
    let rpc = VaultRPC()
    var approved = false
    let engine = EarnVaultEngine(
      store: store, journal: journal, rpc: rpc,
      state: { _, _, _ in
        var state = self.state()
        if approved {
          state.nonce = 5
          state.allowanceAtoms = "1000000"
        }
        return state
      })
    let op = try await engine.create(request())
    let review = try await engine.prepare(op.operationId, revision: op.revision)
    do {
      try await engine.execute(review, authority: {})
      XCTFail()
    } catch {}
    let step = try journal.get(op.operationId).steps[0]
    let hash = try XCTUnwrap(step.transactionHash)
    rpc.transaction = [
      "hash": hash, "from": owner, "to": step.to, "input": step.data, "gas": "0xfde8",
      "maxFeePerGas": "0x2540be400", "maxPriorityFeePerGas": "0x3b9aca00", "nonce": "0x4",
      "value": "0x0",
    ]
    let topic = try earnContractCodeHash(
      code: "0x"
        + Data("Approval(address,address,uint256)".utf8).map { String(format: "%02x", $0) }.joined()
    )
    var receipt: [String: Any] = [
      "transactionHash": hash, "from": owner, "to": step.to, "status": "0x1",
      "blockNumber": "0x64", "blockHash": rpc.canonicalHash, "gasUsed": "0xc350",
      "effectiveGasPrice": "0x3b9aca00", "logs": [],
    ]
    rpc.receipt = receipt
    do {
      try await reconcileEarnVault(journal, rpc: rpc)
      XCTFail("Missing approval event")
    } catch {}
    XCTAssertTrue(try journal.get(op.operationId).blocked)
    receipt["logs"] = [
      [
        "address": EarnValues.usdc,
        "topics": [
          topic, "0x" + (try EarnValues.addressWord(owner)),
          "0x" + (try EarnValues.addressWord(EarnValues.router)),
        ], "data": "0x" + (try earnAmountWord(value: "1000000")),
      ]
    ]
    rpc.receipt = receipt
    try await reconcileEarnVault(journal, rpc: rpc)
    let ready = try journal.get(op.operationId)
    XCTAssertEqual(ready.steps[0].status, "finalized")
    XCTAssertEqual(ready.steps[0].actualFeeWei, "50000000000000")
    XCTAssertTrue(ready.canResume)
    approved = true
    let next = try await engine.prepare(op.operationId, revision: ready.revision)
    XCTAssertFalse(next.retry)
    XCTAssertEqual(next.index, 1)
    XCTAssertEqual(rpc.sent.count, 1, "Continuation cannot submit without new approval")
    rpc.receipt = NSNull()
    rpc.transaction = NSNull()
    try await reconcileEarnVault(journal, rpc: rpc)
    XCTAssertEqual(try journal.get(op.operationId).steps[0].status, "signed")
    XCTAssertTrue(try journal.get(op.operationId).blocked)
  }
  func testExpiredPlanCanContinueOnlyAfterFinalizedApprovalWithFreshReview() throws {
    for kind in ["vaultDeposit", "vaultRedeemAll"] {
      var input = request()
      input["kind"] = kind
      if kind == "vaultRedeemAll" {
        input["amountAtoms"] = "2000000"
        input["slippageBps"] = 0
      }
      var proposal = try EarnVaultProposal.parse(input, walletId: id, owner: owner)
      let core = try EarnExecutionOperation(
        proposal: EarnValues.json(proposal), entropy: Data(repeating: 0, count: 32))
      defer { core.invalidate() }
      _ = try core.prepare(revision: proposal.revision, current: state())
      let calls = try core.preparedCalls()
      // Model the persisted plan after a finality delay longer than its original lifetime.
      proposal.deadline = UInt64(Date().timeIntervalSince1970) - 900
      var op = EarnVaultRecord(operationId: proposal.operationId, walletId: id, proposal: proposal)
      op.steps = calls.enumerated().map { EarnVaultStep($0.element, index: $0.offset) }
      op.steps[0].raw = "saved-approval"
      op.steps[0].status = "pending"
      XCTAssertThrowsError(try earnContinuationProposal(op, freshNonce: 5))
      op.steps[0].status = "finalized"
      let continuation = try earnContinuationProposal(op, freshNonce: 5)
      XCTAssertGreaterThan(continuation.deadline, UInt64(Date().timeIntervalSince1970))
      XCTAssertEqual(op.proposal.deadline, proposal.deadline)
      XCTAssertEqual(op.steps[0].raw, "saved-approval")
      XCTAssertEqual(continuation.operationId, proposal.operationId)
      XCTAssertEqual(continuation.amountAtoms, proposal.amountAtoms)
      XCTAssertThrowsError(try earnContinuationProposal(op, freshNonce: 6))
      let next = try EarnExecutionOperation(
        proposal: EarnValues.json(continuation), entropy: Data(repeating: 0, count: 32))
      defer { next.invalidate() }
      var current = state()
      current.nonce = 5
      current.allowanceAtoms = proposal.amountAtoms
      _ = try next.prepare(revision: continuation.revision, current: current)
      XCTAssertEqual(try next.preparedCalls().count, 1)
      XCTAssertThrowsError(
        try next.signNext(revision: continuation.revision, current: current),
        "Fresh approval is mandatory")
      try next.approve(revision: continuation.revision, reviewHash: next.reviewHash())
      _ = try next.signNext(revision: continuation.revision, current: current)
      op.steps[1].raw = "saved-router"
      op.steps[1].status = "signed"
      XCTAssertThrowsError(
        try earnContinuationProposal(op, freshNonce: 5), "Never refresh a signed router call")
    }
  }

  func testDepositAndRedemptionRequireExactSettlementEvents() throws {
    func log(_ address: String, _ signature: String, _ parties: [String], _ amounts: [String])
      throws -> [String: Any]
    {
      let topic = try earnContractCodeHash(
        code: "0x" + Data(signature.utf8).map { String(format: "%02x", $0) }.joined())
      return [
        "address": address,
        "topics": try [topic] + parties.map { "0x" + (try EarnValues.addressWord($0)) },
        "data": "0x" + (try amounts.map { try earnAmountWord(value: $0) }).joined(),
      ]
    }
    for kind in ["vaultDeposit", "vaultRedeemAll"] {
      var input = request()
      input["kind"] = kind
      if kind == "vaultRedeemAll" {
        input["amountAtoms"] = "2000000"
        input["slippageBps"] = 0
      }
      let proposal = try EarnVaultProposal.parse(input, walletId: id, owner: owner)
      let core = try EarnExecutionOperation(
        proposal: EarnValues.json(proposal), entropy: Data(repeating: 0, count: 32))
      defer { core.invalidate() }
      _ = try core.prepare(revision: 1, current: state())
      var step = EarnVaultStep(try core.preparedCalls()[1], index: 1)
      let op = EarnVaultRecord(operationId: proposal.operationId, walletId: id, proposal: proposal)
      let logs: [[String: Any]]
      if kind == "vaultDeposit" {
        logs = [
          try log(
            EarnValues.vault, "Deposit(address,address,uint256,uint256)",
            [EarnValues.router, owner], ["1000000", "999000"])
        ]
      } else {
        logs = [
          try log(
            EarnValues.vault, "Transfer(address,address,uint256)",
            [owner, "0x" + String(repeating: "0", count: 40)], ["2000000"]),
          try log(
            EarnValues.vault, "Withdraw(address,address,address,uint256,uint256)",
            [EarnValues.router, EarnValues.router, owner], ["2100000", "2000000"]),
          try log(
            EarnValues.usdc, "Transfer(address,address,uint256)", [EarnValues.router, owner],
            ["2100000"]),
        ]
      }
      try requireEarnReceiptSemantics(op, step: &step, receipt: ["logs": logs])
      XCTAssertThrowsError(
        try requireEarnReceiptSemantics(op, step: &step, receipt: ["logs": Array(logs.dropLast())]))
      XCTAssertThrowsError(
        try requireEarnReceiptSemantics(op, step: &step, receipt: ["logs": logs + [logs[0]]]))
      var changed = logs
      changed[changed.count - 1]["data"] = "0x" + (try earnAmountWord(value: "1"))
      XCTAssertThrowsError(
        try requireEarnReceiptSemantics(op, step: &step, receipt: ["logs": changed]))
    }
  }

  func testFailedPersistenceNeverBroadcastsEvenIfRenameSucceeded() async throws {
    for committed in [false, true] {
      let (base, _) = try setup()
      let files = VaultFailingFiles(base.files)
      let store = WalletStorage(files: files, keys: base.keys)
      let wallet = try store.load()
      defer { wallet.close() }
      let journal = EarnVaultJournal(store: store, record: wallet)
      let rpc = VaultRPC()
      let engine = EarnVaultEngine(
        store: store, journal: journal, rpc: rpc, state: { _, _, _ in self.state() })
      let op = try await engine.create(request())
      let review = try await engine.prepare(op.operationId, revision: op.revision)
      files.failure = committed
      do {
        try await engine.execute(review, authority: {})
        XCTFail()
      } catch {}
      XCTAssertTrue(rpc.sent.isEmpty)
      files.failure = nil
      XCTAssertEqual(try journal.get(op.operationId).steps[0].raw != nil, committed)
    }
  }

  func testMissingStorageKeyAndCorruptionFailClosed() throws {
    let (store, journal) = try setup()
    _ = try journal.create(EarnVaultProposal.parse(request(), walletId: id, owner: owner))
    let name = "gizu-earn-vault-\(journal.generation).enc"
    let encrypted = try store.files.read(name)
    XCTAssertFalse(String(decoding: encrypted, as: UTF8.self).contains("ios-deposit"))
    try store.files.write(name, bytes: Data(repeating: 9, count: 128))
    XCTAssertThrowsError(try journal.all())
    try store.files.write(name, bytes: encrypted)
    (store.keys as! Keys).key = nil
    XCTAssertThrowsError(try journal.all())
  }
}
