import Foundation

internal struct EarnVaultRPC: StoredTransferRPC {
  private let transport = NativeMainnetPortfolioRPC(network: .ethereum)
  func call(_ method: String, _ params: [Any]) async throws -> Any {
    let values = try await transport.calls([PortfolioRequest(method: method, params: params)])
    try require(values.count == 1)
    return values[0]
  }
  func text(_ method: String, _ params: [Any]) async throws -> String {
    guard let value = try await call(method, params) as? String else { throw WalletFailure.invalid }
    return value
  }
}
internal struct EarnVaultStateLoader {
  let rpc: StoredTransferRPC
  var now: () -> UInt64 = { UInt64(Date().timeIntervalSince1970) }
  func load(owner: String, kind: String, amount: String) async throws -> EarnExecutionState {
    try require(try earnQuantityValue(value: await rpc.text("eth_chainId", [])) == "1")
    try require(["vaultDeposit", "vaultRedeemAll"].contains(kind))
    let ownerWord = try EarnValues.addressWord(owner)
    let amountWord = try earnAmountWord(value: amount)
    let block = try EarnValues.object(await rpc.call("eth_getBlockByNumber", ["latest", false]))
    let timestamp = try EarnValues.uint(rpcText(block, "timestamp"))
    let observed = now()
    try require(timestamp <= observed + 5 && observed <= timestamp + 60)
    let hash = try EarnValues.hash(rpcText(block, "hash"))
    let parent = try EarnValues.hash(rpcText(block, "parentHash"))
    let zero = "0x" + String(repeating: "0", count: 64)
    try require(hash != parent && hash != zero && parent != zero)
    let pinned = try EarnValues.pinned(hash)
    func text(_ method: String, _ first: Any) async throws -> String {
      try await rpc.text(method, [first, pinned])
    }
    func call(_ to: String, _ data: String) async throws -> String {
      try await text("eth_call", ["to": to, "data": data])
    }
    func uint(_ to: String, _ data: String) async throws -> String {
      try decodePortfolioBalance(value: await call(to, data))
    }
    let pending = try EarnValues.uint(
      await rpc.text("eth_getTransactionCount", [owner, "pending"]))
    let canonical = try EarnValues.uint(await text("eth_getTransactionCount", owner))
    try require(pending >= canonical && pending <= UInt64(Int64.max))
    let balance = try earnQuantityValue(value: await text("eth_getBalance", owner))
    let senderCode = try await text("eth_getCode", owner)
    let tokenCode = try await text("eth_getCode", EarnValues.usdc)
    let vaultCode = try await text("eth_getCode", EarnValues.vault)
    let routerCode = try await text("eth_getCode", EarnValues.router)
    try require(tokenCode != "0x" && vaultCode != "0x" && routerCode != "0x")
    let asset = try await call(EarnValues.vault, "0x38d52e0f")
    _ = try decodePortfolioBalance(value: asset)
    try require(asset.dropFirst(2).prefix(24) == String(repeating: "0", count: 24))
    guard let decimals = UInt32(try await uint(EarnValues.usdc, "0x313ce567")) else {
      throw WalletFailure.invalid
    }
    let usdc = try await uint(EarnValues.usdc, "0x70a08231" + ownerWord)
    let shares = try await uint(EarnValues.vault, "0x70a08231" + ownerWord)
    let allowance = try await uint(
      kind == "vaultDeposit" ? EarnValues.usdc : EarnValues.vault,
      "0xdd62ed3e" + ownerWord + EarnValues.addressWord(EarnValues.router))
    let preview = try await uint(EarnValues.vault, "0xef8b30f7" + amountWord)
    let maxRedeem = try await uint(EarnValues.vault, "0xd905777e" + ownerWord)
    let checked = try EarnValues.object(
      await rpc.call("eth_getBlockByNumber", [rpcText(block, "number"), false]))
    try require(try EarnValues.hash(rpcText(checked, "hash")) == hash)
    try require(now() <= timestamp + 60)
    return EarnExecutionState(
      chainId: 1, owner: owner, nonce: pending, observedAt: observed,
      blockNumber: try EarnValues.uint(rpcText(block, "number")), blockHash: hash,
      parentHash: parent,
      nativeBalanceWei: balance,
      baseFeeWei: try earnQuantityValue(value: rpcText(block, "baseFeePerGas")),
      usdcBalanceAtoms: usdc, shares: shares, allowanceAtoms: allowance,
      previewDepositShares: preview,
      maxRedeemShares: maxRedeem, vaultAsset: "0x" + asset.suffix(40), tokenDecimals: decimals,
      senderCode: senderCode, tokenCodeHash: try earnContractCodeHash(code: tokenCode),
      vaultCodeHash: try earnContractCodeHash(code: vaultCode),
      routerCodeHash: try earnContractCodeHash(code: routerCode))
  }
}

/// Recheck both canonical heights through fixed native RPC; no Expo/provider proof is accepted.
internal func loadEarnGasReference(
  rpc: StoredTransferRPC, reviewedNumber: UInt64, reviewedHash: String,
  current: EarnExecutionState,
  nowMillis: () -> UInt64 = { UInt64(Date().timeIntervalSince1970 * 1000) }
) async throws -> NativeGasReference {
  try require(current.chainId == 1 && current.blockNumber >= reviewedNumber)
  try require(try earnQuantityValue(value: await rpc.text("eth_chainId", [])) == "1")
  func canonical(_ number: UInt64, _ hash: String) async throws {
    let block = try EarnValues.object(
      await rpc.call("eth_getBlockByNumber", ["0x" + String(number, radix: 16), false]))
    try require(try EarnValues.uint(rpcText(block, "number")) == number)
    try require(try EarnValues.hash(rpcText(block, "hash")) == EarnValues.hash(hash))
  }
  try await canonical(reviewedNumber, reviewedHash)
  try await canonical(current.blockNumber, current.blockHash)
  return NativeGasReference(
    chainId: 1, reviewedBlockNumber: reviewedNumber,
    canonicalReviewedBlockHash: try EarnValues.hash(reviewedHash),
    currentBlockNumber: current.blockNumber, currentBlockHash: try EarnValues.hash(current.blockHash),
    observedAtMs: nowMillis())
}
