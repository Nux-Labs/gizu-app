import XCTest
@testable import GizuStoredSignerNative

final class EarnIntentIdentityTests: WalletTestCase {
  func testSharedPrivateIdentityMatchesAccountTwoAndHistoricalIdentityStaysRecoverable() throws {
    for shared in [false, true] {
      let cycles = shared
        ? #"[{"cycleIndex":7,"chainId":4663,"privateAccount":"shared"}]"#
        : #"[{"cycleIndex":7,"chainId":4663}]"#
      let wallet = try WalletRecord(id: id, credential: credential(),
        entropy: Data(repeating: 0, count: 32), verified: true, earnChain: 4663,
        earnCycleIndex: 7, earnCycles: cycles)
      defer { wallet.close() }
      let expected = shared
        ? try deriveAccountAddresses(entropy: wallet.entropy)[2]
        : try deriveEarnCycleConfidentialAddress(entropy: wallet.entropy, chainId: 4663, cycleIndex: 7)
      XCTAssertEqual(try storedEarnConfidentialAddress(wallet), expected)
    }
  }

  func testLegacyCycleKeepsItsOriginalIdentity() {
    let identity = storedEarnIntentIdentity(walletId: "Wallet-ID", profile: "ethereum-usdc", cycleIndex: 0)
    XCTAssertEqual(identity.version, "gizu-earn-v1")
    XCTAssertEqual(identity.id, "earn-v1:wallet-id:ethereum-usdc")
  }
  func testNewCyclesMatchAndroidContractForBothProfiles() {
    for profile in ["ethereum-usdc", "robinhood-usdg"] {
      let identity = storedEarnIntentIdentity(walletId: "Wallet-ID", profile: profile, cycleIndex: 7)
      XCTAssertEqual(identity.version, "gizu-earn-v2")
      XCTAssertEqual(identity.id, "earn-v2:wallet-id:\(profile):7")
    }
  }
}
