import assert from "node:assert/strict";
import test from "node:test";
import { auroraApi } from "../../../src/adapters/aurora/http.ts";

test("only the exact history invitation rejection gets a safe access classification", async () => {
  for (const [path, status, message, expected] of [
    [
      "account/history/{key}?limit=100",
      400,
      "History is invite-only for now",
      "EARN_AURORA_HISTORY_ACCESS_REQUIRED",
    ],
    [
      "account/history/{key}",
      400,
      "PRIVATE invalid query",
      "Provider unavailable",
    ],
    [
      "account/history/{key}",
      403,
      "History is invite-only for now",
      "Provider unavailable",
    ],
    [
      "auth/authenticate/{key}",
      400,
      "History is invite-only for now",
      "Provider unavailable",
    ],
  ] as const) {
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ message, privateData: "PRIVATE" }), {
        status,
      });
    await assert.rejects(
      auroraApi("private-key", fetcher, path),
      (error: Error) => {
        assert.equal(error.message, expected);
        assert.equal(JSON.stringify(error).includes("PRIVATE"), false);
        assert.equal(error.stack?.includes("private-key"), false);
        return true;
      },
    );
  }
});
