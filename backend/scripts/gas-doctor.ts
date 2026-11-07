/** Uses the app's production gas helpers. Offline by default; live mode is read-only. */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  createPublicClient,
  defineChain,
  http,
} from "viem";
import type { Address, Hex } from "viem";
import { mainnet } from "viem/chains";
import {
  erc20PaymasterCap,
  fundingApproval,
  fundingFeeCap,
  feeEnvelope,
  mulDiv,
  nativeGasCost,
  uint256,
} from "../src/adapters/evm/gas-policy.ts";
import { stabilizePaymasterApproval } from "../src/adapters/evm/token-paymaster.ts";
import { feePolicy } from "../src/adapters/earn/policy.ts";
import { GasPolicyError } from "../src/adapters/evm/gas-errors.ts";

type Check = {
  name: string;
  ok: boolean;
  code?: string;
  values?: Record<string, string | number | boolean>;
};
type Report = {
  policyVersion: string;
  mode: "offline" | "read-only";
  ok: boolean;
  signingAvailable: false;
  submitted: false;
  checks: Check[];
};
const atom = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/)
  .refine((value) => BigInt(value) < 1n << 256n);
const address = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/i)
  .refine((value) => !/^0x0{40}$/i.test(value));
const requestSchema = z
  .object({
    chainId: z.union([
      z.literal(1),
      z.literal(143),
      z.literal(4663),
      z.literal(10143),
    ]),
    kind: z.enum(["native-transfer", "token-transfer"]),
    owner: address,
    recipient: address,
    amountAtoms: atom,
    budgetAtoms: atom,
  })
  .strict()
  .refine(
    (value) => value.owner.toLowerCase() !== value.recipient.toLowerCase(),
  )
  .refine((value) => BigInt(value.amountAtoms) <= BigInt(value.budgetAtoms))
  .refine(
    (value) => value.chainId !== 10143 || value.kind === "native-transfer",
  );
export type GasDoctorInput = z.infer<typeof requestSchema>;
export function parseGasDoctorInput(value: unknown): GasDoctorInput {
  const result = requestSchema.safeParse(value);
  if (!result.success) throw new Error("Invalid gas diagnostic input");
  return result.data;
}
const token = getAddress("0x" + "11".repeat(20));
const paymaster = getAddress("0x" + "22".repeat(20));
const word = (value: string | bigint, bytes: number) =>
  BigInt(value)
    .toString(16)
    .padStart(bytes * 2, "0");
function data(postOpGas: string | bigint, rate: string | bigint): Hex {
  return `0x0200${word(0n, 12)}${token.slice(2)}${word(postOpGas, 16)}${word(rate, 32)}${"00".repeat(100)}`;
}
type VectorFile = {
  version: string;
  paymasterVectors: {
    name: string;
    gas: Record<string, string>;
    postOpGas: string;
    exchangeRate: string;
    maxFeePerGas: string;
    floorAtoms: string;
    ceilingAtoms: string;
    swapApprovalAtoms: string;
    earnApprovalAtoms: string;
  }[];
  arithmeticVectors: {
    name: string;
    a: string;
    b: string;
    denominator: string;
    floor: string;
    ceiling: string;
  }[];
  balanceVectors: {
    name: string;
    paymasterVector: string;
    balanceAtoms: string;
    principalAtoms: string;
    maximumFeeAtoms: string;
    approvalAtoms: string;
  }[];
};

async function offlineChecks(): Promise<{ version: string; checks: Check[] }> {
  const fixtures = JSON.parse(
    readFileSync(
      new URL("../../shared/gas-policy-v1.json", import.meta.url),
      "utf8",
    ),
  ) as VectorFile;
  if (
    fixtures.version !== "gizu-gas-v1" ||
    !fixtures.paymasterVectors.length ||
    !fixtures.arithmeticVectors.length
  )
    throw new Error("Invalid gas conformance fixtures");
  const checks: Check[] = [];
  for (const vector of fixtures.paymasterVectors) {
    const gas = Object.fromEntries(
      Object.entries(vector.gas).map(([key, value]) => [key, BigInt(value)]),
    );
    const operation = {
      ...gas,
      maxFeePerGas: BigInt(vector.maxFeePerGas),
      maxPriorityFeePerGas: 0n,
      paymasterData: data(vector.postOpGas, vector.exchangeRate),
    };
    const floor = erc20PaymasterCap(operation, { token, rounding: "floor" });
    const ceiling = erc20PaymasterCap(operation, { token, rounding: "ceil" });
    checks.push({
      name: `paymaster.${vector.name}`,
      ok:
        floor.toString() === vector.floorAtoms &&
        ceiling.toString() === vector.ceilingAtoms,
      values: {
        protocolCapAtoms: floor.toString(),
        conservativeCapAtoms: ceiling.toString(),
      },
    });
    const swapCap = fundingFeeCap(operation, token, "swap");
    const earnCap = fundingFeeCap(operation, token, "earn");
    checks.push({
      name: `approval.${vector.name}.profiles`,
      ok:
        fundingApproval(swapCap, "swap").toString() ===
          vector.swapApprovalAtoms &&
        fundingApproval(earnCap, "earn").toString() ===
          vector.earnApprovalAtoms &&
        swapCap === floor &&
        earnCap === ceiling,
    });
  }
  for (const vector of fixtures.balanceVectors) {
    const terms = fixtures.paymasterVectors.find(
      (row) => row.name === vector.paymasterVector,
    );
    if (!terms) throw new Error("Missing balance conformance terms");
    const operation = {
      ...Object.fromEntries(
        Object.entries(terms.gas).map(([key, value]) => [key, BigInt(value)]),
      ),
      maxFeePerGas: BigInt(terms.maxFeePerGas),
      maxPriorityFeePerGas: 0n,
      paymasterData: data(terms.postOpGas, terms.exchangeRate),
    };
    const cap = fundingFeeCap(operation, token, "swap");
    checks.push({
      name: `budget.${vector.name}`,
      ok:
        BigInt(vector.principalAtoms) + cap === BigInt(vector.balanceAtoms) &&
        cap.toString() === vector.maximumFeeAtoms &&
        fundingApproval(cap, "swap").toString() === vector.approvalAtoms,
      values: {
        principalAtoms: vector.principalAtoms,
        maximumFeeAtoms: cap.toString(),
        fullBalance: true,
      },
    });
  }
  for (const vector of fixtures.arithmeticVectors) {
    const floor = mulDiv(
      BigInt(vector.a),
      BigInt(vector.b),
      BigInt(vector.denominator),
      "floor",
    );
    const ceiling = mulDiv(
      BigInt(vector.a),
      BigInt(vector.b),
      BigInt(vector.denominator),
      "ceil",
    );
    checks.push({
      name: `arithmetic.${vector.name}`,
      ok:
        floor.toString() === vector.floor &&
        ceiling.toString() === vector.ceiling,
    });
  }
  let envelope = 0n;
  for (const cap of [10000n, 10001n, 10000n, 10001n])
    envelope = feeEnvelope(envelope, cap, 105n, 100n);
  checks.push({
    name: "fee-budget.oscillation",
    ok: envelope === 10502n,
    values: { feeBudgetAtoms: envelope.toString() },
  });
  const initial = {
    callData: "0x" as Hex,
    paymaster,
    paymasterData: data(1n, 10n ** 18n + 1n),
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 0n,
    preVerificationGas: 1n,
    callGasLimit: 1n,
    verificationGasLimit: 1n,
    paymasterPostOpGasLimit: 1n,
    paymasterVerificationGasLimit: 1n,
  };
  const batchAbi = parseAbi([
    "function executeBatch((address target,uint256 value,bytes data)[] calls)",
  ]);
  const cap = (operation: typeof initial) =>
    erc20PaymasterCap(operation, { token, rounding: "ceil" });
  let estimates = 0;
  const stable = await stabilizePaymasterApproval({
    initial,
    allowance: 0n,
    token,
    paymaster,
    cap,
    calls: [
      {
        to: token,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [paymaster, 100n],
        }),
      },
    ],
    encode: async (calls) =>
      encodeFunctionData({
        abi: batchAbi,
        functionName: "executeBatch",
        args: [
          calls.map((call) => ({
            target: call.to,
            value: call.value ?? 0n,
            data: call.data ?? "0x",
          })),
        ],
      }),
    estimate: async (operation) => {
      estimates++;
      return { ...operation, paymasterData: data(1n, 2n * 10n ** 18n + 1n) };
    },
  });
  const decoded = decodeFunctionData({ abi: batchAbi, data: stable.callData });
  const approval = decodeFunctionData({
    abi: erc20Abi,
    data: decoded.args[0][0]!.data,
  });
  const allowance = approval.functionName === "approve" ? approval.args[1] : 0n;
  checks.push({
    name: "approval.final-calldata-and-rate",
    ok:
      estimates >= 2 &&
      allowance >= cap(stable) &&
      allowance <= mulDiv(cap(stable), 101n, 100n, "ceil"),
    values: {
      estimates,
      allowanceAtoms: allowance.toString(),
      finalFeeCapAtoms: cap(stable).toString(),
    },
  });
  return { version: fixtures.version, checks };
}

/** The input is consumed for this operation only. Neither it nor provider errors are logged. */
async function prepareReadOnly(input: GasDoctorInput): Promise<Check[]> {
  const { resolveEnv } = await import("../src/secret/env-file.ts");
  const env = resolveEnv(fileURLToPath(new URL("../", import.meta.url)));
  const owner = getAddress(input.owner),
    recipient = getAddress(input.recipient);
  const amount = uint256(BigInt(input.amountAtoms), true),
    budget = uint256(BigInt(input.budgetAtoms), true);
  if (input.kind === "token-transfer" && input.chainId === 143) {
    const { MonadFundingPlanner } =
      await import("../src/adapters/pimlico/source-funding.ts");
    const plan = await new MonadFundingPlanner(
      env.PIMLICO_API_KEY,
      env.MONAD_RPC_URL ?? "https://rpc.monad.xyz",
    ).prepare({
      owner,
      recipient,
      amount: amount.toString(),
      budget: budget.toString(),
    });
    return [
      {
        name: "live.monad-token-funding",
        ok: true,
        values: {
          chainId: 143,
          feeAsset: "USDC",
          amountAtoms: plan.amount,
          maximumFeeAtoms: plan.feeCap,
          expiresAtMs: plan.expiresAtMs,
        },
      },
    ];
  }
  if (input.kind === "token-transfer" && input.chainId === 4663) {
    const { createRobinhoodPaymaster } =
      await import("../src/adapters/earn/robinhood-paymaster.ts");
    const { robinhoodChain, ROBINHOOD_PROFILE } =
      await import("../src/adapters/earn/robinhood-vault.ts");
    const client = createPublicClient({
      chain: robinhoodChain,
      transport: http(
        env.ROBINHOOD_RPC_URL ?? robinhoodChain.rpcUrls.default.http[0],
        { timeout: 12000, retryCount: 0 },
      ),
      cacheTime: 0,
    });
    const held = await client.readContract({
      address: ROBINHOOD_PROFILE.token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    });
    if (held < budget) throw new Error("Insufficient diagnostic budget");
    const provider = await createRobinhoodPaymaster(
      client,
      owner,
      env.PIMLICO_API_KEY ?? "",
    );
    const market = await provider.market();
    const fees = {
      maxFeePerGas: mulDiv(market.maxFeePerGas, 110n, 100n, "ceil"),
      maxPriorityFeePerGas: mulDiv(
        market.maxPriorityFeePerGas,
        110n,
        100n,
        "ceil",
      ),
    };
    const plan = await provider.prepare(
      [
        {
          to: ROBINHOOD_PROFILE.token,
          value: 0n,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [recipient, amount],
          }),
        },
      ],
      fees,
    );
    if (amount + plan.feeCap > budget)
      throw new Error("Insufficient diagnostic budget");
    return [
      {
        name: "live.robinhood-token-funding",
        ok: true,
        values: {
          chainId: 4663,
          feeAsset: "USDG",
          amountAtoms: amount.toString(),
          maximumFeeAtoms: plan.feeCap.toString(),
        },
      },
    ];
  }
  const rpcUrl =
    input.chainId === 1
      ? (env.ETHEREUM_RPC_URL ?? "https://ethereum-rpc.publicnode.com")
      : input.chainId === 143
        ? (env.MONAD_RPC_URL ?? "https://rpc.monad.xyz")
        : input.chainId === 4663
          ? (env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com")
          : (env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz");
  const chain =
    input.chainId === 1
      ? mainnet
      : defineChain({
          id: input.chainId,
          name: "Diagnostic chain",
          nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
          rpcUrls: { default: { http: [rpcUrl] } },
        });
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 12000, retryCount: 0 }),
    cacheTime: 0,
  });
  if ((await client.getChainId()) !== input.chainId)
    throw new Error("Wrong diagnostic chain");
  const block = await client.getBlock();
  const [code, targetCode, held, nonce, pending] = await Promise.all([
    client.getCode({ address: owner, blockNumber: block.number }),
    client.getCode({ address: recipient, blockNumber: block.number }),
    client.getBalance({ address: owner, blockNumber: block.number }),
    client.getTransactionCount({ address: owner, blockNumber: block.number }),
    client.getTransactionCount({ address: owner, blockTag: "pending" }),
  ]);
  if (
    (code && code !== "0x") ||
    nonce !== pending ||
    (input.kind === "native-transfer" && targetCode && targetCode !== "0x")
  )
    throw new Error("Unsupported diagnostic account state");
  const history = await client.getFeeHistory({
    blockCount: 8,
    rewardPercentiles: [50],
  });
  const fees = feePolicy(
    {
      number: block.number,
      hash: block.hash,
      timestamp: block.timestamp,
      baseFeePerGas: block.baseFeePerGas ?? 0n,
      gasUsed: block.gasUsed,
      gasLimit: block.gasLimit,
    },
    (history.reward ?? []).map((row) => row[0]!),
  );
  const usdc = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  if (input.kind === "token-transfer" && input.chainId !== 1)
    throw new Error("Unsupported fee model");
  const gas = await client.estimateGas(
    input.kind === "native-transfer"
      ? { account: owner, to: recipient, value: amount }
      : {
          account: owner,
          to: usdc,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [recipient, amount],
          }),
        },
  );
  const limit =
    input.kind === "native-transfer" ? gas : mulDiv(gas, 110n, 100n, "ceil");
  if (input.kind === "native-transfer" && gas !== 21000n)
    throw new Error("Unsupported native transfer gas");
  const cost = nativeGasCost(limit, fees.depositFee);
  const required = input.kind === "native-transfer" ? amount + cost : cost;
  if (
    held < required ||
    (input.kind === "native-transfer" && required > budget)
  )
    throw new Error("Insufficient diagnostic budget");
  if (
    input.kind === "token-transfer" &&
    (await client.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
      blockNumber: block.number,
    })) < amount
  )
    throw new Error("Insufficient token budget");
  const [canonical, latestNonce] = await Promise.all([
    client.getBlock({ blockNumber: block.number }),
    client.getTransactionCount({ address: owner, blockTag: "pending" }),
  ]);
  if (
    canonical.hash !== block.hash ||
    latestNonce !== nonce ||
    Date.now() - Number(block.timestamp) * 1000 > 60000
  )
    throw new Error("Diagnostic reference changed");
  return [
    {
      name: "live.native-fee-preparation",
      ok: true,
      values: {
        chainId: input.chainId,
        gasLimit: limit.toString(),
        maximumFeeWei: cost.toString(),
        nativeFeeAsset: true,
      },
    },
  ];
}

export async function runGasDoctor(
  args: string[],
  input?: unknown,
  live: (input: GasDoctorInput) => Promise<Check[]> = prepareReadOnly,
): Promise<Report> {
  if (args.some((arg) => !["--offline", "--live", "--native"].includes(arg)))
    throw new Error("Unknown gas diagnostic argument");
  if (args.includes("--offline") && args.includes("--live"))
    throw new Error("Choose one gas diagnostic mode");
  const parsed = args.includes("--live") ? parseGasDoctorInput(input) : null;
  const { version, checks } = await offlineChecks();
  if (args.includes("--native")) {
    const result = spawnSync(
      process.env.CARGO ?? "cargo",
      ["test", "--locked", "--lib", "--quiet"],
      {
        cwd: fileURLToPath(
          new URL(
            "../../mobile/modules/gizu-stored-signer/core/",
            import.meta.url,
          ),
        ),
        encoding: "utf8",
        timeout: 180000,
        maxBuffer: 1024 * 1024,
      },
    );
    checks.push({
      name: "native.core-gas-and-authorization",
      ok: result.status === 0,
      ...(result.status !== 0 ? { code: "GAS_NATIVE_CHECK_FAILED" } : {}),
    });
  }
  if (parsed) {
    try {
      checks.push(...(await live(parsed)));
    } catch (error) {
      const code =
        error instanceof GasPolicyError
          ? error.code
          : "GAS_PREPARATION_UNAVAILABLE";
      checks.push({ name: "live.preparation", ok: false, code });
    }
  }
  return {
    policyVersion: version,
    mode: parsed ? "read-only" : "offline",
    ok: checks.every((check) => check.ok),
    signingAvailable: false,
    submitted: false,
    checks,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const args = process.argv.slice(2);
  if (args.includes("--help"))
    console.log(
      "gas-doctor [--offline] [--native] | --live < request.json\nOffline is the default. Live input: chainId, kind, owner, recipient, amountAtoms, budgetAtoms. No signing or submission.",
    );
  else {
    try {
      if (
        args.some(
          (arg) => !["--offline", "--live", "--native"].includes(arg),
        ) ||
        (args.includes("--offline") && args.includes("--live"))
      )
        throw new Error("Invalid diagnostic mode");
      let input: unknown;
      if (args.includes("--live")) {
        if (process.stdin.isTTY)
          throw new Error("Live diagnostics require JSON input on stdin");
        const parts: Buffer[] = [];
        let length = 0;
        for await (const part of process.stdin) {
          const bytes = Buffer.from(part);
          length += bytes.length;
          if (length > 16384) throw new Error("Diagnostic input is too large");
          parts.push(bytes);
        }
        input = JSON.parse(Buffer.concat(parts).toString("utf8"));
      }
      const report = await runGasDoctor(args, input);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    } catch {
      console.log(
        JSON.stringify({
          ok: false,
          code: "GAS_DIAGNOSTIC_INVALID_INPUT",
          signingAvailable: false,
          submitted: false,
        }),
      );
      process.exitCode = 1;
    }
  }
}
