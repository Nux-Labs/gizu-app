import Foundation

internal protocol CashoutGateway {
  func prepare(group: [String: Any], index: Int, source: CashoutSource, anchor: String?)
    async throws -> [String: Any]
  func submit(_ signed: String) async throws -> [String: Any]
  func status(_ row: CashoutRecord, recipients: [String]) async throws -> [String: Any]
}

internal final class NativeCashoutGateway: NSObject, CashoutGateway, URLSessionTaskDelegate {
  typealias Transport = (String, [String: Any]) async throws -> [String: Any]
  private let authenticate: ([CashoutSource]) async throws -> [[String: Any]]
  private let receipts: CashoutReceipts
  private let transport: Transport?
  private let now: () -> UInt64
  init(
    authenticate: @escaping ([CashoutSource]) async throws -> [[String: Any]],
    receipts: CashoutReceipts = CashoutReceipts(), transport: Transport? = nil,
    now: @escaping () -> UInt64 = { UInt64(Date().timeIntervalSince1970 * 1000) }
  ) {
    self.authenticate = authenticate
    self.receipts = receipts
    self.transport = transport
    self.now = now
  }
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }

  private func post(_ path: String, _ body: [String: Any]) async throws -> [String: Any] {
    try Task.checkCancellation()
    if let transport { return try await transport(path, body) }
    let route =
      path == "submit" ? "/v1/swap/aurora/submit-intent" : "/v1/earn/native/cashout/\(path)"
    guard let url = URL(string: "https://api.gizu.io" + route) else { throw WalletFailure.invalid }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.timeoutInterval = 20
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if path != "submit" {
      request.setValue("destination-receipt-group-v1", forHTTPHeaderField: "x-gizu-payout-proof")
    }
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let config = URLSessionConfiguration.ephemeral
    config.urlCache = nil
    config.httpCookieStorage = nil
    config.timeoutIntervalForResource = 30
    let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    let (stream, response) = try await session.bytes(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw WalletFailure.unavailable }
    var data = Data()
    for try await byte in stream {
      try Task.checkCancellation()
      try require(data.count < 262144)
      data.append(byte)
    }
    return try EarnValues.object(JSONSerialization.jsonObject(with: data))
  }
  func prepare(group: [String: Any], index: Int, source: CashoutSource, anchor: String?)
    async throws -> [String: Any]
  {
    let owners = try await authenticate([source])
    try require(owners.count == 1)
    var body: [String: Any] = ["group": group, "childIndex": index, "signedData": owners[0]]
    if let anchor { body["anchor"] = anchor }
    var result = try await post("group-prepare", body)
    try require(try CashoutJSON.text(result).utf8.count <= 262144)
    result["leg"] = "withdrawal"
    return result
  }
  func submit(_ signed: String) async throws -> [String: Any] {
    try await post("submit", ["signedData": CashoutJSON.object(signed)])
  }
  func status(_ row: CashoutRecord, recipients: [String]) async throws -> [String: Any] {
    let group: [String: Any] = [
      "plan": try CashoutJSON.object(EarnValues.json(row.plan)), "recipients": recipients,
    ]
    let children: [Any] = try row.children.map { child in
      guard let signed = child.signedData else { return NSNull() }
      guard let prepared = child.preparedText else { throw WalletFailure.invalid }
      var proof: [String: Any] = [
        "recoveryEnvelope": try CashoutJSON.string(
          CashoutJSON.object(prepared), "recoveryEnvelope"),
        "submittedIntent": try CashoutJSON.object(signed),
      ]
      if let hash = child.intentHash { proof["intentHash"] = hash }
      return proof
    }
    func request(_ hints: [[String]]) async throws -> [String: Any] {
      let owners = try await authenticate(row.plan.proposal.sources)
      try require(owners.count == row.plan.proposal.sources.count)
      var result = try await post(
        "group-status",
        [
          "group": group, "owners": owners,
          "children": children, "destinationTransactionHashes": hints,
        ])
      let received = now()
      let observed = try CashoutJSON.uint(result, "observedAtMs")
      try require(
        Double(received) - Double(observed) >= -5000 && Double(received) - Double(observed) <= 60000
      )
      result["nativeReceivedAtMs"] = received
      return result
    }
    var result = try await request(Array(repeating: [], count: recipients.count))
    if result["status"] as? String != "awaitingReceipt" {
      try require(result["status"] as? String == "pending")
      return result
    }
    try require(row.children.allSatisfy { $0.signedData != nil })
    var references: [[String: Any]] = []
    var scans: [CashoutScan] = []
    if let saved = row.groupScan { try require(saved.count == recipients.count) }
    for slot in recipients.indices {
      let candidates = try row.children.filter { $0.plan.slot == slot }.map {
        child -> [String: Any] in
        guard let text = child.preparedText else { throw WalletFailure.invalid }
        return try CashoutJSON.object(text)
      }
      let sorted = try candidates.sorted { left, right in
        try !EarnValues.atLeast(
          CashoutJSON.string(left, "referenceBlock"), CashoutJSON.string(right, "referenceBlock"))
      }
      guard let reference = sorted.first else { throw WalletFailure.invalid }
      references.append(reference)
      scans.append(try await receipts.scan(quote: reference, saved: row.groupScan?[slot]))
    }
    if scans.allSatisfy(\.complete) {
      result = try await request(scans.map(\.transactionHashes))
      if result["status"] as? String == "paid" {
        try require(
          result["authenticated"] as? Bool == true && result["operationScoped"] as? Bool == true
            && result["verification"] as? String == "destination-receipt-group-v1")
        guard let slots = result["slots"] as? [[String: Any]], slots.count == recipients.count
        else { throw WalletFailure.invalid }
        var events = Set<String>()
        for slot in recipients.indices {
          let proof = slots[slot]
          try require(
            try CashoutJSON.uint(proof, "slot") == UInt64(slot)
              && CashoutJSON.string(proof, "destinationRecipient").lowercased()
                == recipients[slot].lowercased()
          )
          let minimum = try earnAmountSum(
            values: row.children.filter { $0.plan.slot == slot }.map(\.minimumDestinationAtoms))
          try require(proof["minimumDestinationAtoms"] as? String == minimum)
          var confirmed: [CashoutReceipt] = []
          for hash in scans[slot].transactionHashes {
            confirmed += try await receipts.confirm(quote: references[slot], transactionHash: hash)
          }
          guard let reported = proof["receipts"] as? [[String: Any]],
            reported.count == confirmed.count
          else { throw WalletFailure.invalid }
          for receipt in reported {
            let hash = try EarnValues.hash(CashoutJSON.string(receipt, "transactionHash"))
            let index = try CashoutJSON.uint(receipt, "logIndex")
            try require(events.insert("\(hash):\(index)").inserted)
            let matching = confirmed.filter { $0.transactionHash == hash && $0.logIndex == index }
            try require(matching.count == 1)
            let exact = matching[0]
            try require(
              try exact.receivedAtoms == CashoutJSON.string(receipt, "receivedAtoms")
                && exact.blockNumber == CashoutJSON.string(receipt, "blockNumber")
                && exact.blockHash == EarnValues.hash(CashoutJSON.string(receipt, "blockHash")))
          }
          let total = try earnAmountSum(values: confirmed.map(\.receivedAtoms))
          try require(
            try proof["receivedAtoms"] as? String == total && EarnValues.atLeast(total, minimum))
        }
      } else {
        try require(["pending", "awaitingReceipt"].contains(result["status"] as? String ?? ""))
      }
    }
    result["groupScan"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(scans))
    return result
  }
}
