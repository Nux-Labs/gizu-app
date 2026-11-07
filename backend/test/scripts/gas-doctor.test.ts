import test from "node:test";
import assert from "node:assert/strict";
import { runGasDoctor, parseGasDoctorInput } from "../../scripts/gas-doctor.ts";

test("gas doctor defaults to offline production math and cross-language fixtures", async () => {
  const report = await runGasDoctor([]);
  assert.equal(report.mode, "offline");
  assert.equal(report.policyVersion, "gizu-gas-v1");
  assert.equal(report.ok, true);
  assert.equal(report.signingAvailable, false);
  assert.equal(report.submitted, false);
  assert.ok(
    report.checks.some((row) => row.name.includes("fractional-token-charge")),
  );
  assert.ok(report.checks.some((row) => row.name.includes("approval")));
  assert.ok(report.checks.some((row) => row.name.includes("oscillation")));
  assert.ok(
    report.checks.some(
      (row) => row.name === "budget.full-balance-fractional-swap" && row.ok,
    ),
  );
});

test("live mode must be explicit and rejects missing, ambiguous and oversized inputs", async () => {
  await assert.rejects(runGasDoctor(["--live"]), /input/i);
  await assert.rejects(runGasDoctor(["--live", "--offline"]), /mode/i);
  await assert.rejects(runGasDoctor(["--send"]), /argument/i);
  for (const bad of [
    null,
    {},
    { chainId: 10 },
    {
      chainId: 143,
      kind: "token-transfer",
      owner: "0x" + "1".repeat(40),
      recipient: "0x" + "2".repeat(40),
      amountAtoms: "0",
    },
  ]) {
    assert.throws(() => parseGasDoctorInput(bad));
  }
});

test("a read-only provider failure is reported using fixed codes without request or credential data", async () => {
  const request = {
    chainId: 143,
    kind: "token-transfer",
    owner: "0x" + "1".repeat(40),
    recipient: "0x" + "2".repeat(40),
    amountAtoms: "1000000",
    budgetAtoms: "2000000",
  };
  const report = await runGasDoctor(["--live"], request, async () => {
    throw Object.assign(
      new Error(
        `Provider https://private.invalid/?apikey=secret owner=${request.owner}`,
      ),
      { code: "GAS_PRIVATE_SECRET" },
    );
  });
  assert.equal(report.ok, false);
  assert.equal(report.submitted, false);
  assert.equal(report.checks.at(-1)?.code, "GAS_PREPARATION_UNAVAILABLE");
  const text = JSON.stringify(report);
  for (const secret of [
    "secret",
    request.owner,
    request.recipient,
    "private.invalid",
  ])
    assert.equal(text.includes(secret), false);
  assert.equal(text.includes("GAS_PRIVATE_SECRET"), false);
});
