import Foundation

func storedEarnIntentIdentity(walletId: String, profile: String, cycleIndex: Int) -> (version: String, id: String) {
  if cycleIndex == 0 { return ("gizu-earn-v1", "earn-v1:\(walletId.lowercased()):\(profile)") }
  return ("gizu-earn-v2", "earn-v2:\(walletId.lowercased()):\(profile):\(cycleIndex)")
}

func storedEarnConfidentialAddress(_ record: WalletRecord) throws -> String {
  guard let data = record.earnCycles.data(using: .utf8),
    let cycles = try JSONSerialization.jsonObject(with: data) as? [[String: Any]]
  else { throw WalletFailure.invalid }
  let cycle = cycles.first { ($0["cycleIndex"] as? Int) == record.earnCycleIndex }
  if cycle?["privateAccount"] as? String == "shared" {
    return try deriveAccountAddresses(entropy: record.entropy)[2]
  }
  return try deriveEarnCycleConfidentialAddress(entropy: record.entropy,
    chainId: UInt64(record.earnChain), cycleIndex: UInt32(record.earnCycleIndex))
}

@available(iOS 18.0, *)
extension WalletCeremony {
  func earnIntent(walletId: String) throws -> [String: Any] {
    try checkAuthorization()
    let record = try store.load()
    defer { record.close() }
    try require(record.id == walletId && record.verified)
    if record.earnChain == 0 {
      return ["status": record.earnRecoveryRequired ? "recoveryRequired" : "absent"]
    }
    let profile = record.earnChain == 1 ? "ethereum-usdc" : "robinhood-usdg"
    let addresses = try deriveEarnCycleAddresses(entropy: record.entropy, chainId: UInt64(record.earnChain), cycleIndex: UInt32(record.earnCycleIndex))
    try require(addresses.count == 2 && addresses[0] != addresses[1])
    let identity = storedEarnIntentIdentity(walletId: record.id, profile: profile, cycleIndex: record.earnCycleIndex)
    return [
      "status": record.earnRecoveryRequired ? "recoveryRequired" : "prepared",
      "intentId": identity.id,
      "cycleIndex": record.earnCycleIndex,
      "version": identity.version, "walletId": record.id, "profileId": profile,
      "sourceAddress": try deriveAccountAddresses(entropy: record.entropy)[0],
      "confidentialAddress": try storedEarnConfidentialAddress(record),
      "returnConfidentialAddress": try deriveAccountAddresses(entropy: record.entropy)[2],
      "sourceChainId": 143, "backupCovered": true,
      "destinations": addresses.enumerated().map {
        ["role": $0.offset == 0 ? "hold" : "invest", "address": $0.element, "chainId": record.earnChain] as [String: Any]
      },
    ]
  }

  func prepareEarnIntent(walletId: String, profile: String) async throws -> [String: Any] {
    let chain: Int
    switch profile {
      case "ethereum-usdc": chain = 1
      case "robinhood-usdg": chain = 4663
      default: throw WalletFailure.invalid
    }
    let identity = try store.load()
    let credential = identity.credential
    let journalId = identity.journalId
    let recovery = identity.earnRecoveryRequired
    try require(identity.id == walletId && identity.verified && ([0, chain].contains(identity.earnChain) || recovery))
    identity.close()
    let network = chain == 1 ? "Ethereum mainnet USDC" : "Robinhood mainnet USDG"
    let screen = try await presentWalletUI()
    try await screen.confirm(recovery ? "Recover earn wallets" : "Prepare two earn wallets",
      "Source: Monad mainnet USDC account 0. Destination: \(network). Wallet 1 holds 10%; wallet 2 invests 90% after fees. Both are covered by your verified backup. This iOS build can prepare or recover these wallets. Source funding is unavailable on iOS. Ethereum vault execution requires an already funded investment wallet; other execution paths remain unavailable. This creates no transfer or investment. " +
      (recovery ? "Recovered wallets require activity reconciliation before funding." : "Confirm your passkey to prepare this intent."))
    _ = try await authorize(credential, walletId: walletId, purpose: "earn-wallets:v1:\(profile)")
    try checkAuthorization()
    let record = try store.load()
    defer { record.close() }
    try require(record.id == walletId && record.journalId == journalId && record.verified)
    try require(try deriveEarnCycleAddresses(entropy: record.entropy, chainId: UInt64(chain), cycleIndex: UInt32(record.earnCycleIndex)).count == 2)
    try store.bindEarnChain(record, chain: chain)
    return try earnIntent(walletId: walletId)
  }
}

@available(iOS 18.0, *)
extension WalletCeremony {
  func readEarnBalance(walletId:String) async throws -> [String:Any] {
    let identity=try store.load()
    let credential=identity.credential, journal=identity.journalId, chain=identity.earnChain, cycle=identity.earnCycleIndex
    defer { identity.close() }
    try require(identity.id==walletId && identity.verified && [1,4663].contains(chain))
    identity.close()
    let screen=try await presentWalletUI()
    try await screen.confirm("Check confidential USDC","Authenticate a read-only balance check for your prepared earn account. Gizu and the confidential provider receive this account identity. This does not transfer funds or confirm settlement for any operation.")
    _=try await authorize(credential,walletId:walletId,purpose:"earn-read:v1:\(chain)")
    try checkAuthorization()
    let api=ConfidentialBalance()
    let salt=try await api.salt()
    try checkAuthorization()
    let random=try randomBytes(7)
    let started=UInt64(Date().timeIntervalSince1970*1000)
    let record=try store.load()
    defer { record.close() }
    try require(record.id==walletId && record.journalId==journal && record.earnChain==chain && record.earnCycleIndex==cycle && record.verified)
    let address=try storedEarnConfidentialAddress(record)
    let shared=try deriveAccountAddresses(entropy:record.entropy)[2]
    let auth = address.lowercased() == shared.lowercased()
      ? try authenticateSwapRead(entropy:record.entropy,salt:salt,random:random,startedMs:started,nowMs:UInt64(Date().timeIntervalSince1970*1000))
      : try authenticateEarnCycleRead(entropy:record.entropy,chainId:UInt64(chain),cycleIndex:UInt32(cycle),salt:salt,random:random,startedMs:started,nowMs:UInt64(Date().timeIntervalSince1970*1000))
    record.close()
    let result=try await api.read(auth,address:address)
    try checkAuthorization()
    let fresh=try store.load()
    defer { fresh.close() }
    try require(fresh.id==walletId && fresh.journalId==journal && fresh.earnChain==chain && fresh.earnCycleIndex==cycle)
    return result
  }
}
