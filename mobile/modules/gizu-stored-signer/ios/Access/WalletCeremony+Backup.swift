import UIKit

@available(iOS 18.0, *)
@MainActor extension WalletCeremony {
  private func readBackup(_ url: URL) throws -> Data {
    let access = url.startAccessingSecurityScopedResource()
    defer { if access { url.stopAccessingSecurityScopedResource() } }
    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    try require(size > 0 && size <= WalletLimits.backupBytes)
    let data = try Data(contentsOf: url)
    try require(data.count <= WalletLimits.backupBytes)
    return data
  }

  func backup() async throws -> [String: Any] {
    diagnostics.mark("backup-load")
    let record = try store.load()
    let id = record.id
    let credential = record.credential
    record.close()
    diagnostics.mark("backup-review")
    let screen = try await presentWalletUI()
    try await screen.confirm(
      "Back up wallet",
      "Save an encrypted backup, then reopen it to verify recovery. Keep this file and access to the original passkey."
    )
    var prf = try await authorize(credential, walletId: id, purpose: "backup:v1", recovery: true)
    guard prf != nil else { throw WalletFailure.unavailable }
    diagnostics.mark("backup-encryption")
    let current = try store.load()
    let bytes: Data
    do {
      bytes = try StoredBackupCodec.encrypt(current, prf: prf!)
      current.close()
      prf?.wipe()
    } catch {
      current.close()
      prf?.wipe()
      throw error
    }

    diagnostics.mark("backup-file-write")
    let temporary = try store.files.url("backup-\(UUID().uuidString).json")
    defer { try? FileManager.default.removeItem(at: temporary) }
    try store.files.write(temporary.lastPathComponent, bytes: bytes)
    // Only encrypted bytes survive the document picker; plaintext and PRF were cleared above.
    diagnostics.mark("backup-export")
    _ = try await withSystemDialog { try await screen.pick(exporting: temporary) }
    try await screen.confirm(
      "Verify saved backup",
      "Reopen the file you just saved. Verification needs the same passkey again.",
      action: "Choose saved file")
    diagnostics.mark("backup-reopen")
    let url = try await withSystemDialog { try await screen.pick() }
    let saved = try readBackup(url)
    var verification = try await authorize(
      credential, walletId: id, purpose: "backup-verify:v1", recovery: true)
    defer { verification?.wipe() }
    guard let verification else { throw WalletFailure.unavailable }
    diagnostics.mark("backup-verify")
    let restored = try StoredBackupCodec.decrypt(saved, prf: verification)
    defer { restored.close() }
    let original = try store.load()
    defer { original.close() }
    try require(
      restored.id == original.id && restored.credential == original.credential
        && restored.entropy == original.entropy && restored.roleRegistry == original.roleRegistry
        && restored.earnChain == original.earnChain
        && restored.earnRecoveryRequired == original.earnRecoveryRequired
        && restored.earnCycleIndex == original.earnCycleIndex && restored.earnCycles == original.earnCycles)
    try require(
      try deriveAccountAddresses(entropy: restored.entropy)
        == deriveAccountAddresses(entropy: original.entropy))
    try checkAuthorization()
    diagnostics.mark("backup-commit")
    original.verified = true
    try store.save(original)
    return try publicState()
  }

  func restore() async throws -> [String: Any] {
    guard ["absent", "recoveryRequired"].contains(store.state()) else {
      throw WalletFailure.walletExists
    }
    let screen = try await presentWalletUI()
    try await screen.confirm(
      "Restore wallet",
      "Choose your encrypted Gizu backup and authorize with its original passkey. Local transaction history is not restored.",
      action: "Choose backup")
    let url = try await withSystemDialog { try await screen.pick() }
    let bytes = try readBackup(url)
    let credential = try StoredBackupCodec.credential(bytes)
    var prf = try await authorize(
      credential, walletId: "restore", purpose: "restore:v1", recovery: true)
    defer { prf?.wipe() }
    guard prf != nil else { throw WalletFailure.unavailable }
    let addresses: [String]
    do {
      let record = try StoredBackupCodec.decrypt(bytes, prf: prf!)
      defer { record.close() }
      addresses = try deriveAccountAddresses(entropy: record.entropy)
      prf?.wipe()
    } catch {
      prf?.wipe()
      throw error
    }

    // No decrypted wallet remains alive while the user reviews the recovered address.
    try await screen.confirm(
      "Confirm recovery",
      "Restore Account 0:\n\(addresses[0])\n\nYour existing healthy wallet will never be overwritten.",
      action: "Restore wallet")
    var commitPrf = try await authorize(
      credential, walletId: "restore", purpose: "restore-commit:v1", recovery: true)
    defer { commitPrf?.wipe() }
    guard commitPrf != nil else { throw WalletFailure.unavailable }
    try checkAuthorization()
    let recovered = try StoredBackupCodec.decrypt(bytes, prf: commitPrf!)
    defer { recovered.close() }
    let registry = await StoredSwapReconciler.covering(
      entropy: recovered.entropy, backup: recovered.roleRegistry)
    let committed = try WalletRecord(
      id: recovered.id, credential: recovered.credential, entropy: Data(recovered.entropy),
      roleRegistry: registry, earnChain: recovered.earnChain,
      earnRecoveryRequired: recovered.earnRecoveryRequired, earnCycleIndex: recovered.earnCycleIndex,
      earnCycles: recovered.earnCycles)
    defer { committed.close() }
    try store.restore(committed)
    return try publicState()
  }
}
