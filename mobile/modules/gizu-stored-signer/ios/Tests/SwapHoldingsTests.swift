import XCTest

@testable import GizuStoredSignerNative

final class SwapHoldingsTests: WalletTestCase {
  private let token = "0x" + String(repeating: "1", count: 40)
  private let other = "0x" + String(repeating: "2", count: 40)
  private let gateway = "https://api.gizu.io"
  private func allocated(_ store: WalletStorage) throws -> WalletRecord {
    let initial = try record(verified: true)
    defer { initial.close() }
    try store.create(initial)
    try store.persistRegistry(#"{"version":1,"nextRecipient":6}"#, expectedId: id)
    return try store.load()
  }
  func testSharedFixtureAmountsAndSelection() throws {
    let url = Bundle.module.url(
      forResource: "swap-holdings", withExtension: "json", subdirectory: "Fixtures")!
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    let registry = fixture["registry"] as! String
    let indices = try swapHoldingIndices(registry: registry, excluded: [6])
    XCTAssertEqual(indices, [3, 4, 5, 7, 8, 9])
    let value = try buildSwapHolding(
      targetAddress: token, indices: indices,
      balances: fixture["balances"] as! [String], symbolAbi: fixture["symbolAbi"] as! String,
      decimalsAbi: fixture["decimalsAbi"] as! String)
    XCTAssertEqual(try swapObject(value) as NSDictionary, fixture["expected"] as! NSDictionary)
    XCTAssertEqual(
      try selectSwapHolding(id: "\(token):7", registry: registry, excluded: [6], tracked: [token])
        .indices, [7, 8, 9])
    XCTAssertThrowsError(
      try selectSwapHolding(id: "\(token):6", registry: registry, excluded: [6], tracked: [token]))
  }
  func testHistoryAndTrackedTokensSurviveNewOperationsAndRestart() throws {
    let store = try storage()
    let record = try allocated(store)
    defer { record.close() }
    let saved = StoredSwapFile(store: store, record: record)
    var engine = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try engine.start(record: record, target: token, amountAtoms: "1000000")
    try engine.cancel()
    let first = try engine.view()["operationId"] as! String
    engine.close()
    let fresh = try store.load()
    defer { fresh.close() }
    engine = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try engine.start(record: fresh, target: other, amountAtoms: "1000000")
    engine.close()
    let reloaded = SwapPortfolioStore(store: store, record: fresh)
    XCTAssertEqual(Set(try reloaded.targets()), Set([token, other]))
    XCTAssertEqual(try reloaded.history().first?["operationId"] as? String, first)
    XCTAssertEqual(try reloaded.history().first?["phase"] as? String, "CANCELLED")
  }
  func testCompletionCannotBeDowngradedAndNoPrivateStateIsArchived() throws {
    let store = try storage()
    let record = try allocated(store)
    defer { record.close() }
    let portfolio = SwapPortfolioStore(store: store, record: record)
    let state = "{\"plan\":{\"target\":\"\(token)\"},\"secretMarker\":\"do-not-archive\"}"
    let status =
      "{\"operationId\":\"purchase\",\"phase\":\"COMPLETE\",\"direction\":\"buy\",\"receivedTargetAtoms\":\"42\"}"
    try portfolio.remember(state: state, status: status)
    let before = try portfolio.history() as NSArray
    try portfolio.remember(
      state: state, status: status.replacingOccurrences(of: "COMPLETE", with: "CANCELLED"))
    XCTAssertEqual(try portfolio.history() as NSArray, before)
    let encrypted = try store.files.read("gizu-holdings-\(record.journalId).enc")
    let clear = try WalletEnvelope.decrypt(
      encrypted, key: store.keys.existing()!,
      aad: Data("gizu-holdings:v1:\(record.id):\(record.journalId)".utf8))
    XCTAssertFalse(String(decoding: clear, as: UTF8.self).contains("do-not-archive"))
  }
  func testMissingKeyCorruptionAndRestoreCannotReusePortfolio() throws {
    let keys = Keys()
    let store = try storage(keys)
    let record = try allocated(store)
    defer { record.close() }
    let portfolio = SwapPortfolioStore(store: store, record: record)
    try portfolio.watch(token)
    let key = keys.key
    keys.key = nil
    XCTAssertThrowsError(try portfolio.targets())
    keys.key = key
    try store.files.write("gizu-holdings-\(record.journalId).enc", bytes: Data([1, 2, 3]))
    XCTAssertThrowsError(try portfolio.targets())
    let restored = try WalletRecord(
      id: record.id, credential: record.credential, entropy: record.entropy,
      verified: true, journalId: UUID().uuidString, roleRegistry: record.roleRegistry)
    defer { restored.close() }
    XCTAssertEqual(try SwapPortfolioStore(store: store, record: restored).targets(), [])
    XCTAssertEqual(store.state(), "ready")
  }
  func testSellChecksOwnershipAndNeverOverwritesUnfinishedSale() throws {
    let store = try storage()
    let record = try allocated(store)
    defer { record.close() }
    let saved = StoredSwapFile(store: store, record: record)
    let engine = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    XCTAssertThrowsError(try engine.startSell(record: record, holdingId: "\(token):3"))
    try saved.portfolio.watch(token)
    XCTAssertThrowsError(try engine.startSell(record: record, holdingId: "\(token):4"))
    try engine.startSell(record: record, holdingId: "\(token):3")
    engine.close()
    let state = try saved.load()!["state"] as! String
    let plan = try swapObject(state)["plan"] as! [String: Any]
    XCTAssertEqual(plan["holderIndices"] as? [Int], [3, 4, 5])
    // Up to five fresh return wallets are reserved; the engine draws how many it pays.
    XCTAssertEqual(plan["recipientIndices"] as? [Int], [6, 7, 8, 9, 10])
    XCTAssertEqual((plan["legsRandom"] as? String)?.count, 64)
    let fresh = try store.load()
    defer { fresh.close() }
    let second = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    XCTAssertThrowsError(try second.startSell(record: fresh, holdingId: "\(token):3"))
    XCTAssertEqual(try saved.load()!["state"] as? String, state)
  }
  func testRecoveryUsesAllocatedAccountsAndResumeKeepsOperationIdentity() throws {
    let store = try storage()
    let record = try allocated(store)
    defer { record.close() }
    let saved = StoredSwapFile(store: store, record: record)
    let engine = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try engine.startRecovery(record: record, target: token)
    let first = try engine.view()["operationId"] as! String
    engine.close()
    let fresh = try store.load()
    defer { fresh.close() }
    XCTAssertEqual(fresh.roleRegistry, record.roleRegistry)
    let second = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try second.startRecovery(record: fresh, target: other)
    XCTAssertEqual(try second.view()["operationId"] as? String, first)
    let plan = try swapObject(saved.load()!["state"] as! String)["plan"] as! [String: Any]
    XCTAssertEqual(plan["scanTo"] as? Int, 6)
    XCTAssertEqual(plan["target"] as? String, token)
  }
  func testInterruptedSummaryWriteCanBeBackfilledFromSavedOperation() throws {
    let base = try storage()
    let files = FailingPortfolioFiles(base: base.files)
    let store = WalletStorage(files: files, keys: base.keys)
    let record = try allocated(store)
    defer { record.close() }
    let saved = StoredSwapFile(store: store, record: record)
    let engine = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    files.fail = true
    XCTAssertThrowsError(try engine.start(record: record, target: token, amountAtoms: "1000000"))
    engine.close()
    let before = try saved.load()!["state"] as! String
    XCTAssertEqual(try saved.portfolio.targets(), [])
    files.fail = false
    try saved.portfolio.rememberActive(saved, gateway: gateway)
    XCTAssertEqual(try saved.portfolio.targets(), [token])
    XCTAssertEqual(try saved.load()!["state"] as? String, before)
    let resumed = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try resumed.restore()
    XCTAssertEqual(
      try resumed.view()["operationId"] as? String, try swapObject(before)["id"] as? String)
  }

  func testStatusDoesNotRetryPausedOperationButExplicitRetryDoes() throws {
    let store = try storage()
    let record = try allocated(store)
    defer { record.close() }
    let saved = StoredSwapFile(store: store, record: record)
    let engine = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try engine.start(record: record, target: token, amountAtoms: "1000000")
    engine.close()
    let root = try saved.load()!
    var state = try swapObject(root["state"] as! String)
    state["paused"] = "HTTP_FAILED"
    try saved.save(
      operationId: state["id"] as! String,
      state: String(decoding: JSONSerialization.data(withJSONObject: state), as: UTF8.self),
      fundingAddress: root["fundingAddress"] as! String)
    let resumed = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try resumed.restore()
    XCTAssertEqual(try resumed.view()["phase"] as? String, "PAUSED")
    try resumed.retry()
    XCTAssertNotEqual(try resumed.view()["phase"] as? String, "PAUSED")
    XCTAssertEqual(try resumed.view()["operationId"] as? String, state["id"] as? String)
    XCTAssertTrue(try swapObject(saved.load()!["state"] as! String)["paused"] is NSNull)
  }

  func testCancellingProgressDoesNotAdvanceJournal() async throws {
    let store = try storage()
    let record = try allocated(store)
    defer { record.close() }
    let saved = StoredSwapFile(store: store, record: record)
    let engine = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try engine.start(record: record, target: token, amountAtoms: "1000000")
    let before = try saved.load()!["state"] as! String
    let task = Task {
      try await engine.advance { _ in withUnsafeCurrentTask { $0?.cancel() } }
    }
    do {
      _ = try await task.value
      XCTFail("Cancelled task advanced")
    } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
    engine.close()
    XCTAssertEqual(try saved.load()!["state"] as? String, before)
  }

  func testPayoutUsesPrivateBalancePlan() throws {
    let store = try storage()
    let record = try allocated(store)
    defer { record.close() }
    let saved = StoredSwapFile(store: store, record: record)
    let engine = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try engine.start(record: record, target: token, amountAtoms: nil, payout: true)
    let plan = try swapObject(saved.load()!["state"] as! String)["plan"] as! [String: Any]
    XCTAssertEqual(plan["kind"] as? String, "confidentialPayout")
    XCTAssertTrue(plan["amountAtoms"] is NSNull)
  }

  func testDiscoveryReadsBalancesWithoutCreatingSwapAndTracksOnlyOnSuccess() async throws {
    let store = try storage()
    let record = try allocated(store)
    defer { record.close() }
    let reader = SwapHoldings(rpc: HoldingsRPC())
    let value = try await reader.read(store: store, target: token)
    let holdings = value["holdings"] as! [[String: Any]]
    XCTAssertEqual(holdings.first?["balanceAtoms"] as? String, "21")
    XCTAssertEqual(try SwapPortfolioStore(store: store, record: record).targets(), [token])
    XCTAssertNil(try StoredSwapFile(store: store, record: record).load())
    for failure in ["chain", "balance", "reorg", "rpc"] {
      do {
        _ = try await SwapHoldings(rpc: HoldingsRPC(failure: failure)).read(
          store: store, target: other)
        XCTFail("Accepted \(failure)")
      } catch {}
      XCTAssertEqual(try SwapPortfolioStore(store: store, record: record).targets(), [token])
    }
  }
}

private struct HoldingsRPC: MainnetPortfolioRPC {
  var failure = ""
  func calls(_ requests: [PortfolioRequest]) async throws -> [Any] {
    if failure == "rpc" { throw URLError(.timedOut) }
    return requests.map { request in
      if request.method == "eth_chainId" { return failure == "chain" ? "0x8f" : "0x1237" }
      if request.method == "eth_getBlockByNumber" {
        let changed = failure == "reorg" && request.params[0] as? String != "latest"
        return [
          "number": "0x123", "hash": "0x" + String(repeating: changed ? "b" : "a", count: 64),
        ]
      }
      let data = (request.params[0] as! [String: String])["data"]!
      XCTAssertEqual(request.params[1] as? String, "0x123")
      if data == "0x95d89b41" {
        return "0x" + String(repeating: "0", count: 62) + "20" + String(repeating: "0", count: 63)
          + "5" + "474f4f474c" + String(repeating: "0", count: 54)
      }
      if failure == "balance" && data.hasPrefix("0x70a08231") { return "0x7" }
      return "0x" + String(repeating: "0", count: 63) + "7"
    }
  }
}

private final class FailingPortfolioFiles: WalletFiles {
  let base: WalletFiles
  var fail = false
  init(base: WalletFiles) { self.base = base }
  func url(_ name: String) throws -> URL { try base.url(name) }
  func exists(_ name: String) throws -> Bool { try base.exists(name) }
  func read(_ name: String, limit: Int) throws -> Data { try base.read(name, limit: limit) }
  func write(_ name: String, bytes: Data) throws {
    if fail && name.hasPrefix("gizu-holdings-") { throw CocoaError(.fileWriteOutOfSpace) }
    try base.write(name, bytes: bytes)
  }
}
