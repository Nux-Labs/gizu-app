import XCTest

@testable import GizuStoredSignerNative

final class AuthorizationLifetimeTests: XCTestCase {
  func testReadGrantRequiresTheSameWalletGenerationAndRevokesWithoutSpendingAuthority() throws {
    var grant = AuthorizationLifetime.PrivateReadGrant(
      walletId: "wallet", generation: "generation", now: 100)
    try grant.check(
      walletId: "wallet", generation: "generation", now: 101, active: true, protected: true)
    XCTAssertThrowsError(
      try grant.check(
        walletId: "other", generation: "generation", now: 101, active: true, protected: true))
    XCTAssertThrowsError(
      try grant.check(
        walletId: "wallet", generation: "restored", now: 101, active: true, protected: true))
    XCTAssertThrowsError(
      try grant.check(
        walletId: "wallet", generation: "generation", now: 101, active: false, protected: true))
    XCTAssertThrowsError(
      try grant.check(
        walletId: "wallet", generation: "generation", now: 101, active: true, protected: false))
    XCTAssertThrowsError(
      try grant.check(
        walletId: "wallet", generation: "generation", now: 1000, active: true, protected: true))
    grant.revoke()
    XCTAssertThrowsError(
      try grant.check(
        walletId: "wallet", generation: "generation", now: 102, active: true, protected: true))
  }

  func testSwapWindowRemainsBoundedAndCancels() throws {
    var lifetime = AuthorizationLifetime(now: 100, window: .swap)
    try lifetime.check(now: 221, active: true, protected: true)
    try lifetime.check(now: 999, active: true, protected: true)
    XCTAssertThrowsError(try lifetime.check(now: 1000, active: true, protected: true))
    lifetime.cancel()
    XCTAssertThrowsError(try lifetime.check(now: 222, active: true, protected: true))
  }

  func testAuthorityExpiresAndNeverRevivesAfterCancel() throws {
    var lifetime = AuthorizationLifetime(now: 100)
    try lifetime.check(now: 219, active: true, protected: true)
    XCTAssertThrowsError(try lifetime.check(now: 220, active: true, protected: true))
    XCTAssertThrowsError(try lifetime.check(now: 101, active: false, protected: true))
    XCTAssertThrowsError(try lifetime.check(now: 101, active: true, protected: false))
    lifetime.cancel()
    XCTAssertThrowsError(try lifetime.check(now: 102, active: true, protected: true))
  }
}
