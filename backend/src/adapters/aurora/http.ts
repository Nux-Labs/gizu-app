export class AuroraRouteUnavailable extends Error { constructor(){super("EARN_AURORA_ROUTE_UNAVAILABLE");} }
/** Fixed classification only; never retain the provider's response or request URL. */
export class AuroraHistoryAccessRequired extends Error { constructor(){super("EARN_AURORA_HISTORY_ACCESS_REQUIRED");} }
/** Provider credentials and bounded transport stay on the server. */
function record(v:unknown):Record<string,unknown> {
  if(!v || typeof v!=="object" || Array.isArray(v)) throw new Error("Invalid provider response");
  return v as Record<string,unknown>;
}
export async function auroraApi(key: string, fetcher: typeof fetch, path: string, body?: unknown, token?: string): Promise<Record<string, unknown>> {
    const response = await fetcher(`https://intents-api.aurora.dev/api/${path.replace("{key}", encodeURIComponent(key))}`, {method: body ? "POST" : "GET",headers:{"content-type":"application/json",...(token ? {Authorization:`Bearer ${token}`} : {})},...(body ? {body:JSON.stringify(body)} : {}),signal:AbortSignal.timeout(12000),redirect:"error"});
    if (!response.body) throw new Error("Missing response body");
    const reader=response.body.getReader();
    const chunks: Uint8Array[]=[]; let size=0;
    try {
      for (;;) {
        const next=await reader.read(); if(next.done) break;
        size+=next.value.byteLength;
        if(size>(response.ok?1048576:4096)) { await reader.cancel(); throw new Error("Response too large"); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const result=record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if(!response.ok) {
      if(response.status===400 && path.split("?",1)[0]==="account/history/{key}" && result.message==="History is invite-only for now") throw new AuroraHistoryAccessRequired();
      if(response.status===400 && result.message==="Quoting for this pair is not available") throw new AuroraRouteUnavailable();
      throw new Error("Provider unavailable");
    }
    return result;
  }
