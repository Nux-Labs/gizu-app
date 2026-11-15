import XCTest

@testable import GizuStoredSignerNative

private func receiptHash(_ value: String) -> String { "0x" + String(repeating: value, count: 64) }
private let recipient = "0x" + String(repeating: "2", count: 40)
private func receiptQuote() -> [String: Any] {
  [
    "destinationChainId": 143, "destinationToken": MainnetPortfolio.usdc,
    "destinationRecipient": recipient, "referenceBlock": "10", "referenceHash": receiptHash("a"),
    "observedAtMs": 1_000_000,
  ]
}
private func receiptLog(_ amount: String = "3000000", block: UInt64 = 11, index: UInt64 = 0) throws
  -> [String: Any]
{
  [
    "address": MainnetPortfolio.usdc,
    "topics": [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      receiptHash("0"), "0x" + (try EarnValues.addressWord(recipient)),
    ],
    "data": "0x" + (try earnAmountWord(value: amount)), "transactionHash": receiptHash("b"),
    "blockNumber": "0x" + String(block, radix: 16), "blockHash": receiptHash("e"),
    "logIndex": "0x" + String(index, radix: 16), "removed": false,
  ]
}
private final class ReceiptRPC: MainnetPortfolioRPC {
  var logs: [[String: Any]] = []
  var finalized: UInt64 = 12
  var reorg = false
  var callsToDeliveryBlock = 0
  var chain = "0x8f"
  var status = "0x1"
  var timestamp = "0x3e8"
  var ranges: [(UInt64, UInt64)] = []
  func calls(_ requests: [PortfolioRequest]) async throws -> [Any] {
    try requests.map { request in
      switch request.method {
      case "eth_chainId": return chain
      case "eth_getBlockByNumber":
        let tag = request.params[0] as! String
        let number = tag == "finalized" ? finalized : try EarnValues.uint(tag)
        if tag == "0xb" { callsToDeliveryBlock += 1 }
        return [
          "number": "0x" + String(number, radix: 16),
          "hash": receiptHash(number == 10 ? "a" : reorg && callsToDeliveryBlock > 1 ? "f" : "e"),
          "timestamp": timestamp,
        ]
      case "eth_getLogs":
        let filter = request.params[0] as! [String: Any]
        let from = try EarnValues.uint(filter["fromBlock"] as! String)
        let to = try EarnValues.uint(filter["toBlock"] as! String)
        ranges.append((from, to))
        return try logs.filter {
          try (from...to).contains(EarnValues.uint($0["blockNumber"] as! String))
        }
      case "eth_getTransactionReceipt":
        return [
          "transactionHash": receiptHash("b"), "status": status, "blockNumber": "0xb",
          "blockHash": receiptHash("e"), "logs": logs,
        ] as [String: Any]
      default: throw WalletFailure.invalid
      }
    }
  }
}
final class CashoutReceiptTests: XCTestCase {
  func testReceiptRequiresCanonicalFinalizedMatchingTransfer() async throws {
    let rpc = ReceiptRPC()
    rpc.logs = [try receiptLog("2500000", index: 0), try receiptLog("500123", index: 1)]
    let verifier = CashoutReceipts(rpc: rpc, now: { 1_000_000 })
    let receipts = try await verifier.confirm(
      quote: receiptQuote(), transactionHash: receiptHash("b"))
    XCTAssertEqual(receipts.map(\.receivedAtoms), ["2500000", "500123"])
    XCTAssertEqual(receipts.map(\.logIndex), [0, 1])
    XCTAssertEqual(rpc.callsToDeliveryBlock, 2)
  }
  func testRejectsReorgDuplicateEventsWrongChainAndUnfinalizedReceipt() async throws {
    for mutation in 0..<7 {
      let rpc = ReceiptRPC()
      rpc.logs = [try receiptLog()]
      switch mutation {
      case 0: rpc.reorg = true
      case 1: rpc.logs.append(rpc.logs[0])
      case 2: rpc.chain = "0x1"
      case 3: rpc.finalized = 10
      case 4: rpc.status = "0x0"
      case 5: rpc.logs[0]["removed"] = true
      default: rpc.timestamp = "0x1"
      }
      do {
        _ = try await CashoutReceipts(rpc: rpc, now: { 1_000_000 }).confirm(
          quote: receiptQuote(), transactionHash: receiptHash("b"))
        XCTFail("Accepted invalid receipt case \(mutation)")
      } catch {}
    }
  }
  func testScanPagesAt4096BlocksAndDeduplicatesTransactions() async throws {
    let rpc = ReceiptRPC()
    rpc.finalized = 5000
    rpc.logs = [try receiptLog(), try receiptLog("1", index: 1)]
    let verifier = CashoutReceipts(rpc: rpc)
    let first = try await verifier.scan(quote: receiptQuote(), saved: nil)
    XCTAssertEqual(first.transactionHashes, [receiptHash("b")])
    XCTAssertEqual(first.nextScanBlock, "4107")
    XCTAssertFalse(first.complete)
    let second = try await verifier.scan(quote: receiptQuote(), saved: first)
    XCTAssertTrue(second.complete)
    XCTAssertEqual(second.nextScanBlock, "5001")
    XCTAssertEqual(rpc.ranges[1].0, 4107)
  }
  func testScanWaitsForFinalityAndRejectsForeignAnchor() async throws {
    let rpc = ReceiptRPC()
    rpc.finalized = 9
    let verifier = CashoutReceipts(rpc: rpc)
    let result = try await verifier.scan(quote: receiptQuote(), saved: nil)
    XCTAssertTrue(result.transactionHashes.isEmpty)
    XCTAssertEqual(result.nextScanBlock, "11")
    var quote = receiptQuote()
    quote["referenceHash"] = receiptHash("c")
    do {
      _ = try await verifier.scan(quote: quote, saved: nil)
      XCTFail()
    } catch {}
    do {
      _ = try await verifier.scan(quote: receiptQuote(), saved: CashoutScan(nextScanBlock: "1"))
      XCTFail()
    } catch {}
  }
  func testGatewayRejectsPaidWithoutIndependentReceiptScan() async throws {
    let p = CashoutProposal(
      operationId: "cash_group", amountAtoms: "3000000",
      sources: [
        CashoutSource(
          kind: "swap", profileChainId: 0, cycleIndex: 0, address: recipient, amountAtoms: "3000000"
        )
      ], recipientIndices: [3], weightsBps: [10000])
    let plan = try JSONDecoder().decode(
      CashoutPlan.self, from: Data(confidentialWithdrawalPlan(proposal: EarnValues.json(p)).utf8))
    let row = CashoutRecord(
      walletId: "wallet", operationId: p.operationId, plan: plan,
      children: plan.children.map { CashoutChild(plan: $0) })
    let gateway = NativeCashoutGateway(
      authenticate: { sources in sources.map { _ in [:] } },
      transport: { _, _ in
        ["status": "paid", "observedAtMs": 1_000_000]
      }, now: { 1_000_000 })
    do {
      _ = try await gateway.status(row, recipients: [recipient])
      XCTFail()
    } catch {}
  }
  func testGatewayChecksEveryReportedEventAgainstNativeReceipts() async throws {
    for forged in [false, true] {
      let p = CashoutProposal(
        operationId: "cash_group", amountAtoms: "3000000",
        sources: [
          CashoutSource(
            kind: "swap", profileChainId: 0, cycleIndex: 0, address: recipient,
            amountAtoms: "3000000")
        ], recipientIndices: [3], weightsBps: [10000])
      let plan = try JSONDecoder().decode(
        CashoutPlan.self, from: Data(confidentialWithdrawalPlan(proposal: EarnValues.json(p)).utf8))
      var child = CashoutChild(plan: plan.children[0])
      child.signedData = "{}"
      child.minimumDestinationAtoms = "2999000"
      var quote = receiptQuote()
      quote["recoveryEnvelope"] = "sealed"
      child.preparedText = try CashoutJSON.text(quote)
      let row = CashoutRecord(
        walletId: "wallet", operationId: p.operationId, plan: plan, children: [child])
      let rpc = ReceiptRPC()
      rpc.logs = [try receiptLog()]
      var calls = 0
      let gateway = NativeCashoutGateway(
        authenticate: { sources in sources.map { _ in [:] } },
        receipts: CashoutReceipts(rpc: rpc, now: { 1_000_000 }),
        transport: { path, body in
          XCTAssertEqual(path, "group-status")
          calls += 1
          if calls == 1 { return ["status": "awaitingReceipt", "observedAtMs": 1_000_000] }
          XCTAssertEqual(body["destinationTransactionHashes"] as? [[String]], [[receiptHash("b")]])
          return [
            "status": "paid", "observedAtMs": 1_000_000, "authenticated": true,
            "operationScoped": true, "verification": "destination-receipt-group-v1",
            "slots": [
              [
                "slot": 0, "destinationRecipient": recipient, "minimumDestinationAtoms": "2999000",
                "receivedAtoms": "3000000",
                "receipts": [
                  [
                    "transactionHash": receiptHash("b"), "logIndex": 0,
                    "receivedAtoms": forged ? "3000001" : "3000000", "blockNumber": "11",
                    "blockHash": receiptHash("e"),
                  ]
                ],
              ]
            ],
          ]
        }, now: { 1_000_000 })
      do {
        let result = try await gateway.status(row, recipients: [recipient])
        XCTAssertFalse(forged)
        XCTAssertEqual(result["status"] as? String, "paid")
      } catch { XCTAssertTrue(forged, "Valid native receipt rejected: \(error)") }
      XCTAssertEqual(calls, 2)
    }
  }

}
