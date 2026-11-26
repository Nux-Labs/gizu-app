import XCTest

@testable import GizuStoredSignerNative

final class MainnetPortfolioTests: WalletTestCase {
  func testPrivateCashIsIncludedOnceAlongsidePublicFundingAndPrivateOnlyCash() async throws {
    for (publicAmount, privateAmount) in [(UInt64(10_000_000), "5000000"), (UInt64(0), "15000000")]
    {
      let store = try storage()
      let wallet = try record(verified: true)
      defer { wallet.close() }
      try store.create(wallet)
      var reads = 0
      let snapshot = try await MainnetPortfolio(
        rpc: ChainPortfolioRPC(chain: 143, amount: publicAmount),
        fundingRPC: { ChainPortfolioRPC(chain: $0, amount: $0 == 143 ? publicAmount : 0) },
        privateBalance: { record in
          reads += 1
          return [
            "confidentialAddress": try deriveAccountAddresses(entropy: record.entropy)[2],
            "assetId": "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
            "available": privateAmount, "timestampMs": 123, "authenticated": true,
            "operationScoped": false,
          ]
        }, clock: { 123 }
      ).read(store: store)
      let rows = snapshot["ownedAssets"] as? [[String: Any]] ?? []
      let privateRows = rows.filter { $0["token"] as? String == "confidential:monad-usdc" }
      XCTAssertEqual(privateRows.count, 1)
      XCTAssertEqual(privateRows.first?["balanceAtoms"] as? String, privateAmount)
      XCTAssertEqual(privateRows.first?["complete"] as? Bool, true)
      XCTAssertEqual(reads, 1)
      let publicAtoms =
        (snapshot["fundingCash"] as? [String: Any])?["availableAtoms"] as? String ?? "0"
      XCTAssertEqual(
        try FundingAtoms.add(publicAtoms, privateRows.first?["balanceAtoms"] as? String ?? "0"),
        "15000000")
      XCTAssertEqual((snapshot["fundingSources"] as? [[String: Any]])?.count, 3)
    }
  }

  func testMissingPrivateReadPermissionPublishesUnknownCashInsteadOfZero() async throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    let snapshot = try await MainnetPortfolio(
      rpc: ChainPortfolioRPC(chain: 143, amount: 0),
      fundingRPC: { ChainPortfolioRPC(chain: $0, amount: 0) }, clock: { 123 }
    ).read(store: store)
    let row = (snapshot["ownedAssets"] as? [[String: Any]])?.first
    XCTAssertEqual(row?["token"] as? String, "confidential:monad-usdc")
    XCTAssertTrue(row?["balanceAtoms"] is NSNull)
    XCTAssertEqual(row?["complete"] as? Bool, false)
    XCTAssertEqual(row?["stale"] as? Bool, true)
  }

  func testRevokedPrivateReadCannotPublishOrCacheTheReturnedObservation() async throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    var permitted = true
    let snapshot = try await MainnetPortfolio(
      rpc: ChainPortfolioRPC(chain: 143, amount: 0),
      fundingRPC: { ChainPortfolioRPC(chain: $0, amount: 0) },
      privateBalance: { identity in
        permitted = false
        return [
          "confidentialAddress": try deriveAccountAddresses(entropy: identity.entropy)[2],
          "assetId": "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
          "available": "15000000", "timestampMs": 123, "authenticated": true,
          "operationScoped": false,
        ]
      }, privateReadAuthority: { try require(permitted) }, clock: { 123 }
    ).read(store: store)
    let row = (snapshot["ownedAssets"] as? [[String: Any]])?.first
    XCTAssertTrue(row?["balanceAtoms"] is NSNull)
    XCTAssertEqual(row?["complete"] as? Bool, false)
    let cache = FundingPortfolioCache(
      store: store, walletId: wallet.id, generation: wallet.journalId)
    XCTAssertEqual(try cache.load(chain: 0)?.balances.count, 0)
  }

  func testDeniedPrivateReadUsesOnlyStaleCacheAndNeverCallsTheAuthenticator() async throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    let address = try deriveAccountAddresses(entropy: wallet.entropy)[2].lowercased()
    let cache = FundingPortfolioCache(
      store: store, walletId: wallet.id, generation: wallet.journalId)
    try cache.save(
      FundingNetworkSnapshot(balances: [address: "5000000"], checkedAt: 122, block: "private"),
      chain: 0)
    var reads = 0
    let snapshot = try await MainnetPortfolio(
      rpc: ChainPortfolioRPC(chain: 143, amount: 0),
      fundingRPC: { ChainPortfolioRPC(chain: $0, amount: 0) },
      privateBalance: { _ in
        reads += 1
        throw WalletFailure.invalid
      }, privateReadAuthority: { throw WalletFailure.unavailable }, clock: { 123 }
    ).read(store: store)
    let row = (snapshot["ownedAssets"] as? [[String: Any]])?.first
    XCTAssertEqual(reads, 0)
    XCTAssertEqual(row?["observedAtoms"] as? String, "5000000")
    XCTAssertTrue(row?["balanceAtoms"] is NSNull)
    XCTAssertEqual(row?["complete"] as? Bool, false)
    XCTAssertEqual(row?["stale"] as? Bool, true)
  }

  func fixture() throws -> [String: Any] {
    let url = Bundle.module.url(
      forResource: "public-portfolio", withExtension: "json", subdirectory: "Fixtures")!
    return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
  }

  func testBothPlatformBindingsUseIdenticalFinancialFixtures() async throws {
    let fixture = try fixture()
    let registry = fixture["registry"] as! String
    let accounts = try await MainnetPortfolio.accounts(
      entropy: Data(repeating: 0, count: 32), registry: registry)
    let expectedAccounts = fixture["accounts"] as! [[String: Any]]
    XCTAssertEqual(accounts.map(\.accountIndex), [0, 1, 3, 4, 5])
    XCTAssertEqual(accounts.map(\.address), expectedAccounts.map { $0["address"] as! String })
    for item in fixture["cases"] as! [[String: Any]] {
      let amounts = item["balances"] as! [Any]
      let observations = zip(accounts, amounts).map {
        PortfolioObservation(account: $0.0, balanceAtoms: $0.1 as? String)
      }
      let snapshot = try buildPublicPortfolio(
        walletId: "portfolio-fixture", registry: registry, observations: observations,
        state: PortfolioReadState(
          checkedAt: 1_790_000_000_000, block: "0x123", complete: item["complete"] as! Bool,
          stale: item["stale"] as! Bool, syncPending: item["syncPending"] as! Bool))
      var value = snapshot.publicValue
      value.removeValue(forKey: "history")
      XCTAssertEqual(
        value as NSDictionary, item["expected"] as! NSDictionary, item["name"] as! String)
    }
  }

  func testReadUsesOneCanonicalBlockAndNoSigningOrStorageWrites() async throws {
    let store = try storage()
    let record = try record(verified: true)
    defer { record.close() }
    try store.create(record)
    let before = try store.files.read("wallet.enc", limit: WalletLimits.walletRecordBytes)
    let rpc = FakePortfolioRPC()
    let snapshot = try await MainnetPortfolio(
      rpc: rpc,
      fundingRPC: { chain in
        if chain == 143 { return rpc }
        return ChainPortfolioRPC(chain: chain, amount: 0)
      },
      clock: { 123 }
    ).read(store: store)
    XCTAssertEqual(snapshot["totalAtoms"] as? String, "14")
    XCTAssertEqual(snapshot["fundingAtoms"] as? String, "7")
    XCTAssertEqual(snapshot["returnAtoms"] as? String, "7")
    XCTAssertEqual(snapshot["balanceComplete"] as? Bool, true)
    XCTAssertEqual(
      try store.files.read("wallet.enc", limit: WalletLimits.walletRecordBytes), before)
  }

  func testAbsentUnverifiedAndCorruptWalletsNeverCreateReplacement() async throws {
    for mode in 0..<3 {
      let store = try storage()
      if mode > 0 {
        let record = try record()
        defer { record.close() }
        try store.create(record)
      }
      if mode == 2 { try store.files.write("wallet.enc", bytes: Data([0, 1])) }
      do {
        _ = try await MainnetPortfolio(rpc: FakePortfolioRPC()).read(store: store)
        XCTFail("unusable wallet accepted")
      } catch {}
      XCTAssertEqual(store.state(), ["absent", "backupRequired", "recoveryRequired"][mode])
    }
  }

  func testWrongChainMalformedBalanceReorgAndRPCFailureRejectWholeSnapshot() async throws {
    for failure in ["chain", "balance", "reorg", "rpc"] {
      let store = try storage()
      let record = try record(verified: true)
      defer { record.close() }
      try store.create(record)
      do {
        let accounts = try await MainnetPortfolio.accounts(
          entropy: record.entropy, registry: record.roleRegistry)
        _ = try await MainnetPortfolio(rpc: FakePortfolioRPC(failure: failure)).read(
          walletId: record.id, registry: record.roleRegistry, accounts: accounts)
        XCTFail("accepted \(failure)")
      } catch {}
    }
  }

  func testCancellationStopsReads() async throws {
    let store = try storage()
    let record = try record(verified: true)
    defer { record.close() }
    try store.create(record)
    let task = Task {
      try await MainnetPortfolio(rpc: FakePortfolioRPC(failure: "wait")).read(store: store)
    }
    task.cancel()
    do {
      _ = try await task.value
      XCTFail("cancelled result published")
    } catch { XCTAssertTrue(error is CancellationError) }
  }

  func testMaximumRegistryUsesBoundedBatchesWithoutPartialResults() async throws {
    let registry = "{\"version\":1,\"nextRecipient\":8192}"
    let accounts = try await MainnetPortfolio.accounts(
      entropy: Data(repeating: 0, count: 32), registry: registry)
    let rpc = CountingPortfolioRPC()
    let result = try await MainnetPortfolio(rpc: rpc).read(
      walletId: "limit", registry: registry, accounts: accounts)
    XCTAssertEqual(result.accounts.count, 8191)
    XCTAssertEqual(result.totalAtoms, "57337")
    let (maximum, count) = await rpc.counts()
    XCTAssertLessThanOrEqual(maximum, 4)
    XCTAssertEqual(count, 8191)
  }

  func testFundingCashReadsThreeNativeTokensAndKeepsLegacyMonadTotal() async throws {
    let store = try storage()
    let record = try record(verified: true)
    defer { record.close() }
    try store.create(record)
    let portfolio = MainnetPortfolio(
      rpc: ChainPortfolioRPC(chain: 143, amount: 10_000_000),
      fundingRPC: { ChainPortfolioRPC(chain: $0, amount: $0 == 42161 ? 5_000_000 : 10_000_000) },
      clock: { 123 })
    let snapshot = try await portfolio.read(store: store)
    XCTAssertEqual(snapshot["totalAtoms"] as? String, "20000000")
    let cash = snapshot["fundingCash"] as? [String: Any]
    XCTAssertEqual(cash?["observedAtoms"] as? String, "25000000")
    XCTAssertEqual(cash?["availableAtoms"] as? String, "25000000")
    XCTAssertEqual(
      (snapshot["fundingSources"] as? [[String: Any]])?.map { $0["sourceChainId"] as! Int },
      [143, 8453, 42161])
  }

  func testFailedSourceRetainsItsCacheWhileOtherChainsRefresh() async throws {
    let store = try storage()
    let record = try record(verified: true)
    defer { record.close() }
    try store.create(record)
    let initial = MainnetPortfolio(
      rpc: ChainPortfolioRPC(chain: 143, amount: 10_000_000),
      fundingRPC: { ChainPortfolioRPC(chain: $0, amount: 10_000_000) }, clock: { 100_000 })
    _ = try await initial.read(store: store)
    let changed = MainnetPortfolio(
      rpc: ChainPortfolioRPC(chain: 143, amount: 5_000_000),
      fundingRPC: { ChainPortfolioRPC(chain: $0, amount: 5_000_000, failed: $0 == 8453) },
      clock: { 131_000 })
    let snapshot = try await changed.read(store: store)
    let cash = snapshot["fundingCash"] as? [String: Any]
    XCTAssertEqual(cash?["observedAtoms"] as? String, "20000000")
    XCTAssertTrue(cash?["availableAtoms"] is NSNull)
    XCTAssertEqual(cash?["complete"] as? Bool, false)
    let base = (snapshot["fundingSources"] as! [[String: Any]])[1]
    XCTAssertEqual(base["observedAtoms"] as? String, "10000000")
    XCTAssertTrue(base["balanceAtoms"] is NSNull)
    XCTAssertEqual(base["stale"] as? Bool, true)
  }

  func testInvalidationBypassesFreshCacheAndRetainsReservationObservation() async throws {
    let store = try storage()
    let record = try record(verified: true)
    defer { record.close() }
    try store.create(record)
    let initial = MainnetPortfolio(
      rpc: FakePortfolioRPC(),
      fundingRPC: { ChainPortfolioRPC(chain: $0, amount: 10_000_000) }, clock: { 100_000 })
    _ = try await initial.read(store: store)
    let changed = MainnetPortfolio(
      rpc: FakePortfolioRPC(),
      fundingRPC: { ChainPortfolioRPC(chain: $0, amount: 5_000_000) },
      reservedAtoms: { chain, _ in chain == 8453 ? "2000000" : "0" }, clock: { 100_001 })
    let cached = try await changed.read(store: store)
    XCTAssertEqual(
      (cached["fundingCash"] as? [String: Any])?["observedAtoms"] as? String, "30000000")
    try MainnetPortfolio.invalidate(store: store)
    let refreshed = try await changed.read(store: store)
    XCTAssertEqual(
      (refreshed["fundingCash"] as? [String: Any])?["observedAtoms"] as? String, "15000000")
    XCTAssertEqual(
      (refreshed["fundingCash"] as? [String: Any])?["availableAtoms"] as? String, "13000000")
  }

  func testFailedForcedRefreshCannotReviveFreshCachedFunds() async throws {
    let store = try storage()
    let record = try record(verified: true)
    defer { record.close() }
    try store.create(record)
    _ = try await MainnetPortfolio(
      rpc: FakePortfolioRPC(),
      fundingRPC: { ChainPortfolioRPC(chain: $0, amount: 10_000_000) }, clock: { 100_000 }
    ).read(store: store)
    let failed = MainnetPortfolio(
      rpc: FakePortfolioRPC(),
      fundingRPC: { ChainPortfolioRPC(chain: $0, amount: 0, failed: true) }, clock: { 100_001 })
    _ = try await failed.read(store: store, forceRefresh: true)
    let later = try await failed.read(store: store)
    XCTAssertEqual((later["fundingCash"] as? [String: Any])?["complete"] as? Bool, false)
    XCTAssertTrue((later["fundingCash"] as? [String: Any])?["availableAtoms"] is NSNull)
    XCTAssertEqual(
      (later["fundingCash"] as? [String: Any])?["observedAtoms"] as? String, "30000000")
  }

  func testConfirmedFundingCreditSuppressesOnlyItsPreCreditSourceWhenRPCFails() async throws {
    let store = try storage()
    let record = try record(verified: true)
    defer { record.close() }
    try store.create(record)
    let accounts = try await MainnetPortfolio.accounts(
      entropy: record.entropy, registry: record.roleRegistry)
    let owner = accounts.first { $0.accountIndex == 1 }!.address
    let initial = MainnetPortfolio(
      rpc: FakePortfolioRPC(),
      fundingRPC: {
        ChainPortfolioRPC(chain: $0, amount: $0 == 143 ? 10_000_000 : $0 == 8453 ? 25_000_000 : 0)
      }, clock: { 100_000 })
    _ = try await initial.read(store: store)
    try MainnetPortfolio.invalidateConfirmedFunding(store: store, sourceChainId: 143, owner: owner)
    let failed = MainnetPortfolio(
      rpc: FakePortfolioRPC(),
      fundingRPC: { ChainPortfolioRPC(chain: $0, amount: 0, failed: true) }, clock: { 100_001 })
    let snapshot = try await failed.read(store: store)
    let rows = snapshot["fundingSources"] as! [[String: Any]]
    let source = rows.first { $0["sourceChainId"] as? Int == 143 }!
    XCTAssertTrue(source["balanceAtoms"] is NSNull)
    XCTAssertTrue(source["observedAtoms"] is NSNull)
    XCTAssertEqual(
      rows.first { $0["sourceChainId"] as? Int == 8453 }?["observedAtoms"] as? String, "25000000")
    XCTAssertEqual(
      (snapshot["fundingCash"] as? [String: Any])?["observedAtoms"] as? String, "25000000")
    XCTAssertEqual((snapshot["fundingCash"] as? [String: Any])?["complete"] as? Bool, false)
    // A later canonical read may verify zero; failure above never manufactures one.
    let fresh = try await MainnetPortfolio(
      rpc: FakePortfolioRPC(),
      fundingRPC: {
        ChainPortfolioRPC(chain: $0, amount: $0 == 143 ? 0 : $0 == 8453 ? 25_000_000 : 0)
      }, clock: { 100_002 }
    ).read(store: store)
    XCTAssertEqual(
      (fresh["fundingSources"] as! [[String: Any]]).first { $0["sourceChainId"] as? Int == 143 }?[
        "balanceAtoms"] as? String, "0")
  }

  func testRPCValidatesBatchIdentityAndRestoresRequestOrder() async throws {
    let requests = [
      PortfolioRequest(method: "eth_chainId", params: []),
      PortfolioRequest(method: "eth_blockNumber", params: []),
    ]
    let good: [[String: Any]] = [
      ["jsonrpc": "2.0", "id": 2, "result": "0x123"],
      ["jsonrpc": "2.0", "id": 1, "result": "0x8f"],
    ]
    let transport = NativeMainnetPortfolioRPC(post: { _ in
      try JSONSerialization.data(withJSONObject: good)
    })
    let result = try await transport.calls(requests)
    XCTAssertEqual(result as? [String], ["0x8f", "0x123"])
    var variants = [[good[0]], [good[0], good[0]]]
    for (key, value) in [
      ("id", true as Any), ("id", "1"), ("id", 1.5), ("id", 3), ("jsonrpc", "1.0"),
      ("error", ["code": -1]), ("result", NSNull()),
    ] {
      var rows = good
      rows[1][key] = value
      variants.append(rows)
    }
    for rows in variants {
      let rpc = NativeMainnetPortfolioRPC(post: { _ in
        try JSONSerialization.data(withJSONObject: rows)
      })
      do {
        _ = try await rpc.calls(requests)
        XCTFail("invalid batch accepted")
      } catch {}
    }
    let timedOut = NativeMainnetPortfolioRPC(post: { _ in throw URLError(.timedOut) })
    do {
      _ = try await timedOut.calls(requests)
      XCTFail("timeout accepted")
    } catch { XCTAssertEqual((error as? URLError)?.code, .timedOut) }
  }

  func testObservationDeadlineCancelsSlowSourceWithoutChangingTransportPolicy() async throws {
    let rpc = BudgetedPortfolioRPC(
      upstream: FakePortfolioRPC(failure: "wait"), totalMilliseconds: 100, requestMilliseconds: 1)
    do {
      _ = try await rpc.calls([PortfolioRequest(method: "eth_chainId", params: [])])
      XCTFail("slow observation accepted")
    } catch { XCTAssertEqual((error as? URLError)?.code, .timedOut) }
  }
}

private struct ChainPortfolioRPC: MainnetPortfolioRPC {
  let chain: Int
  let amount: UInt64
  var failed = false
  func calls(_ requests: [PortfolioRequest]) async throws -> [Any] {
    if failed { throw URLError(.notConnectedToInternet) }
    return try requests.map { request in
      switch request.method {
      case "eth_chainId": return "0x" + String(chain, radix: 16)
      case "eth_getBlockByNumber":
        return ["number": "0x123", "hash": "0x" + String(repeating: "a", count: 64)]
      case "eth_call":
        let expected: String
        switch chain {
        case 143: expected = "0x754704bc059f8c67012fed69bc8a327a5aafb603"
        case 8453: expected = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
        default: expected = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"
        }
        XCTAssertEqual((request.params[0] as? [String: String])?["to"], expected)
        let value = String(amount, radix: 16)
        return "0x" + String(repeating: "0", count: 64 - value.count) + value
      default: throw WalletFailure.invalid
      }
    }
  }
}

private actor CountingPortfolioRPC: MainnetPortfolioRPC {
  var active = 0
  var maximum = 0
  var count = 0
  func counts() -> (Int, Int) { (maximum, count) }
  func calls(_ requests: [PortfolioRequest]) async throws -> [Any] {
    XCTAssertLessThanOrEqual(requests.count, 40)
    active += 1
    maximum = max(maximum, active)
    count += requests.filter { $0.method == "eth_call" }.count
    defer { active -= 1 }
    await Task.yield()
    return try await FakePortfolioRPC().calls(requests)
  }
}

private struct FakePortfolioRPC: MainnetPortfolioRPC {
  var failure = ""
  func calls(_ requests: [PortfolioRequest]) async throws -> [Any] {
    if failure == "wait" { try await Task.sleep(nanoseconds: 60_000_000_000) }
    if failure == "rpc" { throw URLError(.notConnectedToInternet) }
    return try requests.map { request in
      switch request.method {
      case "eth_chainId": return failure == "chain" ? "0x1" : "0x8f"
      case "eth_getBlockByNumber":
        let reorg = failure == "reorg" && request.params[0] as? String != "finalized"
        return ["number": "0x123", "hash": "0x" + String(repeating: reorg ? "b" : "a", count: 64)]
      case "eth_call":
        let selector = request.params[1] as! [String: Any]
        XCTAssertEqual(selector["blockHash"] as? String, "0x" + String(repeating: "a", count: 64))
        XCTAssertEqual(selector["requireCanonical"] as? Bool, true)
        XCTAssertEqual((request.params[0] as! [String: String])["to"], MainnetPortfolio.usdc)
        return failure == "balance" ? "0x7" : "0x" + String(repeating: "0", count: 63) + "7"
      default:
        XCTFail("Unexpected method \(request.method)")
        throw WalletFailure.invalid
      }
    }
  }
}
