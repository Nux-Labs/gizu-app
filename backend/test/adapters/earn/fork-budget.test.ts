import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPinnedFork } from "../../../src/adapters/earn/fork-simulation.ts";

test("spawned forks leave RPC capacity for live nonce reads instead of requesting 1000CU/s each", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "gizu-fork-budget-"));
  const executable = join(scratch, "record-anvil.mjs");
  const recorded = join(scratch, "arguments.json");
  await writeFile(
    executable,
    `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(recorded)},JSON.stringify(process.argv.slice(2)));\n`,
    { mode: 0o700 },
  );
  try {
    await assert.rejects(
      withPinnedFork(
        {
          rpcUrl: "http://127.0.0.1:1",
          anvilPath: executable,
          block: {
            number: 10n,
            hash: "0x" + "a".repeat(64),
            timestamp: 1000n,
            baseFeePerGas: 1n,
            gasUsed: 1n,
            gasLimit: 2n,
          },
          timeoutMs: 1000,
        },
        async () => {
          throw new Error("Recorder cannot simulate or submit");
        },
      ),
    );
    const args = JSON.parse(await readFile(recorded, "utf8")) as string[];
    assert.equal(args[args.indexOf("--compute-units-per-second") + 1], "150");
    assert.equal(args[args.indexOf("--host") + 1], "127.0.0.1");
    assert.equal(args[args.indexOf("--accounts") + 1], "0");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
