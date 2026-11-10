import Foundation

/** Private native transport; no injectable URL or auth payload in the Expo API. */
internal final class ConfidentialBalance: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
  private func post(_ endpoint: String, _ body: [String: Any]) async throws -> [String: Any] {
    var request=URLRequest(url:URL(string:endpoint)!)
    request.httpMethod="POST"
    request.timeoutInterval=12
    request.setValue("application/json",forHTTPHeaderField:"Content-Type")
    request.httpBody=try JSONSerialization.data(withJSONObject:body)
    let config=URLSessionConfiguration.ephemeral
    config.urlCache=nil; config.httpCookieStorage=nil
    let session=URLSession(configuration:config,delegate:self,delegateQueue:nil)
    defer { session.invalidateAndCancel() }
    let (stream,response)=try await session.bytes(for:request)
    try require((response as? HTTPURLResponse)?.statusCode==200)
    var bytes=Data()
    for try await byte in stream { try require(bytes.count<1_048_576); bytes.append(byte) }
    guard let result=try JSONSerialization.jsonObject(with:bytes) as? [String:Any] else { throw WalletFailure.invalid }
    return result
  }
  func salt() async throws -> Data {
    let row=try await post("https://rpc.mainnet.near.org",["jsonrpc":"2.0","id":"earn-salt","method":"query","params":["request_type":"call_function","finality":"final","account_id":"intents.near","method_name":"current_salt","args_base64":""]])
    try require(row["jsonrpc"] as? String=="2.0" && row["id"] as? String=="earn-salt" && row["error"]==nil)
    guard let result=row["result"] as? [String:Any],let bytes=result["result"] as? [UInt8], bytes.count==10,
      let salt=try JSONSerialization.jsonObject(with:Data(bytes),options:.fragmentsAllowed) as? String
    else { throw WalletFailure.invalid }
    try require(salt.range(of:"^[0-9a-fA-F]{8}$",options:.regularExpression) != nil)
    var out=Data()
    for index in stride(from:0,to:8,by:2) {
      let a=salt.index(salt.startIndex,offsetBy:index), b=salt.index(a,offsetBy:2)
      guard let byte=UInt8(salt[a..<b],radix:16) else { throw WalletFailure.invalid }
      out.append(byte)
    }
    return out
  }
  func read(_ auth: EarnReadAuthentication,address: String) async throws -> [String:Any] {
    let row=try await post("https://api.gizu.io/v1/earn/private-balance",["signedData":["standard":"erc191","payload":auth.payload,"signature":auth.signature]])
    return try Self.publicBalance(row,address:address,now:Int64(Date().timeIntervalSince1970*1000))
  }
  static func publicBalance(_ row:[String:Any],address:String,now:Int64) throws -> [String:Any] {
    guard let received=row["confidentialAddress"] as? String,let asset=row["assetId"] as? String,
      let available=row["available"] as? String, let timestamp=row["timestampMs"] as? NSNumber
    else { throw WalletFailure.invalid }
    try require(received.lowercased()==address.lowercased() && received.range(of:"^0x[0-9a-fA-F]{40}$",options:.regularExpression) != nil)
    try require(row["authenticated"] as? Bool==true && row["operationScoped"] as? Bool==false)
    try require(asset=="nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx")
    try require(available.range(of:"^(0|[1-9][0-9]{0,77})$",options:.regularExpression) != nil)
    let max="115792089237316195423570985008687907853269984665640564039457584007913129639935"
    try require(available.count<max.count || (available.count==max.count && available<=max))
    let ms=timestamp.int64Value
    try require(timestamp.doubleValue==Double(ms) && ms>=0 && now-ms >= -5000 && now-ms<=60000)
    return ["confidentialAddress":address,"assetId":asset,"available":available,"timestampMs":ms,"authenticated":true,"operationScoped":false]
  }
}
