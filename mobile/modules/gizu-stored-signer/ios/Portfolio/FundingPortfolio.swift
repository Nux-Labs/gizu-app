import Foundation

internal struct FundingObservation {
  let sourceChainId: Int
  let accountIndex: UInt32
  let owner: String
  let balanceAtoms: String?
  let checkedAt: UInt64
  let complete: Bool
  let stale: Bool
  let syncPending: Bool
  var reservedAtoms: String? = "0"
}

internal enum FundingPortfolioError: Error { case invalid }

internal func fundingUsdc(_ chain: Int) throws -> String {
  switch chain {
  case 143: return "0x754704bc059f8c67012fed69bc8a327a5aafb603"
  case 8453: return "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
  case 42161: return "0xaf88d065e77c8cc2239327c5edb3a432268e5831"
  default: throw FundingPortfolioError.invalid
  }
}

/// Exact decimal uint256 arithmetic; Foundation Decimal loses precision above 38 digits.
internal enum FundingAtoms {
  static let maximum = "115792089237316195423570985008687907853269984665640564039457584007913129639935"
  static func less(_ a: String, _ b: String) -> Bool { a.count == b.count ? a < b : a.count < b.count }
  static func validate(_ text: String) throws -> String {
    guard text.range(of: "^(?:0|[1-9][0-9]{0,77})$", options: .regularExpression) != nil,
      !less(maximum, text) else { throw FundingPortfolioError.invalid }
    return text
  }
  static func add(_ a: String, _ b: String) throws -> String {
    let lhs = Array(a.utf8.reversed()), rhs = Array(b.utf8.reversed())
    var carry = 0, result = [UInt8]()
    for i in 0..<max(lhs.count, rhs.count) {
      let digit = (i < lhs.count ? Int(lhs[i] - 48) : 0) + (i < rhs.count ? Int(rhs[i] - 48) : 0) + carry
      result.append(UInt8(digit % 10) + 48)
      carry = digit / 10
    }
    if carry > 0 { result.append(UInt8(carry) + 48) }
    return try validate(String(bytes: result.reversed(), encoding: .utf8)!)
  }
  static func subtract(_ a: String, _ b: String) -> String {
    if less(a, b) { return "0" }
    let lhs = Array(a.utf8.reversed()), rhs = Array(b.utf8.reversed())
    var borrow = 0, result = [UInt8]()
    for i in lhs.indices {
      var digit = Int(lhs[i] - 48) - (i < rhs.count ? Int(rhs[i] - 48) : 0) - borrow
      borrow = digit < 0 ? 1 : 0
      if digit < 0 { digit += 10 }
      result.append(UInt8(digit) + 48)
    }
    while result.count > 1 && result.last == 48 { result.removeLast() }
    return String(bytes: result.reversed(), encoding: .utf8)!
  }
}

internal func fundingPortfolio(_ observations: [FundingObservation]) throws -> [String: Any] {
  var seen = Set<String>(), observed = "0", available = "0"
  let rows: [[String: Any]] = try observations.map { source in
    let token = try fundingUsdc(source.sourceChainId)
    guard source.owner.range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil,
      source.sourceChainId == 143 ? source.accountIndex != 0 : source.accountIndex == 1
    else { throw FundingPortfolioError.invalid }
    let identity = "\(source.sourceChainId):\(token):\(source.owner.lowercased())"
    guard seen.insert(identity).inserted else { throw FundingPortfolioError.invalid }
    let balance = try source.balanceAtoms.map(FundingAtoms.validate)
    let reserved = try source.reservedAtoms.map(FundingAtoms.validate)
    let fresh = balance != nil && source.complete && !source.stale && !source.syncPending
    let spendable = fresh && reserved != nil ? FundingAtoms.subtract(balance!, reserved!) : nil
    observed = try FundingAtoms.add(observed, balance ?? "0")
    available = try FundingAtoms.add(available, spendable ?? "0")
    return [
      "sourceId": identity, "sourceChainId": source.sourceChainId, "token": token,
      "decimals": 6, "accountIndex": source.accountIndex, "owner": source.owner.lowercased(),
      "balanceAtoms": (fresh ? balance : nil) as Any? ?? NSNull(),
      "observedAtoms": balance as Any? ?? NSNull(),
      "reservedAtoms": reserved as Any? ?? NSNull(),
      "availableAtoms": spendable as Any? ?? NSNull(),
      "complete": fresh && reserved != nil, "stale": !fresh,
      "syncPending": source.syncPending || !fresh || reserved == nil, "checkedAt": source.checkedAt,
    ]
  }
  let complete = [143, 8453, 42161].allSatisfy { chain in observations.contains { $0.sourceChainId == chain && $0.accountIndex == 1 } }
    && rows.allSatisfy { $0["complete"] as? Bool == true }
  return ["fundingSources": rows, "fundingCash": [
    "observedAtoms": observed, "availableAtoms": complete ? available as Any : NSNull(),
    "complete": complete, "stale": rows.contains { $0["stale"] as? Bool == true }, "syncPending": !complete,
  ]]
}
