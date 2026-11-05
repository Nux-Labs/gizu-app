import { z } from "zod";
import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";

const AURORA_API = "https://intents-api.aurora.dev/api";
const NEAR_RPC = "https://rpc.mainnet.near.org";
const TOKEN_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 20_000;

const tokenSchema = z.object({
  assetId: z.string().min(1),
  blockchain: z.string().min(1),
  symbol: z.string().min(1),
  decimals: z.number().int().nonnegative(),
  contractAddress: z.string().optional(),
});
const tokensSchema = z.object({ tokens: z.array(z.looseObject({})) });
const saltSchema = z.object({ result: z.object({ result: z.array(z.number().int().min(0).max(255)) }) });

export type AuroraToken = z.infer<typeof tokenSchema>;
export type AuroraJson = Record<string, unknown>;

export class AuroraIntents {
  private tokenCache: { until: number; tokens: AuroraToken[] } | null = null;

  constructor(
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly nearRpc: string = NEAR_RPC,
  ) {}

  async tokens(): Promise<AuroraToken[]> {
    if (this.tokenCache && this.tokenCache.until > Date.now()) return this.tokenCache.tokens;
    const body = tokensSchema.parse(await this.call("tokens"));
    const tokens = body.tokens.flatMap((token) => {
      const parsed = tokenSchema.safeParse(token);
      return parsed.success ? [parsed.data] : [];
    });
    this.tokenCache = { until: Date.now() + TOKEN_TTL_MS, tokens };
    return tokens;
  }

  async history(accessToken: string, depositAddress: string): Promise<AuroraJson> {
    const query = new URLSearchParams({depositAddress, status: "SUCCESS", depositType: "ORIGIN_CHAIN", recipientType: "CONFIDENTIAL_INTENTS", refundType: "ORIGIN_CHAIN", limit: "100"});
    const result = await this.call("account/history", {token: accessToken, query});
    if (!Array.isArray(result.items) || result.items.length > 100) throw new InfrastructureError(502, "AURORA_INVALID", "Invalid bounded private history");
    return {items: result.items};
  }

  quote(request: AuroraJson): Promise<AuroraJson> {
    return this.call("quote", { method: "POST", body: request });
  }

  generateIntent(signerId: string, depositAddress: string): Promise<AuroraJson> {
    return this.call("generate-intent", {
      method: "POST",
      body: { type: "swap_transfer", standard: "erc191", signerId, depositAddress },
    });
  }

  submitIntent(signedData: AuroraJson): Promise<AuroraJson> {
    return this.call("submit-intent", { method: "POST", body: { type: "swap_transfer", signedData } });
  }

  status(depositAddress: string, depositMemo?: string): Promise<AuroraJson> {
    const query = new URLSearchParams({ depositAddress });
    if (depositMemo) query.set("depositMemo", depositMemo);
    return this.call("status", { query });
  }

  authenticate(payload: string, signature: string): Promise<AuroraJson> {
    return this.call("auth/authenticate", {
      method: "POST",
      body: { signedData: { standard: "erc191", payload, signature } },
    });
  }

  balances(accessToken: string): Promise<AuroraJson> {
    return this.call("account/balances", { token: accessToken });
  }

  async authSalt(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.nearRpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "auth-salt",
          method: "query",
          params: { request_type: "call_function", finality: "final", account_id: "intents.near", method_name: "current_salt", args_base64: "" },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new InfrastructureError(503, "NEAR_RPC_UNAVAILABLE", "public intents salt unavailable", { cause: error });
    }
    if (!response.ok) throw new InfrastructureError(503, "NEAR_RPC_UNAVAILABLE", "public intents salt unavailable");
    const parsed = saltSchema.safeParse(await response.json());
    if (!parsed.success) throw new InfrastructureError(502, "NEAR_RPC_INVALID", "public intents salt is invalid");
    const salt = JSON.parse(Buffer.from(parsed.data.result.result).toString("utf8")) as unknown;
    if (typeof salt !== "string" || !/^[0-9a-f]{8}$/i.test(salt)) {
      throw new InfrastructureError(502, "NEAR_RPC_INVALID", "public intents salt is invalid");
    }
    return salt.toLowerCase();
  }

  private async call(
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown; token?: string; query?: URLSearchParams } = {},
  ): Promise<AuroraJson> {
    const url = `${AURORA_API}/${path}/${encodeURIComponent(this.key)}${options.query ? `?${options.query}` : ""}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? "GET",
        headers: {
          "content-type": "application/json",
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new InfrastructureError(503, "AURORA_UNAVAILABLE", `Aurora ${path} unavailable`, { cause: error });
    }
    if (response.status === 401) throw new InfrastructureError(401, "AURORA_UNAUTHORIZED", `Aurora ${path} rejected the credentials`);
    if (response.status >= 400 && response.status < 500) {
      throw new InfrastructureError(422, "AURORA_REJECTED", `Aurora ${path} rejected the request: ${await this.reason(response)}`);
    }
    if (!response.ok) throw new InfrastructureError(503, "AURORA_UNAVAILABLE", `Aurora ${path} unavailable (${response.status})`);
    const body = (await response.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new InfrastructureError(502, "AURORA_INVALID", `Aurora ${path} returned an invalid body`);
    }
    return body as AuroraJson;
  }

  private async reason(response: Response): Promise<string> {
    const text = await response.text().catch(() => "");
    let reason = text;
    try {
      const body = JSON.parse(text) as { message?: unknown; error?: unknown };
      reason = String(body.message ?? body.error ?? "");
    } catch {
      // Plain-text provider errors are used as-is.
    }
    return reason.split(this.key).join("<key>").slice(0, 200) || String(response.status);
  }
}
