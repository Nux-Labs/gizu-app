import CryptoKit
import XCTest

@testable import GizuStoredSignerNative

final class WalletStorageTests: WalletTestCase {
  func testEarnBindingIsImmutableDurableAndRestoreRequiresReconciliation() throws {
    let store = try storage()
    let wallet = try record(verified: true)
    defer { wallet.close() }
    try store.create(wallet)
    try store.bindEarnChain(wallet, chain: 1)
    let committed = try store.load()
    defer { committed.close() }
    XCTAssertEqual(committed.earnChain, 1)
    XCTAssertEqual(try storedEarnConfidentialAddress(committed),
      try deriveAccountAddresses(entropy: committed.entropy)[2])
    XCTAssertFalse(committed.earnRecoveryRequired)
    XCTAssertEqual(committed.entropy, wallet.entropy)
    try store.bindEarnChain(committed, chain: 1)
    XCTAssertThrowsError(try store.bindEarnChain(committed, chain: 4663))
    XCTAssertThrowsError(try store.bindEarnChain(committed, chain: 143))
    try store.files.write("wallet.enc", bytes: Data([1]))
    try store.restore(wallet)
    let recovered = try store.load()
    defer { recovered.close() }
    XCTAssertTrue(recovered.earnRecoveryRequired)
    XCTAssertEqual(recovered.earnChain, 0)
    try store.bindEarnChain(recovered, chain: 1)
    let bound = try store.load()
    defer { bound.close() }
    XCTAssertEqual(bound.earnChain, 1)
    XCTAssertTrue(bound.earnRecoveryRequired)
    try store.bindEarnChain(bound, chain: 4663)
    let alternate = try store.load()
    defer { alternate.close() }
    XCTAssertEqual(alternate.earnChain, 4663)
    XCTAssertTrue(alternate.earnRecoveryRequired)
  }

  func testRegistryUpdatesAndRecoveryPreserveEarnCatalogue() throws {
    let store = try storage()
    let wallet = try WalletRecord(id: id, credential: credential(), entropy: Data(repeating: 0, count: 32),
      verified: true, roleRegistry: #"{"version":1,"nextRecipient":7}"#,
      earnChain: 1, earnCycleIndex: 2,
      earnCycles: #"[{"cycleIndex":2,"chainId":1,"intentId":"fixture","withdrawalIndex":6}]"#)
    defer { wallet.close() }
    try store.create(wallet)
    try store.persistRegistry(#"{"version":1,"nextRecipient":8}"#, expectedId: wallet.id)
    let updated = try store.load()
    defer { updated.close() }
    XCTAssertEqual(updated.earnChain, 1)
    XCTAssertEqual(updated.earnCycleIndex, 2)
    XCTAssertEqual(updated.earnCycles, wallet.earnCycles)
    XCTAssertThrowsError(try store.persistRegistry(#"{"version":1,"nextRecipient":7}"#, expectedId: wallet.id))
    try store.files.write("wallet.enc", bytes: Data([1]))
    try store.restore(updated)
    let recovered = try store.load()
    defer { recovered.close() }
    XCTAssertEqual(try registryNext(recovered.roleRegistry), 8)
    XCTAssertEqual(recovered.earnChain, 1)
    XCTAssertEqual(recovered.earnCycleIndex, 2)
    XCTAssertEqual(recovered.earnCycles, wallet.earnCycles)
    XCTAssertTrue(recovered.earnRecoveryRequired)
  }

  func testLegacyStorageVersionsDefaultMissingEarnMetadata() throws {
    for version in [1, 2] {
      let keys = Keys()
      let store = try storage(keys)
      let wallet = try record(verified: true)
      defer { wallet.close() }
      let credential = try JSONSerialization.jsonObject(with: JSONEncoder().encode(wallet.credential))
      var metadata: [String: Any] = ["version": version, "id": wallet.id,
        "journalId": wallet.journalId, "credential": credential, "verified": true]
      if version == 2 { metadata["roleRegistry"] = #"{"version":1,"nextRecipient":5}"# }
      var clear = try JSONSerialization.data(withJSONObject: metadata)
      clear.append(wallet.entropy)
      defer { clear.wipe() }
      let aad = Data("io.gizu.storedwallet.v1:wallet:gizu.io:gizu-stored-evm-v1".utf8)
      try store.files.write("wallet.enc", bytes: WalletEnvelope.encrypt(clear, key: keys.existing()!, aad: aad))
      let loaded = try store.load()
      defer { loaded.close() }
      XCTAssertEqual(try registryNext(loaded.roleRegistry), version == 2 ? 5 : 3)
      XCTAssertEqual(loaded.earnChain, 0)
      XCTAssertEqual(loaded.earnCycleIndex, 0)
      XCTAssertEqual(loaded.earnCycles, "[]")
      try store.save(loaded)
      let migrated = try store.load()
      defer { migrated.close() }
      XCTAssertEqual(migrated.entropy, wallet.entropy)
      XCTAssertEqual(migrated.roleRegistry, loaded.roleRegistry)
    }
  }

  func testStorageDoesNotOverwriteAndMissingKeyRequiresRecovery() throws {
    let keys = Keys()
    let store = try storage(keys)
    let wallet = try record()
    defer { wallet.close() }
    XCTAssertEqual(store.state(), "absent")
    try store.create(wallet)
    XCTAssertEqual(store.state(), "backupRequired")
    XCTAssertThrowsError(try store.create(wallet))
    wallet.verified = true
    try store.save(wallet)
    XCTAssertEqual(store.state(), "ready")
    XCTAssertThrowsError(try store.restore(wallet))
    keys.key = nil
    XCTAssertEqual(store.state(), "recoveryRequired")
    XCTAssertThrowsError(try store.create(wallet))
    XCTAssertNil(keys.key)
    try store.restore(wallet)
    let restored = try store.load()
    defer { restored.close() }
    XCTAssertEqual(restored.entropy, wallet.entropy)
    XCTAssertNotEqual(restored.journalId, wallet.journalId)
  }

  func testCorruptionAndFailedFileCommitPreserveRecoveryState() throws {
    let store = try storage()
    let wallet = try record()
    defer { wallet.close() }
    try store.create(wallet)
    try store.files.write("wallet.enc", bytes: Data([1, 2, 3]))
    XCTAssertEqual(store.state(), "recoveryRequired")
    XCTAssertThrowsError(try store.create(wallet))
    XCTAssertThrowsError(try store.files.write("../escape", bytes: Data([1])))
    XCTAssertThrowsError(
      try store.files.write("wallet.enc", bytes: Data(repeating: 0, count: 4 * 1024 * 1024 + 1)))
    XCTAssertEqual(try store.files.read("wallet.enc"), Data([1, 2, 3]))
  }
}
