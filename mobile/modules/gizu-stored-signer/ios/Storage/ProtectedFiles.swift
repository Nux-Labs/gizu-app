import Darwin
import Foundation

internal protocol WalletFiles {
  func url(_ name: String) throws -> URL
  func exists(_ name: String) throws -> Bool
  func read(_ name: String, limit: Int) throws -> Data
  func write(_ name: String, bytes: Data) throws
}
extension WalletFiles {
  func read(_ name: String) throws -> Data {
    try read(name, limit: WalletLimits.protectedFileBytes)
  }
}

internal final class ProtectedFiles: WalletFiles {
  let root: URL
  init(root: URL? = nil) throws {
    self.root =
      try root
      ?? FileManager.default.url(
        for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
      ).appendingPathComponent("gizu-stored-wallet-v1", isDirectory: true)
    try FileManager.default.createDirectory(
      at: self.root, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    var url = self.root
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
  }

  func url(_ name: String) throws -> URL {
    try require(name.range(of: "^[a-zA-Z0-9.-]+$", options: .regularExpression) != nil)
    return root.appendingPathComponent(name)
  }

  func exists(_ name: String) throws -> Bool {
    FileManager.default.fileExists(atPath: try url(name).path)
  }

  func read(_ name: String, limit: Int = WalletLimits.protectedFileBytes) throws -> Data {
    let path = try url(name)
    let size = try path.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    try require(size > 0 && size <= limit)
    let bytes = try Data(contentsOf: path)
    try require(bytes.count <= limit)
    return bytes
  }

  func write(_ name: String, bytes: Data) throws {
    // Only the encrypted swap journal may grow with a multi-wallet sale. Other wallet files
    // retain their original limit.
    let limit =
      name.hasPrefix("gizu-swap-") && name.hasSuffix(".enc")
      ? WalletLimits.swapFileBytes : WalletLimits.protectedFileBytes
    try require(!bytes.isEmpty && bytes.count <= limit)
    let target = try url(name)
    let temporary = root.appendingPathComponent(UUID().uuidString + ".tmp")
    defer { try? FileManager.default.removeItem(at: temporary) }
    try bytes.write(to: temporary, options: [.completeFileProtection, .withoutOverwriting])
    // A successful write means bytes, rename, directory entry and read-back all succeeded.
    let fd = Darwin.open(temporary.path, O_RDONLY)
    guard fd >= 0 else { throw WalletFailure.invalid }
    let synced = fsync(fd)
    let closed = Darwin.close(fd)
    try require(synced == 0 && closed == 0)
    try require(rename(temporary.path, target.path) == 0)
    let directory = Darwin.open(root.path, O_RDONLY)
    guard directory >= 0 else { throw WalletFailure.invalid }
    let committed = fsync(directory)
    let directoryClosed = Darwin.close(directory)
    try require(committed == 0 && directoryClosed == 0)
    try require(try read(name, limit: limit) == bytes)
  }
}
