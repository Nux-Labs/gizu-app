import CoreFoundation
import Foundation

internal struct PortfolioRequest {
  let method: String
  let params: [Any]
}

internal protocol MainnetPortfolioRPC {
  func calls(_ requests: [PortfolioRequest]) async throws -> [Any]
}

/// Independent observation deadline for each source, shared across that source's batches.
internal struct BudgetedPortfolioRPC: MainnetPortfolioRPC {
  let upstream: MainnetPortfolioRPC
  let deadline: ContinuousClock.Instant
  let requestBudget: Duration
  init(upstream: MainnetPortfolioRPC, totalMilliseconds: Int = 10_000, requestMilliseconds: Int = 3_000) {
    self.upstream = upstream
    deadline = ContinuousClock.now.advanced(by: .milliseconds(totalMilliseconds))
    requestBudget = .milliseconds(requestMilliseconds)
  }
  func calls(_ requests: [PortfolioRequest]) async throws -> [Any] {
    try Task.checkCancellation()
    let remaining = ContinuousClock.now.duration(to: deadline)
    guard remaining > .zero else { throw URLError(.timedOut) }
    return try await withThrowingTaskGroup(of: [Any].self) { group in
      group.addTask { try await upstream.calls(requests) }
      group.addTask {
        try await Task.sleep(for: min(remaining, requestBudget))
        throw URLError(.timedOut)
      }
      defer { group.cancelAll() }
      guard let result = try await group.next() else { throw URLError(.timedOut) }
      return result
    }
  }
}

/// Fixed-chain native transport. Never shares or changes the testnet signing endpoint.
internal final class NativeMainnetPortfolioRPC: NSObject, MainnetPortfolioRPC,
  URLSessionTaskDelegate
{
  enum Network: String {
    case monad = "https://rpc.monad.xyz"
    case ethereum = "https://ethereum-rpc.publicnode.com"
    case robinhood = "https://rpc.mainnet.chain.robinhood.com"
    case base = "https://mainnet.base.org"
    case arbitrum = "https://arb1.arbitrum.io/rpc"
  }
  private let network: Network
  private let post: ((Data) async throws -> Data)?
  init(network: Network = .monad, post: ((Data) async throws -> Data)? = nil) {
    self.network = network
    self.post = post
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }

  private func send(_ body: Data) async throws -> Data {
    var request = URLRequest(url: URL(string: network.rawValue)!)
    request.httpMethod = "POST"
    request.timeoutInterval = 15
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = body
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.timeoutIntervalForResource = 20
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    let (stream, response) = try await session.bytes(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw WalletFailure.unavailable }
    var data = Data()
    for try await byte in stream {
      try Task.checkCancellation()
      guard data.count < 262_144 else { throw WalletFailure.invalid }
      data.append(byte)
    }
    return data
  }

  func calls(_ requests: [PortfolioRequest]) async throws -> [Any] {
    try Task.checkCancellation()
    try require(!requests.isEmpty && requests.count <= 40)
    let body = try JSONSerialization.data(
      withJSONObject: requests.enumerated().map { index, request in
        ["jsonrpc": "2.0", "id": index + 1, "method": request.method, "params": request.params]
      })
    let data: Data
    if let post { data = try await post(body) } else { data = try await send(body) }
    try Task.checkCancellation()
    try require(data.count <= 262_144)
    guard let rows = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
      rows.count == requests.count
    else { throw WalletFailure.invalid }
    var results: [Int: Any] = [:]
    for row in rows {
      guard let number = row["id"] as? NSNumber,
        CFGetTypeID(number) != CFBooleanGetTypeID(),
        number.doubleValue == Double(number.intValue),
        (1...requests.count).contains(number.intValue), results[number.intValue] == nil,
        row["jsonrpc"] as? String == "2.0", row["error"] == nil,
        let result = row["result"]
      else { throw WalletFailure.invalid }
      if result is NSNull {
        try require(["eth_getTransactionReceipt", "eth_getTransactionByHash"].contains(requests[number.intValue - 1].method))
      }
      results[number.intValue] = result
    }
    return try (1...requests.count).map {
      guard let value = results[$0] else { throw WalletFailure.invalid }
      return value
    }
  }
}
