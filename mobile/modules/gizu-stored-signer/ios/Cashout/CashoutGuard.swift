import Foundation

internal func cashoutSources(_ record: WalletRecord) throws -> [CashoutSource] {
  let shared = try deriveAccountAddresses(entropy: record.entropy)[2].lowercased()
  var sources = [
    CashoutSource(kind: "swap", profileChainId: 0, cycleIndex: 0, address: shared, amountAtoms: "0")
  ]
  guard
    let cycles = try JSONSerialization.jsonObject(with: Data(record.earnCycles.utf8))
      as? [[String: Any]]
  else { throw WalletFailure.invalid }
  for cycle in cycles {
    let chain = try CashoutJSON.uint(cycle, "chainId")
    let index = try CashoutJSON.uint(cycle, "cycleIndex")
    try require([1, 4663].contains(chain) && index <= 715_827_881)
    if cycle["privateAccount"] as? String == "shared" { continue }
    let address = try deriveEarnCycleConfidentialAddress(
      entropy: record.entropy, chainId: chain, cycleIndex: UInt32(index)
    ).lowercased()
    try require(!sources.contains { $0.address.lowercased() == address.lowercased() })
    sources.append(
      CashoutSource(
        kind: "earn", profileChainId: chain, cycleIndex: UInt32(index), address: address,
        amountAtoms: "0"))
  }
  return sources
}

internal func assertCashoutCanStart(store: WalletStorage, record: WalletRecord) throws {
  try require(record.verified && !record.earnRecoveryRequired)
  try require(try EarnVaultJournal(store: store, record: record).all().allSatisfy { !$0.blocked })
  if let saved = try StoredSwapFile(store: store, record: record).load() {
    try assertCashoutSwapFinished(CashoutJSON.object(CashoutJSON.string(saved, "state")))
  }
}

internal func assertCashoutSwapFinished(_ state: [String: Any]) throws {
  guard let rawStep = state["step"], let rawData = state["data"] else {
    throw WalletFailure.invalid
  }
  let step = try EarnValues.object(rawStep)
  let data = try EarnValues.object(rawData)
  if step["step"] as? String == "done" { return }
  try require(state["cancelled"] as? Bool == true)
  func exists(_ field: String) -> Bool { data[field] != nil && !(data[field] is NSNull) }
  try require(!exists("signedOperation") || exists("creditBasis"))
  guard let payouts = data["payouts"] as? [[String: Any]] else { throw WalletFailure.invalid }
  try require(
    payouts.allSatisfy {
      ($0["signed"] == nil || $0["signed"] is NSNull)
        && ($0["intentHash"] == nil || $0["intentHash"] is NSNull)
    })
}

internal func assertCashoutInactive(store: WalletStorage, record: WalletRecord) throws {
  try require(try CashoutJournal(store: store, record: record).active() == nil)
}
