import Foundation

internal enum WalletLimits {
  static let encodedInputBytes = 64 * 1024
  static let backupBytes = 64 * 1024
  static let swapStateBytes = 64 * 1024 * 1024
  static let swapFileBytes = 256 * 1024 * 1024
  static let protectedFileBytes = 4 * 1024 * 1024
  static let walletRecordBytes = 8192
  static let activeOperations = 256
  static let journalCompactionBytes = 3 * 1024 * 1024
  static let accountIndices = 0...15
  static let chainID = 10143
  static let nativeTransferGas = 21000
}
