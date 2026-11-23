import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  STRATEGY_REGISTRY_CHAIN,
  STRATEGY_SIGNATURE_SECONDS,
  strategyMetadataHash,
  type StrategyCard,
  type StrategyMetadata,
  type StrategyService,
} from "@/domain/strategies";
import type { StrategyAssetInput } from "@/domain/wallet/storedSigner";
import { useMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import { strategyErrorMessage, strategyService } from "@/services/strategies";
import { getStoredStrategySigner } from "@/services/wallet/nativeBridge";

/** How many strategy keys are checked when rediscovering this wallet's strategies. */
const DISCOVERY_COUNT = 32;

export type OwnedStrategy = { index: number; card: StrategyCard };
/** approving: a native review and passkey are open; sending: waiting for the registry. */
export type StrategyStage = "idle" | "approving" | "publishing" | "sealing";

type Signer = NonNullable<ReturnType<typeof getStoredStrategySigner>>;
export type StrategyOwnerDeps = {
  service: StrategyService;
  signer: () => Signer | null;
  now: () => number;
};
const defaultDeps: StrategyOwnerDeps = {
  service: strategyService,
  signer: getStoredStrategySigner,
  now: Date.now,
};

/** Tests and previews provide their own API and signer. */
export const StrategyOwnerContext = createContext<StrategyOwnerDeps>(defaultDeps);

/**
 * Finds this wallet's strategies from its derived strategy keys and drives publishing and updates.
 * Keys and approvals stay native; this hook passes public basket data and the API's results.
 */
export function useStrategyOwner(deps?: StrategyOwnerDeps) {
  const { session } = useMainnetWallet();
  const walletId = session.walletId ?? null;
  const [owned, setOwned] = useState<OwnedStrategy[]>([]);
  const [nextIndex, setNextIndex] = useState<number | null>(null);
  /** Set by a successful read; without it a missing `nextIndex` means "unknown", not "used up". */
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  // A failed read and a failed operation are separate: the reload after an operation must not
  // clear the operation's error.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [stage, setStage] = useState<StrategyStage>("idle");
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const fromContext = useContext(StrategyOwnerContext);
  const { service, signer: signerFor, now } = deps ?? fromContext;

  const unavailable = !signerFor() || !walletId;
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Reads this wallet's strategies; a reload bumps `revision`, and a stale read is dropped.
  useEffect(() => {
    const signer = signerFor();
    if (!signer || !walletId) return;
    let active = true;
    Promise.resolve()
      .then(() => signer.strategyAddresses(walletId, STRATEGY_REGISTRY_CHAIN, 0, DISCOVERY_COUNT))
      .then(async (addresses) => ({ addresses, cards: await service.list(addresses) }))
      .then(({ addresses, cards }) => {
        if (!active) return;
        // Keys and signatures are bound to one registry chain; a mismatched API would reject them.
        if (cards.some((card) => card.registry.chainId !== STRATEGY_REGISTRY_CHAIN))
          throw new Error("This app version doesn't match the strategy registry. Update the app.");
        const bySigner = new Map(cards.map((card) => [card.signer.toLowerCase(), card]));
        setOwned(
          addresses.flatMap((address, index) => {
            const card = bySigner.get(address.toLowerCase());
            return card ? [{ index, card }] : [];
          }),
        );
        const free = addresses.findIndex((address) => !bySigner.has(address.toLowerCase()));
        setNextIndex(free === -1 ? null : free);
        setLoaded(true);
        setLoadError(null);
      })
      .catch((cause: unknown) => {
        if (active) setLoadError(strategyErrorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision, service, signerFor, walletId]);

  const load = useCallback(() => {
    if (unavailable) return;
    setLoading(true);
    setRevision((value) => value + 1);
  }, [unavailable]);

  const deadline = useCallback(() => Math.floor(now() / 1000) + STRATEGY_SIGNATURE_SECONDS, [now]);

  const seal = useCallback(
    async (signer: Signer, strategy: OwnedStrategy, assets: StrategyAssetInput[]) => {
      const until = deadline();
      const seq = strategy.card.commits;
      setStage("approving");
      const sealed = await signer.sealStrategyCommit(
        walletId!,
        STRATEGY_REGISTRY_CHAIN,
        strategy.index,
        strategy.card.id,
        seq,
        assets,
        until,
      );
      if (mounted.current) setStage("sealing");
      return service.commit(strategy.card.id, {
        seq,
        assets,
        assetIds: sealed.assetIds,
        weightsBps: sealed.weightsBps,
        salt: sealed.salt,
        commitment: sealed.commitment,
        signature: sealed.signature,
        deadline: until,
      });
    },
    [deadline, service, walletId],
  );

  /** Runs one operation at a time and reports its error; true when it completed. */
  const run = useCallback(
    async (work: (signer: Signer) => Promise<void>): Promise<boolean> => {
      const signer = signerFor();
      if (inFlight.current || !signer || !walletId) return false;
      inFlight.current = true;
      setOperationError(null);
      try {
        await work(signer);
        return true;
      } catch (cause) {
        if (mounted.current) setOperationError(strategyErrorMessage(cause));
        return false;
      } finally {
        inFlight.current = false;
        if (mounted.current) setStage("idle");
        load();
      }
    },
    [load, signerFor, walletId],
  );

  /**
   * Publishes and seals the first basket. `strategyId` is set once the strategy exists, even when
   * sealing then failed, so the caller switches to updating it instead of publishing again.
   */
  const publish = useCallback(
    async (
      metadata: StrategyMetadata,
      embargo: number,
      assets: StrategyAssetInput[],
    ): Promise<{ ok: boolean; strategyId: number | null }> => {
      let strategyId: number | null = null;
      const ok = await run(async (signer) => {
        if (nextIndex === null) throw new Error("This wallet has no free strategy key.");
        const index = nextIndex;
        const until = deadline();
        setStage("approving");
        const created = await signer.createStrategy(
          walletId!,
          STRATEGY_REGISTRY_CHAIN,
          index,
          embargo,
          metadata,
          until,
        );
        if (created.metadataHash.toLowerCase() !== strategyMetadataHash(metadata).toLowerCase())
          throw new Error("The app and the wallet disagree on these terms. Update the app.");
        if (mounted.current) setStage("publishing");
        let card: StrategyCard;
        try {
          card = await service.create({
            signer: created.signer,
            embargo,
            metadata,
            deadline: until,
            signature: created.signature,
          });
        } catch (cause) {
          // The API may have finished after the request timed out; look before signing again.
          const [existing] = await service.list([created.signer]).catch(() => []);
          if (!existing) throw cause;
          card = existing;
        }
        strategyId = card.id;
        try {
          await seal(signer, { index, card }, assets);
        } catch (cause) {
          throw new Error(
            `Your strategy is published, but its first basket wasn't sealed: ${strategyErrorMessage(cause)} Seal it below.`,
          );
        }
      });
      return { ok, strategyId };
    },
    [deadline, nextIndex, run, seal, service, walletId],
  );

  const sendUpdate = useCallback(
    (strategy: OwnedStrategy, assets: StrategyAssetInput[]) =>
      run(async (signer) => {
        await seal(signer, strategy, assets);
      }),
    [run, seal],
  );

  return {
    owned,
    nextIndex,
    /** Every discovered strategy key already has a strategy. */
    keysExhausted: !unavailable && loaded && nextIndex === null,
    loading: !unavailable && loading,
    error: unavailable
      ? "Strategies need the Gizu Android app with a ready wallet."
      : (operationError ?? loadError),
    stage,
    busy: stage !== "idle",
    reload: load,
    publish,
    sendUpdate,
  };
}
