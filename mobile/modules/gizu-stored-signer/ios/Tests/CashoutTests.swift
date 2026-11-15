import XCTest

@testable import GizuStoredSignerNative

private let cashoutAsset = "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx"
private final class CashoutFixture: CashoutGateway {
  let store: WalletStorage
  let journal: CashoutJournal
  let sources: [CashoutSource]
  var source: CashoutSource { sources[0] }
  var approvals = 0, nonce = 0
  var submitted: [String] = []
  var loseResponse = false, ready = false, malformed = false
  init(store: WalletStorage, record: WalletRecord) throws {
    self.store = store
    journal = CashoutJournal(store: store, record: record)
    sources = try cashoutSources(record)
  }
  func engine() -> CashoutEngine {
    CashoutEngine(
      store: store, journal: journal, gateway: self,
      read: { source in
        [
          "confidentialAddress": source.address, "assetId": cashoutAsset, "available": "3000000",
          "timestampMs": UInt64(Date().timeIntervalSince1970 * 1000), "authenticated": true,
          "operationScoped": false,
        ]
      }, authority: {}, catalogue: { _ in self.sources },
      assertCanStart: { try assertCashoutCanStart(store: self.store, record: $0) })
  }
  func prepare(group: [String: Any], index: Int, source: CashoutSource, anchor: String?)
    async throws -> [String: Any]
  {
    let plan = try JSONDecoder().decode(
      CashoutPlan.self, from: JSONSerialization.data(withJSONObject: group["plan"]!))
    let recipient = (group["recipients"] as! [String])[plan.children[index].slot]
    let amount = plan.children[index].amountAtoms
    let id = plan.proposal.operationId + "_\(index)"
    let now = UInt64(Date().timeIntervalSince1970 * 1000)
    let expiry = now + 45000
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let deadline = formatter.string(from: Date(timeIntervalSince1970: Double(expiry) / 1000))
    let minimum = try cashoutSubtract(amount, "1000")
    nonce += 1
    let payload = try CashoutJSON.text([
      "signer_id": source.address, "verifying_contract": "intents.far", "deadline": deadline,
      "nonce": Data(repeating: UInt8(nonce), count: 32).base64EncodedString(),
      "intents": [
        [
          "intent": "transfer", "receiver_id": "deposit-\(id)",
          "tokens": ["imt:" + String(repeating: "a", count: 64) + ":" + cashoutAsset: amount],
        ]
      ],
    ])
    let request: [String: Any] = [
      "dry": false, "swapType": "EXACT_INPUT", "depositType": "CONFIDENTIAL_INTENTS",
      "recipientType": "DESTINATION_CHAIN", "recipient": recipient,
      "refundType": "CONFIDENTIAL_INTENTS",
      "refundTo": source.address, "originAsset": cashoutAsset, "destinationAsset": cashoutAsset,
      "amount": amount, "slippageTolerance": 100, "confidentiality": "advanced",
    ]
    return [
      "operationId": id, "recoveryEnvelope": "sealed-\(id)", "confidentialAccount": source.address,
      "destinationRecipient": recipient, "destinationToken": MainnetPortfolio.usdc,
      "destinationChainId": 143,
      "assetId": cashoutAsset, "amountAtoms": amount, "minimumDestinationAtoms": minimum,
      "observedAtMs": now, "expiresAtMs": expiry, "quoteRequest": request,
      "quoteResponse": [
        "quoteRequest": request, "signature": "provider",
        "quote": [
          "depositAddress": "deposit-\(id)", "amountIn": malformed ? "1" : amount,
          "amountOut": minimum, "minAmountOut": minimum, "deadline": deadline,
        ],
      ],
      "intent": ["standard": "erc191", "payload": payload],
    ]
  }
  func submit(_ signed: String) async throws -> [String: Any] {
    XCTAssertGreaterThan(approvals, 0)
    XCTAssertTrue(try journal.active()!.children.contains { $0.signedData == signed })
    submitted.append(signed)
    if loseResponse { throw WalletFailure.unavailable }
    return ["intentHash": "intent-\(submitted.count)"]
  }
  func status(_ row: CashoutRecord, recipients: [String]) async throws -> [String: Any] {
    let paid = ready && row.children.allSatisfy { $0.signedData != nil }
    var result: [String: Any] = [
      "authenticated": true, "operationScoped": true, "operationId": row.operationId,
      "verification": "destination-receipt-group-v1",
      "groupId": try cashoutGroupIdentity(plan: row.plan, recipients: recipients),
      "observedAtMs": UInt64(Date().timeIntervalSince1970 * 1000),
      "nativeReceivedAtMs": UInt64(Date().timeIntervalSince1970 * 1000),
      "status": paid ? "paid" : "pending",
      "routes": row.children.indices.filter { row.children[$0].signedData != nil }.map {
        ["index": $0, "status": paid ? "SUCCESS" : "PROCESSING"] as [String: Any]
      },
    ]
    if paid {
      result["slots"] = try recipients.indices.map { slot -> [String: Any] in
        let minimum = try earnAmountSum(
          values: row.children.filter { $0.plan.slot == slot }.map(\.minimumDestinationAtoms))
        let total = try earnAmountSum(values: [minimum, "123"])
        return [
          "slot": slot, "destinationRecipient": recipients[slot],
          "minimumDestinationAtoms": minimum,
          "receivedAtoms": total,
          "receipts": [
            [
              "transactionHash": "0x" + String(repeating: "b", count: 64), "logIndex": slot,
              "receivedAtoms": total,
            ]
          ],
        ]
      }
    }
    return result
  }
  func approve(_ text: String, _ hash: String) throws {
    XCTAssertTrue(text.contains("Guaranteed net output"))
    XCTAssertTrue(text.contains("Maximum fees/route deduction"))
    XCTAssertEqual(hash.count, 66)
    approvals += 1
  }
}

final class CashoutTests: WalletTestCase {
  private func fixture() throws -> CashoutFixture {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    return try CashoutFixture(store: store, record: wallet)
  }
  func testMultipleOwnedSourcesShareReceivingSlotsWithoutDuplicateAllocations() async throws {
    let store = try storage()
    let wallet = try WalletRecord(
      id: id, credential: credential(), entropy: Data(repeating: 0, count: 32),
      verified: true, earnChain: 4663, earnCycles: "[{\"chainId\":4663,\"cycleIndex\":0}]")
    defer { wallet.close() }
    try store.create(wallet)
    let f = try CashoutFixture(store: store, record: wallet)
    _ = try await f.engine().prepare(amount: "5000000")
    let row = try XCTUnwrap(f.journal.active())
    XCTAssertEqual(row.plan.proposal.sources.count, 2)
    XCTAssertEqual(row.plan.proposal.recipientIndices.count, 2)
    XCTAssertTrue((2...3).contains(row.children.count))
    f.ready = true
    let result = try await f.engine().execute(
      id: row.operationId, revision: row.revision, approve: f.approve)
    XCTAssertEqual(result["status"] as? String, "paid")
    XCTAssertEqual(f.submitted.count, row.children.count)
    XCTAssertEqual(
      result["receivedAtoms"] as? String, String(5_000_000 - row.children.count * 1000 + 246))
  }

  func testGroupCommitmentMatchesAndroidAndBackend() throws {
    let p = CashoutProposal(
      operationId: "cash_group", amountAtoms: "3000000",
      sources: [
        CashoutSource(
          kind: "swap", profileChainId: 0, cycleIndex: 0,
          address: "0x" + String(repeating: "1", count: 40), amountAtoms: "1000000"),
        CashoutSource(
          kind: "earn", profileChainId: 4663, cycleIndex: 0,
          address: "0x" + String(repeating: "3", count: 40), amountAtoms: "2000000"),
      ], recipientIndices: [3], weightsBps: [10000])
    let plan = try JSONDecoder().decode(
      CashoutPlan.self, from: Data(confidentialWithdrawalPlan(proposal: EarnValues.json(p)).utf8))
    XCTAssertEqual(
      try cashoutGroupIdentity(plan: plan, recipients: ["0x" + String(repeating: "2", count: 40)]),
      "0e26bdfdcbd73928d15787eff819c74d2f9a6de422807900fdd5896b95bbe083")
  }
  func testExactArithmeticRejectsUnderflow() throws {
    XCTAssertEqual(
      try cashoutSubtract("100000000000000000000000000000000000", "1"),
      "99999999999999999999999999999999999")
    XCTAssertEqual(try cashoutSubtract("10", "10"), "0")
    XCTAssertThrowsError(try cashoutSubtract("1", "2"))
    XCTAssertEqual(cashoutUSDC("1"), "0.000001")
  }
  func testCancelRetainsNonceHistoryAndLocksPlan() async throws {
    let f = try fixture()
    _ = try await f.engine().prepare(amount: "3000000")
    let row = try XCTUnwrap(f.journal.active())
    let nonce = try XCTUnwrap(f.journal.active()?.children[0].nonce)
    XCTAssertThrowsError(try f.journal.update(row) { $0.plan.proposal.amountAtoms = "1" })
    XCTAssertThrowsError(try f.journal.create(row.plan))
    let cancelled = try f.journal.cancel(row)
    XCTAssertTrue(cancelled.terminal)
    XCTAssertNil(try f.journal.active())
    XCTAssertThrowsError(try f.journal.update(row) { _ in })
    XCTAssertThrowsError(
      try f.journal.assertFreshNonce(
        source: f.source.address, nonce: nonce, operationId: "other", index: 0))
  }
  func testReviewRejectionNeverSignsAndMalformedQuoteFailsClosed() async throws {
    let f = try fixture()
    _ = try await f.engine().prepare(amount: "3000000")
    let row = try XCTUnwrap(f.journal.active())
    do {
      _ = try await f.engine().execute(id: row.operationId, revision: row.revision) { _, _ in
        throw WalletFailure.cancelled
      }
      XCTFail()
    } catch {}
    XCTAssertTrue(f.submitted.isEmpty)
    XCTAssertTrue(try f.journal.active()!.children.allSatisfy { $0.signedData == nil })
    let bad = try fixture()
    bad.malformed = true
    do {
      _ = try await bad.engine().prepare(amount: "3000000")
      XCTFail()
    } catch {}
    XCTAssertTrue(bad.submitted.isEmpty)
    XCTAssertEqual(try bad.journal.active()?.children[0].minimumDestinationAtoms, "0")
  }
  func testLostResponsePersistsExactBytesAcrossRestartAndNeedsNewApproval() async throws {
    let f = try fixture()
    _ = try await f.engine().prepare(amount: "3000000")
    var row = try XCTUnwrap(f.journal.active())
    f.loseResponse = true
    let first = try await f.engine().execute(
      id: row.operationId, revision: row.revision, approve: f.approve)
    XCTAssertEqual(first["status"] as? String, "unknown")
    XCTAssertEqual(f.submitted.count, 1)
    let original = f.submitted[0]
    row = try XCTUnwrap(f.journal.active())
    XCTAssertThrowsError(try f.journal.cancel(row))
    XCTAssertThrowsError(try f.journal.update(row) { $0.children[0].signedData = "replacement" })
    do {
      _ = try await f.engine().execute(id: row.operationId, revision: row.revision) { _, _ in
        throw WalletFailure.cancelled
      }
      XCTFail()
    } catch {}
    XCTAssertEqual(f.submitted.count, 1)
    row = try XCTUnwrap(f.journal.active())
    f.loseResponse = false
    let pending = try await f.engine().execute(
      id: row.operationId, revision: row.revision, approve: f.approve)
    XCTAssertEqual(pending["status"] as? String, "pending")
    XCTAssertEqual(f.submitted[1], original)
    row = try XCTUnwrap(f.journal.active())
    f.ready = true
    let result = try await f.engine().execute(
      id: row.operationId, revision: row.revision, approve: f.approve)
    XCTAssertEqual(result["status"] as? String, "paid")
    let text = try CashoutJSON.text(result)
    XCTAssertFalse(text.contains(original))
    XCTAssertFalse(text.contains(f.source.address))
    XCTAssertNil(try f.journal.active())
  }
  func testSuccessfulGroupIsImmutableAndPrivateWorkIsExcluded() async throws {
    let f = try fixture()
    _ = try await f.engine().prepare(amount: "3000000")
    let wallet = try f.store.load()
    defer { wallet.close() }
    XCTAssertThrowsError(try assertCashoutInactive(store: f.store, record: wallet))
    let row = try XCTUnwrap(f.journal.active())
    f.ready = true
    let view = try await f.engine().execute(
      id: row.operationId, revision: row.revision, approve: f.approve)
    XCTAssertEqual(view["status"] as? String, "paid")
    let paid = try f.journal.get(row.operationId)
    XCTAssertThrowsError(try f.journal.update(paid) { $0.children[0].receivedAtoms = "1" })
    XCTAssertNoThrow(try assertCashoutInactive(store: f.store, record: wallet))
    let name = "gizu-confidential-withdrawal-\(f.journal.generation).enc"
    let encrypted = try f.store.files.read(name, limit: 8 * 1024 * 1024)
    XCTAssertFalse(String(decoding: encrypted, as: UTF8.self).contains(row.operationId))
    try f.store.files.write(name, bytes: Data(repeating: 0, count: 100))
    XCTAssertThrowsError(try f.journal.all())
    XCTAssertThrowsError(try assertCashoutInactive(store: f.store, record: wallet))
  }
  func testCancelledSwapWithSignedPayoutStillBlocksCashout() throws {
    var state: [String: Any] = [
      "step": ["step": "paused"], "cancelled": true,
      "data": ["signedOperation": NSNull(), "payouts": [["signed": "signature"]]],
    ]
    XCTAssertThrowsError(try assertCashoutSwapFinished(state))
    state["data"] = ["signedOperation": NSNull(), "payouts": []] as [String: Any]
    XCTAssertNoThrow(try assertCashoutSwapFinished(state))
    state["cancelled"] = false
    XCTAssertThrowsError(try assertCashoutSwapFinished(state))
  }
}

private final class CashoutFailingFiles: WalletFiles {
  let base: WalletFiles
  let keys: WalletKeyStore
  let id: String
  var failSignedWrite: Bool?
  init(base: WalletFiles, keys: WalletKeyStore, id: String) {
    self.base = base
    self.keys = keys
    self.id = id
  }
  func url(_ name: String) throws -> URL { try base.url(name) }
  func exists(_ name: String) throws -> Bool { try base.exists(name) }
  func read(_ name: String, limit: Int) throws -> Data { try base.read(name, limit: limit) }
  func write(_ name: String, bytes: Data) throws {
    if name.hasPrefix("gizu-confidential-withdrawal-"), let afterWrite = failSignedWrite {
      let aad = Data("gizu-confidential-withdrawal:v1:\(id):\(id)".utf8)
      var clear = try WalletEnvelope.decrypt(bytes, key: keys.existing()!, aad: aad)
      defer { clear.wipe() }
      if String(decoding: clear, as: UTF8.self).contains("signedData") {
        if afterWrite { try base.write(name, bytes: bytes) }
        throw WalletFailure.unavailable
      }
    }
    try base.write(name, bytes: bytes)
  }
}
extension CashoutTests {
  func testSignedWriteFailureNeverBroadcastsEvenAfterAtomicRename() async throws {
    for committed in [false, true] {
      let base = try storage()
      let wallet = try record(verified: true)
      defer { wallet.close() }
      let files = CashoutFailingFiles(base: base.files, keys: base.keys, id: id)
      let store = WalletStorage(files: files, keys: base.keys)
      try store.create(wallet)
      let f = try CashoutFixture(store: store, record: wallet)
      _ = try await f.engine().prepare(amount: "3000000")
      let row = try XCTUnwrap(f.journal.active())
      files.failSignedWrite = committed
      do {
        _ = try await f.engine().execute(
          id: row.operationId, revision: row.revision, approve: f.approve)
        XCTFail("Expected write failure")
      } catch {}
      XCTAssertTrue(f.submitted.isEmpty)
      files.failSignedWrite = nil
      let saved = try XCTUnwrap(f.journal.active())
      XCTAssertEqual(saved.children[0].signedData != nil, committed)
      XCTAssertThrowsError(try f.journal.cancel(saved))
      if !committed {
        // A durable pre-sign marker is safe to refresh only because nothing was submitted.
        f.ready = true
        let recovered = try await f.engine().execute(
          id: saved.operationId, revision: saved.revision, approve: f.approve)
        XCTAssertEqual(recovered["status"] as? String, "paid")
      }
    }
  }
}
