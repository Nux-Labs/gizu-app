import XCTest

@testable import GizuStoredSignerNative

final class FundingReservationsTests: WalletTestCase {
  private let owner = "0x1000000000000000000000000000000000000001"
  private func source(_ chain: Int, budget: String = "8000000") throws -> [String: Any] {
    [
      "sourceId": "\(chain):\(owner)", "sourceChainId": chain, "token": try fundingUsdc(chain),
      "address": owner, "budgetAtoms": budget, "balanceAtoms": "10000000",
    ]
  }
  func testPruningOnlyReleasesUnsignedParentsAbsentFromTheAuthenticatedCurrentBatch() throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    let ledger = FundingReservations(store: store, record: wallet)
    try ledger.reserve(parentId: "active", sources: [source(143)])
    try ledger.reserve(parentId: "orphan", sources: [source(8453)])
    try ledger.reserve(parentId: "signed", sources: [source(42161)])
    try ledger.markSigned(parentId: "signed", sourceId: "42161:\(owner)", operationId: "saved")
    try ledger.pruneOrphanUnsigned(activeParentIds: ["active"])
    XCTAssertEqual(try ledger.reservedAtoms(chainId: 143, owner: owner), "8000000")
    XCTAssertEqual(try ledger.reservedAtoms(chainId: 8453, owner: owner), "0")
    XCTAssertEqual(try ledger.reservedAtoms(chainId: 42161, owner: owner), "8000000")
  }

  func testSameAddressDifferentNetworksAndConcurrentParentsCannotOverbook() throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    let a = FundingReservations(store: store, record: wallet)
    let b = FundingReservations(store: store, record: wallet)
    try a.reserve(parentId: "first", sources: [source(8453)])
    XCTAssertEqual(try b.reservedAtoms(chainId: 143, owner: owner), "0")
    XCTAssertEqual(try b.reservedAtoms(chainId: 8453, owner: owner), "8000000")
    XCTAssertThrowsError(try b.reserve(parentId: "second", sources: [source(8453)]))
    try b.reserve(parentId: "second", sources: [source(143)])
    XCTAssertEqual(try a.reservedAtoms(chainId: 143, owner: owner), "8000000")
  }
  func testSignedOwnershipSurvivesRestartAndCancellation() throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    let ledger = FundingReservations(store: store, record: wallet)
    try ledger.reserve(parentId: "parent", sources: [source(42161)])
    try ledger.markSigned(parentId: "parent", sourceId: "42161:\(owner)", operationId: "signed")
    let restored = FundingReservations(store: store, record: wallet)
    try restored.releaseUnsigned(parentId: "parent")
    XCTAssertEqual(try restored.reservedAtoms(chainId: 42161, owner: owner), "8000000")
    XCTAssertThrowsError(
      try restored.markSigned(
        parentId: "parent", sourceId: "42161:\(owner)", operationId: "changed"))
    try restored.complete(parentId: "parent", sourceId: "42161:\(owner)", operationId: "signed")
    XCTAssertEqual(try ledger.reservedAtoms(chainId: 42161, owner: owner), "0")
  }
  func testSavedSignatureAdoptionRejectsChangedOwnershipBudgetAndReplay() throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    let ledger = FundingReservations(store: store, record: wallet)
    try ledger.reserve(parentId: "parent", sources: [source(8453)])
    try ledger.adoptSigned(
      parentId: "parent", sourceId: "8453:\(owner)", chainId: 8453, token: fundingUsdc(8453),
      owner: owner, budgetAtoms: "8000000", operationId: "signed")
    for mutation in 0..<5 {
      XCTAssertThrowsError(
        try ledger.adoptSigned(
          parentId: mutation == 4 ? "other" : "parent", sourceId: "8453:\(owner)",
          chainId: mutation == 0 ? 143 : 8453, token: fundingUsdc(mutation == 0 ? 143 : 8453),
          owner: mutation == 1 ? "0x2000000000000000000000000000000000000002" : owner,
          budgetAtoms: mutation == 2 ? "7000000" : "8000000",
          operationId: mutation == 3 ? "changed" : "signed"))
    }
    try ledger.releaseUnsigned(parentId: "parent")
    XCTAssertEqual(try ledger.reservedAtoms(chainId: 8453, owner: owner), "8000000")
    XCTAssertEqual(try ledger.reservedAtoms(chainId: 143, owner: owner), "0")
  }

}
