import AuthenticationServices
import Foundation
import OSLog

/// Only fixed stages and classified error codes are logged. Never pass payloads,
/// NSError descriptions/userInfo, credential IDs, wallet IDs or file paths here.
@MainActor internal final class WalletDiagnostics {
  private static let logger = Logger(subsystem: "io.gizu.storedwallet", category: "ceremony")
  private let attempt = UUID().uuidString
  private let operation: String
  private var stage = "entry"

  init(operation: StaticString) { self.operation = operation.description }

  func mark(_ stage: StaticString) {
    self.stage = stage.description
    event("entered")
  }

  func event(_ event: StaticString) {
    Self.logger.notice(
      "attempt=\(self.attempt, privacy: .public) operation=\(self.operation, privacy: .public) stage=\(self.stage, privacy: .public) event=\(event.description, privacy: .public)"
    )
  }

  func failed(_ error: Error) {
    let summary = Self.errorSummary(error)
    Self.logger.error(
      "attempt=\(self.attempt, privacy: .public) operation=\(self.operation, privacy: .public) stage=\(self.stage, privacy: .public) error=\(summary, privacy: .public)"
    )
  }

  /// Stable public categories only; never forward native descriptions across the bridge.
  nonisolated static func bridgeCode(_ error: Error) -> String {
    if error is CancellationError { return "WALLET_CANCELLED" }
    if let failure = error as? WalletFailure {
      switch failure {
      case .cancelled: return "WALLET_CANCELLED"
      case .busy: return "BUSY"
      case .walletExists: return "WALLET_EXISTS"
      default: return "WALLET_STOPPED"
      }
    }
    let native = error as NSError
    if native.domain == ASAuthorizationError.errorDomain {
      return native.code == ASAuthorizationError.canceled.rawValue
        ? "WALLET_CANCELLED" : "PASSKEY_FAILED"
    }
    return "WALLET_STOPPED"
  }

  nonisolated static func errorSummary(_ error: Error) -> String {
    if let failure = error as? WalletFailure {
      switch failure {
      case .invalid: return "wallet.invalid"
      case .unavailable: return "wallet.unavailable"
      case .cancelled: return "wallet.cancelled"
      case .busy: return "wallet.busy"
      case .insufficientBalance: return "wallet.insufficientBalance"
      case .walletExists: return "wallet.exists"
      }
    }
    if error is CancellationError { return "task.cancelled" }
    let native = error as NSError
    // Unknown domains can themselves contain sensitive data. Do not echo them.
    switch native.domain {
    case ASAuthorizationError.errorDomain: return "apple.authorization:\(native.code)"
    case NSCocoaErrorDomain: return "cocoa:\(native.code)"
    case NSOSStatusErrorDomain: return "osstatus:\(native.code)"
    case NSPOSIXErrorDomain: return "posix:\(native.code)"
    default: return "unclassified"
    }
  }
}
