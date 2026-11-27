import UIKit

@available(iOS 18.0, *)
@MainActor internal final class WalletCeremony {
  private static var privateReadGrant: AuthorizationLifetime.PrivateReadGrant?
  private static var privateReadObservers: [NSObjectProtocol] = []
  let diagnostics: WalletDiagnostics
  let store: WalletStorage
  let presenter: UIViewController
  var ui: NativeWalletUI?
  private var gate: StoredPasskeyGate?
  private var isPresentingSystemDialog = false
  private var lifetime = AuthorizationLifetime()
  var engine: StoredTransferEngine?
  var operationId: String?
  private var observers: [NSObjectProtocol] = []
  var cancelTask: (() -> Void)?
  init(
    presenter: UIViewController, diagnostics: WalletDiagnostics,
    window: AuthorizationLifetime.Window = .wallet
  ) throws {
    lifetime = AuthorizationLifetime(window: window)
    self.diagnostics = diagnostics
    self.presenter = presenter
    store = WalletStorage(files: try ProtectedFiles())
    if Self.privateReadObservers.isEmpty {
      for event in [
        UIApplication.didEnterBackgroundNotification,
        UIApplication.protectedDataWillBecomeUnavailableNotification,
      ] {
        Self.privateReadObservers.append(
          NotificationCenter.default.addObserver(forName: event, object: nil, queue: .main) { _ in
            Task { @MainActor in Self.revokePrivateReads() }
          })
      }
    }
    for event in [
      UIApplication.didEnterBackgroundNotification,
      UIApplication.protectedDataWillBecomeUnavailableNotification,
    ] {
      observers.append(
        NotificationCenter.default.addObserver(forName: event, object: nil, queue: .main) {
          [weak self] note in
          Task { @MainActor in
            guard let self else { return }
            if note.name == UIApplication.protectedDataWillBecomeUnavailableNotification
              || !self.isPresentingSystemDialog
            {
              self.diagnostics.event("lifecycle-cancel")
              self.cancel()
            }
          }
        })
    }
  }
  static func revokePrivateReads() { privateReadGrant = nil }
  func grantPrivateReads(_ record: WalletRecord) throws {
    try checkAuthorization()
    try require(record.verified)
    Self.privateReadGrant = .init(walletId: record.id, generation: record.journalId)
  }
  func checkPrivateRead(_ record: WalletRecord) throws {
    try checkAuthorization()
    guard let grant = Self.privateReadGrant else { throw WalletFailure.unavailable }
    try grant.check(
      walletId: record.id, generation: record.journalId,
      active: UIApplication.shared.applicationState == .active,
      protected: UIApplication.shared.isProtectedDataAvailable)
  }

  func checkAuthorization() throws {
    do {
      try Task.checkCancellation()
      try lifetime.check(
        active: UIApplication.shared.applicationState == .active,
        protected: UIApplication.shared.isProtectedDataAvailable)
    } catch {
      if Task.isCancelled {
        diagnostics.event("task-cancelled")
      } else if lifetime.cancelled {
        diagnostics.event("authority-cancelled")
      } else if UIApplication.shared.applicationState != .active {
        diagnostics.event("app-inactive")
      } else if !UIApplication.shared.isProtectedDataAvailable {
        diagnostics.event("protected-data-unavailable")
      } else {
        diagnostics.event("authority-expired")
      }
      throw error
    }
  }

  func cancel() {
    diagnostics.event("cancel")
    lifetime.cancel()
    engine?.close()
    gate?.cancel()
    ui?.stop()
    cancelTask?()
    if let id = operationId { _ = try? engine?.journal.update(id) { $0.cancelled = true } }
  }

  func close() {
    lifetime.cancel()
    engine?.close()
    gate?.cancel()
    ui?.stop()
    ui?.dismiss(animated: false) { [diagnostics] in diagnostics.event("dismissal-completed") }
    ui = nil
    gate = nil
    cancelTask = nil
    observers.forEach(NotificationCenter.default.removeObserver)
    observers = []
  }

  func presentWalletUI() async throws -> NativeWalletUI {
    try checkAuthorization()
    if let ui { return ui }
    diagnostics.event("presentation-start")
    let screen = NativeWalletUI()
    screen.onCancel = { [weak self] in self?.cancel() }
    ui = screen
    await withCheckedContinuation { continuation in
      presenter.present(screen, animated: true) { continuation.resume() }
    }

    diagnostics.event("presentation-completed")
    try checkAuthorization()
    return screen
  }

  func withSystemDialog<T>(_ action: () async throws -> T) async throws -> T {
    try checkAuthorization()
    isPresentingSystemDialog = true
    defer { isPresentingSystemDialog = false }
    let value = try await action()
    // AuthenticationServices/document pickers can return just before didBecomeActive.
    let until = ProcessInfo.processInfo.systemUptime + 10
    while UIApplication.shared.applicationState != .active
      && ProcessInfo.processInfo.systemUptime < until
    {
      try Task.checkCancellation()
      try await Task.sleep(nanoseconds: 50_000_000)
    }

    try checkAuthorization()
    return value
  }

  private func makePasskeyProvider() async throws -> StoredPasskeyGate {
    try checkAuthorization()
    // Login uses the app window directly; reviewed operations retain their native screen.
    guard let window = (ui ?? presenter).view.window else { throw WalletFailure.unavailable }
    let value = StoredPasskeyGate(window: window, diagnostics: diagnostics)
    gate = value
    return value
  }

  func authorize(
    _ credential: StoredCredential, walletId: String, purpose: String, recovery: Bool = false
  ) async throws -> Data? {
    let provider = try await makePasskeyProvider()
    return try await withSystemDialog {
      try await provider.authorize(
        credential, walletId: walletId, purpose: purpose, recovery: recovery)
    }
  }
  func publicState() throws -> [String: Any] {
    diagnostics.mark("read-wallet-state")
    let state = store.state()
    if state == "absent" || state == "recoveryRequired" { return ["status": state] }
    let record = try store.load()
    defer { record.close() }
    var result: [String: Any] = ["status": state, "walletId": record.id]
    if record.verified {
      result["accounts"] = try deriveAccountAddresses(entropy: record.entropy).enumerated().map {
        ["accountIndex": $0.offset, "address": $0.element, "chainId": WalletLimits.chainID]
          as [String: Any]
      }
    }

    return result
  }

  func create() async throws -> [String: Any] {
    diagnostics.mark("create-preflight")
    try require(!store.exists())
    let screen = try await presentWalletUI()
    try await screen.confirm(
      "Create wallet",
      "Create a passkey and a wallet stored encrypted on this iPhone. Save and verify a backup before using the wallet. Recovery requires that file and this same passkey."
    )
    let provider = try await makePasskeyProvider()
    let credential = try await withSystemDialog { try await provider.register() }
    let id = UUID().uuidString
    diagnostics.mark("create-recovery-assertion")
    var proof = try await authorize(
      credential, walletId: id, purpose: "create-recovery-check:v1", recovery: true)
    proof?.wipe()
    try checkAuthorization()
    diagnostics.mark("create-entropy")
    var entropy = try randomBytes()
    defer { entropy.wipe() }
    let record = try WalletRecord(id: id, credential: credential, entropy: entropy)
    defer { record.close() }
    try require(try deriveAccountAddresses(entropy: entropy).count == 16)
    diagnostics.mark("create-persist")
    try store.create(record)
    diagnostics.event("wallet-persisted")
    return try publicState()
  }

  func open() async throws -> [String: Any] {
    diagnostics.mark("read-wallet-state")
    let state = store.state()
    if ["absent", "recoveryRequired"].contains(state) { return ["status": state] }
    let record = try store.load()
    let id = record.id
    let credential = record.credential
    record.close()
    _ = try await authorize(credential, walletId: id, purpose: "open:v1")
    try checkAuthorization()
    let opened = try store.load()
    defer { opened.close() }
    if opened.verified { try grantPrivateReads(opened) }
    return try publicState()
  }
}
