import Foundation

internal struct EarnVaultReview: Equatable {
  let id: String
  let revision: UInt32
  let coreRevision: UInt64
  let hash: String
  let text: String
  let index: Int
  let retry: Bool
}

internal final class EarnVaultEngine {
  typealias SignerFactory = (String, Data) throws -> EarnExecutionOperationProtocol
  typealias StateLoader = (String, String, String) async throws -> EarnExecutionState
  let journal: EarnVaultJournal
  private let store: WalletStorage
  private let rpc: StoredTransferRPC
  private let makeSigner: SignerFactory
  private let state: StateLoader
  private var signer: EarnExecutionOperationProtocol?
  private var prepared: EarnVaultReview?
  private var reviewedBlock: (number: UInt64, hash: String)?
  init(
    store: WalletStorage, journal: EarnVaultJournal, rpc: StoredTransferRPC,
    makeSigner: @escaping SignerFactory = { try EarnExecutionOperation(proposal: $0, entropy: $1) },
    state: StateLoader? = nil
  ) {
    self.store = store
    self.journal = journal
    self.rpc = rpc
    self.makeSigner = makeSigner
    self.state =
      state ?? { try await EarnVaultStateLoader(rpc: rpc).load(owner: $0, kind: $1, amount: $2) }
  }
  static func requireWallet(_ record: WalletRecord, walletId: String) throws {
    try require(
      record.id == walletId && record.verified && record.earnChain == 1
        && !record.earnRecoveryRequired)
  }
  private func wallet(_ proposal: EarnVaultProposal? = nil) throws -> WalletRecord {
    let record = try store.load()
    do {
      try Self.requireWallet(record, walletId: journal.walletId)
      try require(record.journalId == journal.generation)
      if let proposal { try require(record.earnCycleIndex == Int(proposal.cycleIndex)) }
      return record
    } catch {
      record.close()
      throw error
    }
  }
  private func checkWallet(_ proposal: EarnVaultProposal) throws {
    let record = try wallet(proposal)
    record.close()
  }
  func create(_ request: [String: Any]) async throws -> EarnVaultRecord {
    try await reconcileEarnVault(journal, rpc: rpc)
    try Task.checkCancellation()
    let record = try wallet()
    defer { record.close() }
    let addresses = try deriveEarnCycleAddresses(
      entropy: record.entropy, chainId: 1, cycleIndex: UInt32(record.earnCycleIndex))
    try require(addresses.count == 2)
    let proposal = try EarnVaultProposal.parse(request, walletId: record.id, owner: addresses[1])
    try require(record.earnCycleIndex == Int(proposal.cycleIndex))
    let validation = try makeSigner(EarnValues.json(proposal), record.entropy)
    validation.invalidate()
    return try journal.create(proposal)
  }
  func prepare(_ id: String, revision: UInt32) async throws -> EarnVaultReview {
    close()
    try require(try journal.get(id).revision == revision)
    try await reconcileEarnVault(journal, rpc: rpc)
    try Task.checkCancellation()
    let op = try journal.get(id)
    try require(op.canResume)
    try checkWallet(op.proposal)
    if let step = op.unresolved.first {
      try require(op.unresolved.count == 1 && step.status == "signed" && !step.conflict)
      try await checkRetry(op, step)
      guard let hash = op.reviewHash, let text = op.review, let txHash = step.transactionHash else {
        throw WalletFailure.invalid
      }
      let review = EarnVaultReview(
        id: id, revision: op.revision, coreRevision: 0, hash: hash,
        text:
          "ETHEREUM · chain 1\nRebroadcast exactly the saved transaction. No new signature or nonce.\n\(text)\nSaved hash \(txHash)\nSaved nonce \(step.nonce)",
        index: step.index, retry: true)
      prepared = review
      return review
    }
    let p = op.proposal
    let current = try await state(p.expectedFrom, p.kind, p.amountAtoms)
    try Task.checkCancellation()
    let proposal = try earnContinuationProposal(op, freshNonce: current.nonce)
    let signed = op.steps.filter { $0.raw != nil }
    let record = try wallet(proposal)
    do {
      defer { record.close() }
      signer = try makeSigner(EarnValues.json(proposal), record.entropy)
    }
    guard let core = signer else { throw WalletFailure.invalid }
    let text = try core.prepare(revision: proposal.revision, current: current)
    reviewedBlock = (current.blockNumber, current.blockHash)
    let hash = try core.reviewHash()
    let stored = try journal.prepare(
      id, revision: op.revision, calls: core.preparedCalls(), hash: hash, text: text,
      state: current, proposal: proposal)
    let review = EarnVaultReview(
      id: id, revision: stored.revision, coreRevision: proposal.revision,
      hash: hash, text: text, index: signed.count, retry: false)
    prepared = review
    return review
  }
  private func checkRetry(_ op: EarnVaultRecord, _ step: EarnVaultStep) async throws {
    let p = op.proposal
    let current = try await state(p.expectedFrom, p.kind, p.amountAtoms)
    try require(op.stateBinding == EarnVaultBinding(current))
    if p.kind == "vaultDeposit" {
      try require(try EarnValues.atLeast(current.usdcBalanceAtoms, p.amountAtoms))
    } else {
      try require(
        current.shares == p.amountAtoms
          && (try EarnValues.atLeast(current.maxRedeemShares, p.amountAtoms)))
    }
    try require(String(current.nonce) == step.nonce && current.senderCode == "0x")
    try require(
      try earnQuantityValue(
        value: await rpc.text("eth_getTransactionCount", [current.owner, "latest"])) == step.nonce)
    if step.to.lowercased() == EarnValues.router.lowercased() {
      try require((op.signingProposal ?? p).deadline > UInt64(Date().timeIntervalSince1970))
    }
    let remaining = op.steps.filter { !$0.terminal }
    for call in remaining {
      try require(
        try EarnValues.atLeast(
          call.maxFeePerGasWei,
          earnAmountSum(values: [current.baseFeeWei, call.priorityFeePerGasWei])))
    }
    let costs = try remaining.map {
      try earnAmountProduct(left: $0.gasLimit, right: $0.maxFeePerGasWei)
    }
    try require(
      try EarnValues.atLeast(
        current.nativeBalanceWei, earnAmountSum(values: costs + [p.withdrawalReserveWei])))
  }
  func execute(_ review: EarnVaultReview, authority: () throws -> Void) async throws {
    try require(prepared == review && journal.get(review.id).revision == review.revision)
    try authority()
    try Task.checkCancellation()
    let op = try journal.get(review.id)
    let p = op.proposal
    try checkWallet(p)
    let raw: String
    let hash: String
    if review.retry {
      let step = op.steps[review.index]
      try await checkRetry(op, step)
      try authority()
      try Task.checkCancellation()
      try checkWallet(p)
      guard let savedRaw = step.raw, let savedHash = step.transactionHash else {
        throw WalletFailure.invalid
      }
      raw = savedRaw
      hash = savedHash
      try journal.update(review.id, revision: review.revision) {
        $0.steps[review.index].status = "unknown"
      }
    } else {
      guard let core = signer else { throw WalletFailure.invalid }
      let current = try await state(p.expectedFrom, p.kind, p.amountAtoms)
      guard let anchor = reviewedBlock else { throw WalletFailure.invalid }
      let reference = try await loadEarnGasReference(
        rpc: rpc, reviewedNumber: anchor.number, reviewedHash: anchor.hash, current: current)
      try authority()
      try Task.checkCancellation()
      try checkWallet(p)
      try require(try journal.get(review.id).revision == review.revision)
      try core.approve(revision: review.coreRevision, reviewHash: review.hash)
      let tx = try core.signNextWithCanonicalReference(
        revision: review.coreRevision, current: current, reference: reference)
      try require(tx.operationId == review.id && tx.revision == review.coreRevision && tx.step == 0)
      try journal.persistSigned(review.id, revision: review.revision, index: review.index, tx: tx)
      raw = tx.rawTransaction
      hash = tx.transactionHash
    }
    try authority()
    try Task.checkCancellation()
    try checkWallet(p)
    let returned = try await rpc.text("eth_sendRawTransaction", [raw])
    try require(returned.lowercased() == hash.lowercased())
    try Task.checkCancellation()
    // One transaction per invocation. Any remaining unsigned call needs a fresh native approval.
    try await reconcileEarnVault(journal, rpc: rpc)
  }
  func close() {
    signer?.invalidate()
    signer = nil
    prepared = nil
    reviewedBlock = nil
  }
  deinit { signer?.invalidate() }
}

/// Refresh only an unsigned router call after finalized approval. Signed payloads are immutable.
internal func earnContinuationProposal(
  _ op: EarnVaultRecord, freshNonce: UInt64,
  now: UInt64 = UInt64(Date().timeIntervalSince1970)
) throws -> EarnVaultProposal {
  var proposal = op.proposal
  let signed = op.steps.filter { $0.raw != nil }
  try require(signed.allSatisfy { $0.status == "finalized" })
  if !signed.isEmpty {
    try require(signed.count == 1 && signed[0].to.lowercased() != EarnValues.router.lowercased())
    try require(
      proposal.nonce < UInt64.max && freshNonce == proposal.nonce + 1
        && proposal.gasLimits.count == 2)
    try require(now <= UInt64.max - 300)
    proposal.gasLimits = [proposal.gasLimits[1]]
    proposal.nonce = freshNonce
    proposal.deadline = now + 300
  }
  proposal.revision = UInt64(op.revision)
  return proposal
}
