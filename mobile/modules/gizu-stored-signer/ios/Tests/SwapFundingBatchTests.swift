import XCTest

@testable import GizuStoredSignerNative

final class SwapFundingBatchTests: WalletTestCase {
  private let target = "0x12f190a9f9d7d37a250758b26824b97ce941bf54"
  private let gateway = "https://api.gizu.io"

  func testCrashAfterReservationBeforeParentSaveDoesNotStrandUnsignedSources() async throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    let owner = try deriveAccountAddressRange(entropy: wallet.entropy, start: 1, count: 1)[0]
    let ledger = FundingReservations(store: store, record: wallet)
    try ledger.reserve(
      parentId: "crashed-before-save",
      sources: [
        [
          "sourceId": "orphan", "sourceChainId": 143, "token": fundingUsdc(143),
          "address": owner, "budgetAtoms": "10000000", "balanceAtoms": "10000000",
        ]
      ])
    let saved = StoredSwapFile(store: store, record: wallet)
    XCTAssertNil(try saved.load())
    let engine = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try await engine.startFunding(
      record: wallet, target: target, amountAtoms: "15000000", chainId: 4663,
      services: services("0", owner: owner))
    XCTAssertEqual(try ledger.reservedAtoms(chainId: 143, owner: owner), "10000000")
    XCTAssertEqual(try ledger.reservedAtoms(chainId: 8453, owner: owner), "5000000")
  }

  func testOldBackendCapability404UsesLegacyMonadFeePlannerWithoutNewMetadata() async throws {
    XCTAssertEqual(try SwapFundingServices.enabledChains(status: 404, body: ""), [143])
    let owner = "0x" + String(repeating: "1", count: 40)
    let recipient = "0x" + String(repeating: "2", count: 40)
    var requested = ""
    let api = SwapFundingServices.native(
      gateway: gateway,
      transport: { method, url, body in
        requested = url
        XCTAssertEqual(method, "POST")
        XCTAssertEqual(try? swapObject(body!)["budget"] as? String, "15000000")
        return (
          200,
          "{\"chainId\":143,\"owner\":\"\(owner)\",\"token\":\"\(MainnetPortfolio.usdc)\",\"feeCap\":\"100000\"}"
        )
      })
    let fee = try await api.fee(143, owner, recipient, "15000000")
    XCTAssertEqual(fee, "100000")
    XCTAssertEqual(requested, gateway + "/v1/earn/monad/funding-plan")
  }

  func testReviewedFifteenUsdcInputIsNotArtificiallyCappedAtTen() throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    let saved = StoredSwapFile(store: store, record: wallet)
    let engine = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try engine.start(record: wallet, target: target, amountAtoms: "15000000")
    let state = try swapObject(saved.load()!["state"] as! String)
    XCTAssertEqual((state["plan"] as? [String: Any])?["amountAtoms"] as? String, "15000000")
  }
  private func services(_ privateAtoms: String, owner: String) -> SwapFundingServices {
    SwapFundingServices(
      sources: { _ in
        try [143, 8453].map { chain in
          [
            "sourceChainId": chain, "token": try fundingUsdc(chain), "decimals": 6,
            "accountIndex": 1, "owner": owner, "balanceAtoms": "10000000", "complete": true,
            "stale": false,
          ]
        }
      },
      privateBalance: { wallet in
        [
          "confidentialAddress": try deriveAccountAddressRange(
            entropy: wallet.entropy, start: 2, count: 1)[0],
          "assetId": "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
          "available": privateAtoms, "timestampMs": Int64(Date().timeIntervalSince1970 * 1000),
          "authenticated": true, "operationScoped": false,
        ]
      }, fee: { _, _, _, _ in "100000" })
  }
  func testFifteenUsdcSwapUsesTwoAccountOneSourcesAndRestoresSavedRecipients() async throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    let owner = try deriveAccountAddressRange(entropy: wallet.entropy, start: 1, count: 1)[0]
    let saved = StoredSwapFile(store: store, record: wallet)
    let engine = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try await engine.startFunding(
      record: wallet, target: target, amountAtoms: "15000000", chainId: 4663,
      services: services("0", owner: owner))
    let root = try saved.load()!
    let batch = root["batch"] as! [String: Any]
    let sources = batch["sources"] as! [[String: Any]]
    XCTAssertEqual(root["version"] as? Int, 2)
    XCTAssertEqual(sources.map { $0["sourceChainId"] as! Int }, [143, 8453])
    XCTAssertEqual(sources.map { $0["budgetAtoms"] as! String }, ["10000000", "5000000"])
    XCTAssertEqual(batch["budgetAtoms"] as? String, "15000000")
    XCTAssertNil(batch["downstreamState"])
    XCTAssertThrowsError(try assertCashoutCanStart(store: store, record: wallet))
    let restarted = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try restarted.restore()
    XCTAssertEqual(try restarted.view()["operationId"] as? String, root["operationId"] as? String)
    XCTAssertEqual(try restarted.view()["phase"] as? String, "REVIEW")
    let restoredBatch = try saved.load()!["batch"] as! NSDictionary
    XCTAssertEqual(restoredBatch, batch as NSDictionary)
    let second = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    do {
      try await second.startFunding(
        record: wallet, target: target, amountAtoms: "15000000", chainId: 4663,
        services: services("0", owner: owner))
      XCTFail("Unfinished parent cannot be replaced")
    } catch {}
  }
  func testPrivateFirstFundingCapsOneDownstreamAtTheOriginalBudget() async throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    let owner = try deriveAccountAddressRange(entropy: wallet.entropy, start: 1, count: 1)[0]
    let saved = StoredSwapFile(store: store, record: wallet)
    let engine = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try await engine.startFunding(
      record: wallet, target: target, amountAtoms: "15000000", chainId: 4663,
      services: services("50000000", owner: owner))
    let root = try saved.load()!
    let batch = root["batch"] as! [String: Any]
    XCTAssertEqual(batch["approvedExistingPrivateAtoms"] as? String, "15000000")
    XCTAssertEqual((batch["sources"] as! [Any]).count, 0)
    let downstream = try swapObject(batch["downstreamState"] as! String)["plan"] as! [String: Any]
    XCTAssertEqual(downstream["kind"] as? String, "confidentialPayout")
    XCTAssertEqual(downstream["amountAtoms"] as? String, "15000000")
    XCTAssertEqual(
      downstream["recipientIndices"] as? NSArray, batch["recipientIndices"] as? NSArray)
    XCTAssertEqual(downstream["weights"] as? NSArray, batch["weights"] as? NSArray)
  }

  func testUnsupportedTargetCannotStrandSourceReservations() async throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    let owner = try deriveAccountAddressRange(entropy: wallet.entropy, start: 1, count: 1)[0]
    let engine = StoredSwapEngine(
      storage: store, saved: StoredSwapFile(store: store, record: wallet), gateway: gateway)
    do {
      try await engine.startFunding(
        record: wallet, target: "0x" + String(repeating: "1", count: 40), amountAtoms: "15000000",
        chainId: 4663, services: services("0", owner: owner))
      XCTFail("unsupported target")
    } catch {}
    let ledger = FundingReservations(store: store, record: wallet)
    XCTAssertEqual(try ledger.reservedAtoms(chainId: 143, owner: owner), "0")
    XCTAssertEqual(try ledger.reservedAtoms(chainId: 8453, owner: owner), "0")
  }

  private func completedParent(secondSource: Bool) throws -> (
    WalletStorage, WalletRecord, StoredSwapFile, SwapFundingBatch
  ) {
    let store = try storage()
    let wallet = try WalletRecord(
      id: id, credential: credential(), entropy: Data(repeating: 7, count: 32), verified: true,
      roleRegistry: #"{"version":1,"nextRecipient":6}"#)
    try store.create(wallet)
    let fixture = Bundle.module.url(
      forResource: "fund-only-complete", withExtension: "json", subdirectory: "Fixtures")!
    let state = String(decoding: try Data(contentsOf: fixture), as: UTF8.self)
    let root = try swapObject(state)
    let owner = root["source"] as! String
    let first = SwapFundingChild(
      sourceId: "143:\(owner)", sourceChainId: 143, token: try fundingUsdc(143), sourceIndex: 1,
      address: owner, budgetAtoms: "2000000", balanceAtoms: "10000000", state: state,
      operationId: root["id"] as? String, creditedAtoms: "1996980")
    var sources = [first]
    if secondSource {
      sources.append(
        SwapFundingChild(
          sourceId: "8453:\(owner)", sourceChainId: 8453, token: try fundingUsdc(8453),
          sourceIndex: 1, address: owner, budgetAtoms: "1000000", balanceAtoms: "10000000"))
    }
    let batch = SwapFundingBatch(
      operationId: "parent_restore", generation: wallet.journalId, target: target, chainId: 4663,
      budgetAtoms: secondSource ? "3500000" : "2500000", approvedExistingPrivateAtoms: "500000",
      recipientIndices: [3, 4, 5], weights: [3000, 3000, 4000], sources: sources, reviewed: true)
    let ledger = FundingReservations(store: store, record: wallet)
    try ledger.reserve(
      parentId: batch.operationId,
      sources: sources.map {
        [
          "sourceId": $0.sourceId, "sourceChainId": $0.sourceChainId, "token": $0.token,
          "address": $0.address, "budgetAtoms": $0.budgetAtoms, "balanceAtoms": $0.balanceAtoms,
        ]
      })
    try ledger.markSigned(
      parentId: batch.operationId, sourceId: first.sourceId, operationId: first.operationId!)
    let saved = StoredSwapFile(store: store, record: wallet)
    try saved.saveBatch(batch, state: state, fundingAddress: owner)
    return (store, wallet, saved, batch)
  }
  func testRestoreAfterOneCreditPersistsItBeforeStartingAnotherSource() async throws {
    let (store, wallet, saved, original) = try completedParent(secondSource: true)
    defer { wallet.close() }
    var observed = false
    let engine = StoredSwapEngine(
      storage: store, saved: saved, gateway: gateway,
      transport: { _, _, _ in
        let batch = try! saved.load()!["batch"] as! [String: Any]
        let sources = batch["sources"] as! [[String: Any]]
        XCTAssertEqual(sources[0]["state"] as? String, original.sources[0].state)
        XCTAssertEqual(sources[0]["creditedAtoms"] as? String, "1996980")
        let next = try! swapObject(sources[1]["state"] as! String)["plan"] as! [String: Any]
        XCTAssertEqual(next["kind"] as? String, "confidentialFunding")
        XCTAssertEqual(next["sourceIndex"] as? Int, 1)
        XCTAssertEqual(next["sourceChainId"] as? Int, 8453)
        XCTAssertEqual(next["amountAtoms"] as? String, "1000000")
        XCTAssertEqual(next["chainId"] as? Int, 4663)
        XCTAssertNil(batch["downstreamState"])
        observed = true
        withUnsafeCurrentTask { $0?.cancel() }
        return (0, "")
      })
    try engine.restore()
    let run = Task { try await engine.advance() }
    do {
      _ = try await run.value
      XCTFail("cancelled after persisted request")
    } catch is CancellationError {}
    XCTAssertTrue(observed)
    XCTAssertEqual(try saved.load()!["operationId"] as? String, original.operationId)
  }
  func testConfirmedCreditHandoffCapsPrivateExecutionAndDoesNotReplaySource() async throws {
    let (store, wallet, saved, original) = try completedParent(secondSource: false)
    defer { wallet.close() }
    var observed = false
    let engine = StoredSwapEngine(
      storage: store, saved: saved, gateway: gateway,
      transport: { _, _, _ in
        let batch = try! saved.load()!["batch"] as! [String: Any]
        let plan = try! swapObject(batch["downstreamState"] as! String)["plan"] as! [String: Any]
        XCTAssertEqual(plan["kind"] as? String, "confidentialPayout")
        XCTAssertEqual(plan["amountAtoms"] as? String, "2496980")
        XCTAssertEqual(plan["recipientIndices"] as? [UInt32], original.recipientIndices)
        XCTAssertEqual(plan["weights"] as? [UInt32], original.weights)
        XCTAssertEqual(
          (batch["sources"] as! [[String: Any]])[0]["state"] as? String, original.sources[0].state)
        observed = true
        withUnsafeCurrentTask { $0?.cancel() }
        return (0, "")
      })
    try engine.restore()
    let run = Task { try await engine.advance() }
    do {
      _ = try await run.value
      XCTFail("cancelled after persisted request")
    } catch is CancellationError {}
    XCTAssertTrue(observed)
    XCTAssertEqual(try saved.load()!["operationId"] as? String, original.operationId)
  }

  func testUnsignedCancellationReleasesAllSourcesAndKeepsPrivateFundsPrivate() async throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    let owner = try deriveAccountAddressRange(entropy: wallet.entropy, start: 1, count: 1)[0]
    let saved = StoredSwapFile(store: store, record: wallet)
    let engine = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try await engine.startFunding(
      record: wallet, target: target, amountAtoms: "15000000", chainId: 4663,
      services: services("2000000", owner: owner))
    try engine.cancel()
    XCTAssertEqual(try engine.view()["phase"] as? String, "CANCELLED")
    XCTAssertEqual(
      try FundingReservations(store: store, record: wallet).reservedAtoms(
        chainId: 143, owner: owner), "0")
    XCTAssertEqual(
      try FundingReservations(store: store, record: wallet).reservedAtoms(
        chainId: 8453, owner: owner), "0")
    let batch = try saved.load()!["batch"] as! [String: Any]
    XCTAssertEqual(batch["approvedExistingPrivateAtoms"] as? String, "2000000")
    XCTAssertNil(batch["downstreamState"])
  }
  func testStalePrivateObservationCannotCreateAParentOrReserveFunds() async throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    let owner = try deriveAccountAddressRange(entropy: wallet.entropy, start: 1, count: 1)[0]
    var api = services("2000000", owner: owner)
    let read = api.privateBalance
    api.privateBalance = { wallet in
      var result = try await read(wallet)
      result["timestampMs"] = Int64(Date().timeIntervalSince1970 * 1000) - 60001
      return result
    }
    let saved = StoredSwapFile(store: store, record: wallet)
    let engine = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    do {
      try await engine.startFunding(
        record: wallet, target: target, amountAtoms: "15000000", chainId: 4663, services: api)
      XCTFail("stale private funding observation")
    } catch {}
    XCTAssertNil(try saved.load())
    XCTAssertEqual(
      try FundingReservations(store: store, record: wallet).reservedAtoms(
        chainId: 143, owner: owner), "0")
  }
  func testChangedOrDuplicateConfirmedCreditCannotIncreaseTheHandoff() throws {
    let (_, wallet, _, original) = try completedParent(secondSource: false)
    defer { wallet.close() }
    var changed = original
    changed.sources[0].creditedAtoms = "1996981"
    XCTAssertThrowsError(try changed.validate(walletId: wallet.id, generation: wallet.journalId))
    changed = original
    changed.sources.append(changed.sources[0])
    changed.budgetAtoms = "4500000"
    XCTAssertThrowsError(try changed.validate(walletId: wallet.id, generation: wallet.journalId))
  }

  func testRestoredWalletGenerationCannotAuthorizeTheOldFundingParent() async throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    let owner = try deriveAccountAddressRange(entropy: wallet.entropy, start: 1, count: 1)[0]
    let engine = StoredSwapEngine(
      storage: store, saved: StoredSwapFile(store: store, record: wallet), gateway: gateway)
    try await engine.startFunding(
      record: wallet, target: target, amountAtoms: "15000000", chainId: 4663,
      services: services("0", owner: owner))
    let replacement = try WalletRecord(
      id: wallet.id, credential: wallet.credential, entropy: wallet.entropy, verified: true,
      journalId: UUID().uuidString, roleRegistry: wallet.roleRegistry)
    defer { replacement.close() }
    XCTAssertThrowsError(try engine.approve(record: replacement))
    XCTAssertThrowsError(try engine.unlock(record: replacement))
  }

  func testBackendFundingAdmissionUsesExactEnabledNetworksAndOnly404FallsBackToMonad() throws {
    XCTAssertEqual(
      try SwapFundingServices.enabledChains(
        status: 200, body: #"{"fundingContractVersion":2,"fundingChainIds":[143]}"#), [143])
    XCTAssertEqual(
      try SwapFundingServices.enabledChains(
        status: 200, body: #"{"fundingContractVersion":2,"fundingChainIds":[8453,42161]}"#),
      [8453, 42161])
    XCTAssertEqual(try SwapFundingServices.enabledChains(status: 404, body: "legacy"), [143])
    for body in [
      #"{"fundingContractVersion":1,"fundingChainIds":[143]}"#,
      #"{"fundingContractVersion":2,"fundingChainIds":[]}"#,
      #"{"fundingContractVersion":2,"fundingChainIds":[143,143]}"#,
      #"{"fundingContractVersion":2,"fundingChainIds":[1]}"#,
      #"{"fundingContractVersion":2,"fundingChainIds":["143"]}"#, "unavailable",
    ] {
      XCTAssertThrowsError(try SwapFundingServices.enabledChains(status: 200, body: body))
    }
    XCTAssertThrowsError(try SwapFundingServices.enabledChains(status: 0, body: ""))
    XCTAssertThrowsError(
      try SwapFundingServices.enabledChains(
        status: 503, body: #"{"fundingContractVersion":2,"fundingChainIds":[143]}"#))
  }

  func testSavedSignedFundingAdoptsStickyOwnershipBeforeCancelAndResume() async throws {
    for missingEntry in [false, true] {
      let (store, wallet, saved, original) = try completedParent(secondSource: false)
      defer { wallet.close() }
      let first = original.sources[0]
      let ledger = FundingReservations(store: store, record: wallet)
      try ledger.complete(
        parentId: original.operationId, sourceId: first.sourceId, operationId: first.operationId!)
      try ledger.reserve(
        parentId: original.operationId,
        sources: [
          [
            "sourceId": first.sourceId, "sourceChainId": first.sourceChainId, "token": first.token,
            "address": first.address, "budgetAtoms": first.budgetAtoms,
            "balanceAtoms": first.balanceAtoms,
          ]
        ])
      if missingEntry { try ledger.releaseUnsigned(parentId: original.operationId) }
      // The exact native signed state reached disk before the sticky ledger update.
      var crashed = original
      crashed.sources[0].creditedAtoms = nil
      try saved.saveBatch(crashed, state: first.state!, fundingAddress: first.address)
      let restored = StoredSwapEngine(
        storage: store, saved: saved, gateway: gateway,
        transport: { _, _, _ in
          XCTFail("Completed native credit must not be queried again")
          return (0, "")
        })
      try restored.restore()
      XCTAssertEqual(try ledger.reservedAtoms(chainId: 143, owner: first.address), "2000000")
      XCTAssertNoThrow(try restored.cancel())
      XCTAssertEqual(try ledger.reservedAtoms(chainId: 143, owner: first.address), "2000000")
      try restored.retry()
      _ = try await restored.advance()
      XCTAssertEqual(try restored.view()["phase"] as? String, "CANCELLED")
      XCTAssertEqual(try ledger.reservedAtoms(chainId: 143, owner: first.address), "0")
      let batch = try saved.load()!["batch"] as! [String: Any]
      XCTAssertNil(batch["downstreamState"])
      let replayed = try swapObject((batch["sources"] as! [[String: Any]])[0]["state"] as! String)
      let before = try swapObject(first.state!)
      let replayedData = replayed["data"] as! [String: Any]
      let beforeData = before["data"] as! [String: Any]
      XCTAssertEqual(replayed["id"] as? String, before["id"] as? String)
      XCTAssertEqual(
        replayedData["signedOperation"] as? NSArray, beforeData["signedOperation"] as? NSArray)
      XCTAssertEqual(
        replayedData["privateBaseline"] as? String, beforeData["privateBaseline"] as? String)
      XCTAssertEqual(
        replayedData["fundingQuote"] as? NSDictionary, beforeData["fundingQuote"] as? NSDictionary)
      XCTAssertEqual(replayedData["available"] as? String, beforeData["available"] as? String)
    }
  }

  func testRestoredConfirmedCreditSuppressesOnlyItsOldSourceCache() throws {
    let (store, wallet, saved, original) = try completedParent(secondSource: false)
    defer { wallet.close() }
    let source = original.sources[0]
    let other = "0x2000000000000000000000000000000000000002"
    let cache = FundingPortfolioCache(
      store: store, walletId: wallet.id, generation: wallet.journalId)
    try cache.save(
      FundingNetworkSnapshot(
        balances: [source.address.lowercased(): "2000000", other: "3000000"], checkedAt: 100,
        block: "0x1"), chain: 143)
    try cache.save(
      FundingNetworkSnapshot(
        balances: [source.address.lowercased(): "4000000"], checkedAt: 100, block: "0x1"),
      chain: 8453)
    let restored = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try restored.restore()
    XCTAssertNil(try cache.load(chain: 143)?.balances[source.address.lowercased()])
    XCTAssertEqual(try cache.load(chain: 143)?.balances[other], "3000000")
    XCTAssertEqual(try cache.load(chain: 143)?.invalidated, true)
    XCTAssertEqual(try cache.load(chain: 8453)?.balances[source.address.lowercased()], "4000000")
    XCTAssertEqual(try cache.load(chain: 8453)?.invalidated, false)
    // A later confirmed source deposit is a new observation, independent of this old credit.
    try cache.save(
      FundingNetworkSnapshot(
        balances: [source.address.lowercased(): "1000000"], checkedAt: 200, block: "0x2"),
      chain: 143)
    let resumed = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try resumed.restore()
    XCTAssertEqual(try cache.load(chain: 143)?.balances[source.address.lowercased()], "1000000")
    XCTAssertEqual(try cache.load(chain: 143)?.invalidated, false)
  }

  func testOneSufficientArbitrumSourceIsPreferredToTwoSmallerNetworks() async throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    let owner = try deriveAccountAddressRange(entropy: wallet.entropy, start: 1, count: 1)[0]
    var api = services("0", owner: owner)
    let read = api.sources
    api.sources = { storage in
      var rows = try await read(storage)
      rows.append([
        "sourceChainId": 42161, "token": try fundingUsdc(42161), "decimals": 6, "accountIndex": 1,
        "owner": owner, "balanceAtoms": "20000000", "complete": true, "stale": false,
      ])
      return rows
    }
    let saved = StoredSwapFile(store: store, record: wallet)
    let engine = StoredSwapEngine(storage: store, saved: saved, gateway: gateway)
    try await engine.startFunding(
      record: wallet, target: target, amountAtoms: "15000000", chainId: 4663, services: api)
    let batch = try saved.load()!["batch"] as! [String: Any]
    let sources = batch["sources"] as! [[String: Any]]
    XCTAssertEqual(sources.count, 1)
    XCTAssertEqual(sources.first?["sourceChainId"] as? Int, 42161)
    XCTAssertEqual(sources.first?["budgetAtoms"] as? String, "15000000")
  }

}
