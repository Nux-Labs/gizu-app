import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Chain,
  type Hex,
  type HttpTransport,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { DomainError } from "../../domain/errors/domain-error.ts";
import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";
import type { SealedStrategyAsset, StrategyRegistryChainId } from "../../domain/strategy.ts";
import type { OnchainStrategy, StrategyRegistryGateway } from "../../ports/strategies.port.ts";

export const strategyRegistryAbi = parseAbi([
  "function strategyOf(address signer) view returns (uint256)",
  "function strategy(uint256 id) view returns ((address signer, uint32 embargo, uint64 nextSeq, uint64 nextRevealSeq, bytes32 metadataHash))",
  "function commitAt(uint256 id, uint64 seq) view returns ((bytes32 commitment, uint64 committedAt))",
  "function create(address signer, uint32 embargo, bytes32 metadataHash, uint64 deadline, bytes signature) returns (uint256)",
  "function commit(uint256 id, bytes32 commitment, uint64 deadline, bytes signature) returns (uint64)",
  "function reveal(uint256 id, bytes32[] assetIds, uint16[] weightsBps, bytes32 salt) returns (uint64)",
  "event StrategyCreated(uint256 indexed id, address indexed signer, uint32 embargo, bytes32 metadataHash)",
  "event Committed(uint256 indexed id, uint64 indexed seq, bytes32 commitment)",
  "event Revealed(uint256 indexed id, uint64 indexed seq, bytes32[] assetIds, uint16[] weightsBps, bytes32 salt)",
  "error InvalidEmbargo()",
  "error Expired()",
  "error InvalidSignature()",
  "error SignerAlreadyUsed()",
  "error UnknownStrategy()",
  "error NothingToReveal()",
  "error EmbargoActive()",
  "error InvalidBasket()",
  "error CommitmentMismatch()",
]);

/** The registry refused the request itself; retrying the same signed payload cannot succeed. */
export class StrategyRegistryRejection extends DomainError {
  constructor(readonly reason: string) {
    super("STRATEGY_REGISTRY_REJECTED", `The strategy registry rejected the request (${reason}).`);
  }
}

const RECEIPT_TIMEOUT_MS = 60_000;

export class ViemStrategyRegistry implements StrategyRegistryGateway {
  readonly address: Address;
  private readonly reader: PublicClient<HttpTransport, Chain>;
  private readonly writer: WalletClient<HttpTransport, Chain, PrivateKeyAccount>;
  private readonly account: PrivateKeyAccount;
  /** One relayer key sends one transaction at a time so nonces never collide in this process. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly chainId: StrategyRegistryChainId,
    address: Address,
    relayerKey: Hex,
    rpcUrl?: string,
  ) {
    const chain: Chain = chainId === 8453 ? base : baseSepolia;
    const transport = http(rpcUrl ?? chain.rpcUrls.default.http[0], { timeout: 15_000, retryCount: 2 });
    // Env values may carry any letter case; a bad checksum must not stop the server.
    this.address = getAddress(address.toLowerCase());
    this.account = privateKeyToAccount(relayerKey);
    this.reader = createPublicClient({ chain, transport });
    this.writer = createWalletClient({ chain, transport, account: this.account });
  }

  async strategyOf(signer: Address): Promise<number> {
    const id = await this.reader.readContract({
      address: this.address,
      abi: strategyRegistryAbi,
      functionName: "strategyOf",
      args: [signer],
    });
    return Number(id);
  }

  async strategy(id: number): Promise<OnchainStrategy> {
    const s = await this.reader.readContract({
      address: this.address,
      abi: strategyRegistryAbi,
      functionName: "strategy",
      args: [BigInt(id)],
    });
    return {
      signer: s.signer,
      embargoSeconds: s.embargo,
      nextSeq: Number(s.nextSeq),
      nextRevealSeq: Number(s.nextRevealSeq),
      metadataHash: s.metadataHash,
    };
  }

  async commitAt(id: number, seq: number): Promise<{ commitment: Hex; committedAt: Date }> {
    const c = await this.reader.readContract({
      address: this.address,
      abi: strategyRegistryAbi,
      functionName: "commitAt",
      args: [BigInt(id), BigInt(seq)],
    });
    return { commitment: c.commitment, committedAt: new Date(Number(c.committedAt) * 1000) };
  }

  async create(input: {
    signer: Address;
    embargo: number;
    metadataHash: Hex;
    deadline: number;
    signature: Hex;
  }): Promise<{ id: number; tx: Hex }> {
    const { tx, logs } = await this.send("create", [
      input.signer,
      input.embargo,
      input.metadataHash,
      BigInt(input.deadline),
      input.signature,
    ]);
    // Only this registry's event for this signer counts; a replaced transaction carries others.
    const event = this.ours(
      parseEventLogs({ abi: strategyRegistryAbi, eventName: "StrategyCreated", logs }),
    ).find((log) => log.args.signer.toLowerCase() === input.signer.toLowerCase());
    if (!event) throw relayFailure("STRATEGY_CREATE_UNCONFIRMED");
    return { id: Number(event.args.id), tx };
  }

  async commit(input: {
    strategyId: number;
    commitment: Hex;
    deadline: number;
    signature: Hex;
  }): Promise<{ seq: number; tx: Hex; committedAt: Date }> {
    const { tx, logs, timestamp } = await this.send("commit", [
      BigInt(input.strategyId),
      input.commitment,
      BigInt(input.deadline),
      input.signature,
    ]);
    const event = this.ours(
      parseEventLogs({ abi: strategyRegistryAbi, eventName: "Committed", logs }),
    ).find(
      (log) =>
        log.args.id === BigInt(input.strategyId) &&
        log.args.commitment.toLowerCase() === input.commitment.toLowerCase(),
    );
    if (!event) throw relayFailure("STRATEGY_COMMIT_UNCONFIRMED");
    return { seq: Number(event.args.seq), tx, committedAt: timestamp };
  }

  async reveal(input: {
    strategyId: number;
    basket: readonly SealedStrategyAsset[];
    salt: Hex;
  }): Promise<{ seq: number; tx: Hex; revealedAt: Date }> {
    const { tx, logs, timestamp } = await this.send("reveal", [
      BigInt(input.strategyId),
      input.basket.map((asset) => asset.assetId),
      input.basket.map((asset) => asset.weightBps),
      input.salt,
    ]);
    const event = this.ours(
      parseEventLogs({ abi: strategyRegistryAbi, eventName: "Revealed", logs }),
    ).find((log) => log.args.id === BigInt(input.strategyId));
    if (!event) throw relayFailure("STRATEGY_REVEAL_UNCONFIRMED");
    return { seq: Number(event.args.seq), tx, revealedAt: timestamp };
  }

  private ours<T extends { address: Address }>(logs: T[]): T[] {
    return logs.filter((log) => log.address.toLowerCase() === this.address.toLowerCase());
  }

  /** Simulates first so a registry rejection costs no gas, then waits for one confirmation. */
  private send(
    functionName: "create" | "commit" | "reveal",
    args: readonly unknown[],
  ): Promise<{ tx: Hex; logs: Parameters<typeof parseEventLogs>[0]["logs"]; timestamp: Date }> {
    const work = async () => {
      let request;
      try {
        ({ request } = await this.reader.simulateContract({
          address: this.address,
          abi: strategyRegistryAbi,
          functionName,
          // The ABI narrows each function's arguments; the callers above build them in order.
          args: args as never,
          account: this.account,
        }));
      } catch (error) {
        throw rejectionOrFailure(error);
      }
      const tx = await this.writer.writeContract(request).catch((error: unknown) => {
        throw rejectionOrFailure(error);
      });
      const receipt = await this.reader
        .waitForTransactionReceipt({ hash: tx, timeout: RECEIPT_TIMEOUT_MS })
        .catch((error: unknown) => {
          throw relayFailure("STRATEGY_RECEIPT_UNAVAILABLE", error);
        });
      if (receipt.status !== "success") throw relayFailure("STRATEGY_TRANSACTION_REVERTED");
      const block = await this.reader.getBlock({ blockNumber: receipt.blockNumber });
      return { tx, logs: receipt.logs, timestamp: new Date(Number(block.timestamp) * 1000) };
    };
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }
}

function rejectionOrFailure(error: unknown): Error {
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName)
      return new StrategyRegistryRejection(reverted.data.errorName);
  }
  return relayFailure("STRATEGY_RELAY_UNAVAILABLE", error);
}

function relayFailure(code: string, cause?: unknown): InfrastructureError {
  return new InfrastructureError(502, code, "The strategy registry could not be reached.", { cause });
}
