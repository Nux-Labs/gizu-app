import CryptoKit
import Foundation
import Security

internal enum WalletFailure: Error {
  case invalid, unavailable, cancelled, busy, insufficientBalance, walletExists
}

internal func requireRoleRegistry(_ value: String) throws {
  guard let data = value.data(using: .utf8), data.count <= 1024,
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any], object.count == 2,
    object["version"] as? Int == 1, let next = object["nextRecipient"] as? Int, next >= 3
  else { throw WalletFailure.invalid }
}

internal func registryNext(_ value: String) throws -> Int {
  guard let data = value.data(using: .utf8),
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    let next = object["nextRecipient"] as? Int
  else { throw WalletFailure.invalid }
  return next
}

internal func require(_ condition: Bool) throws {
  guard condition else { throw WalletFailure.invalid }
}

internal func randomBytes(_ count: Int = 32) throws -> Data {
  var bytes = Data(count: count)
  let result = bytes.withUnsafeMutableBytes {
    SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!)
  }

  try require(result == errSecSuccess)
  return bytes
}

internal func digest(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }
extension Data {
  var base64URL: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
      of: "/", with: "_"
    ).replacingOccurrences(of: "=", with: "")
  }

  init(urlEncoded value: String) throws {
    try require(
      value.count <= 90_000
        && value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil)
    let padded =
      value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
      + String(repeating: "=", count: (4 - value.count % 4) % 4)
    guard let data = Data(base64Encoded: padded), data.base64URL == value else {
      throw WalletFailure.invalid
    }

    self = data
  }

  mutating func wipe() {
    resetBytes(in: 0..<count)
    removeAll()
  }
}

internal enum WalletEnvelope {
  static let magic = Data("GSW1".utf8)
  static func encrypt(_ clear: Data, key: SymmetricKey, aad: Data) throws -> Data {
    let box = try AES.GCM.seal(clear, using: key, authenticating: aad)
    guard let combined = box.combined else { throw WalletFailure.invalid }
    return magic + combined
  }

  static func decrypt(_ data: Data, key: SymmetricKey, aad: Data) throws -> Data {
    try require(data.count >= 32 && data.prefix(4) == magic)
    return try AES.GCM.open(
      AES.GCM.SealedBox(combined: data.dropFirst(4)), using: key, authenticating: aad)
  }
}

internal struct StoredCredential: Codable, Equatable {
  let id: Data
  let x: Data
  let y: Data
  func validate() throws {
    try require((1...1024).contains(id.count) && x.count == 32 && y.count == 32)
    _ = try P256.Signing.PublicKey(x963Representation: Data([4]) + x + y)
  }
}
// Reference type avoids implicit struct copies of entropy. Swift/FFI copies cannot be guaranteed erased.
internal final class WalletRecord {
  let id: String
  let credential: StoredCredential
  var entropy: Data
  var verified: Bool
  let journalId: String
  let roleRegistry: String
  let earnChain: Int
  let earnRecoveryRequired: Bool
  let earnCycleIndex: Int
  let earnCycles: String
  init(
    id: String, credential: StoredCredential, entropy: Data, verified: Bool = false,
    journalId: String? = nil, roleRegistry: String = #"{"version":1,"nextRecipient":3}"#,
    earnChain: Int = 0, earnRecoveryRequired: Bool = false,
    earnCycleIndex: Int = 0, earnCycles: String = "[]"
  ) throws {
    try require(UUID(uuidString: id) != nil && entropy.count == 32)
    try credential.validate()
    try requireRoleRegistry(roleRegistry)
    self.id = id
    self.credential = credential
    self.entropy = entropy
    self.verified = verified
    self.journalId = journalId ?? id
    self.roleRegistry = roleRegistry
    try require([0, 1, 4663].contains(earnChain) && (0...715_827_881).contains(earnCycleIndex))
    try require(earnCycles.utf8.count <= WalletLimits.walletRecordBytes)
    guard let cyclesData = earnCycles.data(using: .utf8),
      (try JSONSerialization.jsonObject(with: cyclesData)) is [[String: Any]]
    else { throw WalletFailure.invalid }
    self.earnChain = earnChain
    self.earnRecoveryRequired = earnRecoveryRequired
    self.earnCycleIndex = earnCycleIndex
    self.earnCycles = earnCycles
    try require(UUID(uuidString: self.journalId) != nil)
  }

  deinit { entropy.wipe() }
  func close() { entropy.wipe() }
}
