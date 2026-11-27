import Foundation

internal struct AuthorizationLifetime {
  enum Window { case wallet, swap }
  private let deadline: TimeInterval
  private(set) var cancelled = false
  init(now: TimeInterval = ProcessInfo.processInfo.systemUptime, window: Window = .wallet) {
    deadline = now + (window == .swap ? 900 : 120)
  }
  mutating func cancel() { cancelled = true }
  func check(
    now: TimeInterval = ProcessInfo.processInfo.systemUptime, active: Bool, protected: Bool
  ) throws {
    try require(!cancelled && now < deadline && active && protected)
  }
}

/// Read-only authority established by an existing native passkey ceremony; never a spending grant.
extension AuthorizationLifetime {
  struct PrivateReadGrant {
    let walletId: String
    let generation: String
    private var lifetime: AuthorizationLifetime
    init(
      walletId: String, generation: String, now: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) {
      self.walletId = walletId
      self.generation = generation
      lifetime = AuthorizationLifetime(now: now, window: .swap)
    }
    mutating func revoke() { lifetime.cancel() }
    func check(
      walletId: String, generation: String,
      now: TimeInterval = ProcessInfo.processInfo.systemUptime,
      active: Bool, protected: Bool
    ) throws {
      try require(self.walletId == walletId && self.generation == generation)
      try lifetime.check(now: now, active: active, protected: protected)
    }
  }
}
