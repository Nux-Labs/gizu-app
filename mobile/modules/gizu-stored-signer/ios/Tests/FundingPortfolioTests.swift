import XCTest

@testable import GizuStoredSignerNative

final class FundingPortfolioTests: XCTestCase {
  private let owner = "0x" + String(repeating: "a", count: 40)
  private func observation(_ chain: Int, _ amount: String?, stale: Bool = false, reserved: String? = "0") -> FundingObservation {
    FundingObservation(sourceChainId: chain, accountIndex: 1, owner: owner, balanceAtoms: amount,
      checkedAt: 123, complete: amount != nil, stale: stale, syncPending: amount == nil, reservedAtoms: reserved)
  }

  func testSameOwnerOnThreeChainsCountsEachNativeUsdcOnce() throws {
    let value = try fundingPortfolio([observation(143, "10000000"), observation(8453, "10000000"), observation(42161, "5000000")])
    let cash = value["fundingCash"] as? [String: Any]
    XCTAssertEqual(cash?["observedAtoms"] as? String, "25000000")
    XCTAssertEqual(cash?["availableAtoms"] as? String, "25000000")
    XCTAssertEqual(cash?["complete"] as? Bool, true)
    XCTAssertEqual((value["fundingSources"] as? [[String: Any]])?.count, 3)
  }

  func testUnavailableSourcePreservesCachedObservationAndPreventsSpendableTotal() throws {
    let value = try fundingPortfolio([observation(143, "10000000"), observation(8453, "10000000", stale: true), observation(42161, nil)])
    let cash = value["fundingCash"] as? [String: Any]
    XCTAssertEqual(cash?["observedAtoms"] as? String, "20000000")
    XCTAssertTrue(cash?["availableAtoms"] is NSNull)
    XCTAssertEqual(cash?["complete"] as? Bool, false)
    let rows = value["fundingSources"] as? [[String: Any]]
    XCTAssertTrue(rows?[2]["balanceAtoms"] is NSNull)
  }

  func testReservationsRemainChainQualifiedAndDuplicateIdentityIsRejected() throws {
    let value = try fundingPortfolio([observation(143, "10000000"), observation(8453, "10000000", reserved: "4000000"), observation(42161, "0")])
    XCTAssertEqual((value["fundingCash"] as? [String: Any])?["availableAtoms"] as? String, "16000000")
    XCTAssertThrowsError(try fundingPortfolio([observation(143, "1"), observation(143, "1")]))
  }

  func testExactUint256AmountsDoNotUseFloatingPoint() throws {
    let value = try fundingPortfolio([observation(143, "9007199254740993"), observation(8453, "10"), observation(42161, "0")])
    XCTAssertEqual((value["fundingCash"] as? [String: Any])?["observedAtoms"] as? String, "9007199254741003")
  }
}
