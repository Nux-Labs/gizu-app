import {
  earnProfiles,
  type EarnIntent,
  type EarnOwner,
  type EarnProfileId,
  type EarnWalletService,
  type EarnWalletState,
} from "@/domain/earn/types";
import { getStoredEarnSigner } from "./nativeBridge";
import { parseEarnDistribution } from "@/domain/earn/distribution";
type Bridge = {
  getEarnIntent(walletId: string): Promise<unknown>;
  prepareEarnIntent(walletId: string, profile: string): Promise<unknown>;
  prepareNewEarnIntent?(walletId: string, profile: string): Promise<unknown>;
  prepareNewEarnDistributionIntent?(
    walletId: string,
    profile: string,
    budgetAtoms: string,
  ): Promise<unknown>;
  selectEarnInvestmentSlot?(walletId: string, intentId: string, slot: number): Promise<unknown>;
  listEarnIntents?(walletId: string): Promise<unknown>;
  selectEarnIntent?(walletId: string, intentId: string): Promise<unknown>;
  lock(): void;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid native earn result.");
  return value as Record<string, unknown>;
}
function validAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
}
function validateOwner(owner: EarnOwner) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner.walletId))
    throw new Error("Verified source wallet required.");
}
function decode(value: unknown, owner: EarnOwner, requested?: EarnProfileId): EarnWalletState {
  const row = object(value);
  if (
    !requested &&
    !("intentId" in row) &&
    Object.keys(row).length === 1 &&
    (row.status === "absent" || row.status === "recoveryRequired")
  )
    return { status: row.status };
  const profile = row.profileId;
  if (
    (profile !== "ethereum-usdc" && profile !== "robinhood-usdg") ||
    (requested && requested !== profile)
  )
    throw new Error("Native earn profile changed.");
  const cycleIndex = row.cycleIndex ?? 0;
  if (typeof cycleIndex !== "number" || !Number.isSafeInteger(cycleIndex) || cycleIndex < 0)
    throw new Error("Invalid native earn cycle.");
  const version = cycleIndex === 0 ? "gizu-earn-v1" : "gizu-earn-v2";
  const intentId =
    cycleIndex === 0
      ? `earn-v1:${owner.walletId.toLowerCase()}:${profile}`
      : `earn-v2:${owner.walletId.toLowerCase()}:${profile}:${cycleIndex}`;
  if (
    (row.status !== "prepared" && row.status !== "recoveryRequired") ||
    row.walletId !== owner.walletId ||
    row.version !== version ||
    row.intentId !== intentId ||
    row.sourceChainId !== 143 ||
    row.backupCovered !== true ||
    !validAddress(row.sourceAddress)
  )
    throw new Error("Native source or backup binding changed.");
  const destinations = row.destinations;
  const distribution =
    row.distribution === undefined ? undefined : parseEarnDistribution(row.distribution);
  if (
    !Array.isArray(destinations) ||
    destinations.length !== (distribution?.weightsBps.length ?? 2)
  )
    throw new Error("Native earn wallet count changed.");
  const investmentSlot = row.investmentSlot;
  if (
    distribution &&
    (typeof investmentSlot !== "number" ||
      !Number.isSafeInteger(investmentSlot) ||
      investmentSlot < 0 ||
      investmentSlot >= distribution.weightsBps.length)
  )
    throw new Error("Invalid selected investment wallet.");
  if (!distribution && investmentSlot !== undefined) throw new Error("Legacy wallet slot changed.");
  const distributionBudgetAtoms = row.distributionBudgetAtoms;
  if (
    distributionBudgetAtoms !== undefined &&
    (!distribution ||
      typeof distributionBudgetAtoms !== "string" ||
      !/^[1-9][0-9]{0,77}$/.test(distributionBudgetAtoms) ||
      BigInt(distributionBudgetAtoms) >= 1n << 256n)
  )
    throw new Error("Invalid distribution budget.");
  if (
    !validAddress(row.confidentialAddress) ||
    row.confidentialAddress.toLowerCase() === row.sourceAddress.toLowerCase()
  )
    throw new Error("Invalid native confidential identity.");
  const addresses = new Set([
    row.sourceAddress.toLowerCase(),
    row.confidentialAddress.toLowerCase(),
  ]);
  const checked = destinations.map((value, index) => {
    const d = object(value);
    if (
      d.role !== (distribution ? "invest" : index === 0 ? "hold" : "invest") ||
      (distribution && d.slot !== index) ||
      d.chainId !== earnProfiles[profile].chainId ||
      !validAddress(d.address) ||
      addresses.has(d.address.toLowerCase())
    )
      throw new Error("Invalid native earn destination.");
    addresses.add(d.address.toLowerCase());
    return {
      role: d.role,
      address: d.address,
      chainId: d.chainId,
      ...(distribution ? { slot: index } : {}),
    };
  });
  return {
    status: row.status,
    version,
    ...(cycleIndex > 0 ? { cycleIndex } : {}),
    intentId: row.intentId as string,
    walletId: owner.walletId,
    profileId: profile,
    sourceAddress: row.sourceAddress,
    sourceChainId: 143,
    confidentialAddress: row.confidentialAddress,
    backupCovered: true,
    destinations: checked as EarnIntent["destinations"],
    ...(distribution
      ? {
          distribution,
          investmentSlot: investmentSlot as number,
          ...(distributionBudgetAtoms !== undefined
            ? { distributionBudgetAtoms: distributionBudgetAtoms as string }
            : {}),
        }
      : {}),
  };
}
export function createEarnWalletService(
  getBridge: () => Bridge | null = getStoredEarnSigner,
): EarnWalletService {
  let generation = 0;
  let occupied = false;
  async function run(owner: EarnOwner, profile?: EarnProfileId) {
    validateOwner(owner);
    if (profile && profile !== "ethereum-usdc" && profile !== "robinhood-usdg")
      throw new Error("Unsupported earn profile.");
    if (occupied) throw new Error("A wallet operation is already in progress.");
    const native = getBridge();
    if (!native) throw new Error("Earn wallets require the updated native build.");
    const attempt = generation;
    occupied = true;
    try {
      const value = profile
        ? await native.prepareEarnIntent(owner.walletId, profile)
        : await native.getEarnIntent(owner.walletId);
      if (attempt !== generation)
        throw new Error("Earn wallet operation cancelled. Check saved intent before retrying.");
      return decode(value, owner, profile);
    } finally {
      occupied = false;
    }
  }
  return {
    load: (owner) => run(owner),
    prepare: (owner, profile) => run(owner, profile) as Promise<EarnIntent>,
    async list(owner) {
      validateOwner(owner);
      const native = getBridge();
      if (!native?.listEarnIntents) {
        const current = await run(owner);
        return "intentId" in current ? [current] : [];
      }
      const attempt = generation;
      const rows = await native.listEarnIntents(owner.walletId);
      if (attempt !== generation) throw new Error("Earn wallet operation cancelled.");
      if (!Array.isArray(rows) || rows.length > 256) throw new Error("Invalid native earn cycles.");
      const seen = new Set<string>();
      return rows.map((row) => {
        const intent = decode(row, owner);
        if (!("intentId" in intent) || seen.has(intent.intentId))
          throw new Error("Invalid native earn cycles.");
        seen.add(intent.intentId);
        return intent;
      });
    },
    async prepareNew(owner, profile) {
      validateOwner(owner);
      const native = getBridge();
      if (!native?.prepareNewEarnIntent)
        throw new Error("New earn cycles require the updated native build.");
      const attempt = generation;
      const value = await native.prepareNewEarnIntent(owner.walletId, profile);
      if (attempt !== generation) throw new Error("Earn wallet operation cancelled.");
      return decode(value, owner, profile) as EarnIntent;
    },
    async prepareDistribution(owner, profile, budgetAtoms) {
      validateOwner(owner);
      if (!/^[1-9][0-9]{0,77}$/.test(budgetAtoms) || BigInt(budgetAtoms) >= 1n << 256n)
        throw new Error("Invalid deposit budget.");
      const native = getBridge();
      if (!native?.prepareNewEarnDistributionIntent)
        throw new Error("Distributed deposits require the updated native build.");
      const attempt = generation;
      const value = await native.prepareNewEarnDistributionIntent(
        owner.walletId,
        profile,
        budgetAtoms,
      );
      if (attempt !== generation) throw new Error("Earn wallet operation cancelled.");
      const intent = decode(value, owner, profile) as EarnIntent;
      if (!intent.distribution) throw new Error("Native distribution plan is unavailable.");
      return intent;
    },
    async selectInvestmentSlot(owner, intentId, slot) {
      validateOwner(owner);
      if (!Number.isSafeInteger(slot) || slot < 0 || slot > 4)
        throw new Error("Invalid investment wallet.");
      const native = getBridge();
      if (!native?.selectEarnInvestmentSlot)
        throw new Error("Investment wallet selection requires the updated native build.");
      const attempt = generation;
      const intent = decode(
        await native.selectEarnInvestmentSlot(owner.walletId, intentId, slot),
        owner,
      );
      if (
        attempt !== generation ||
        !("intentId" in intent) ||
        intent.intentId !== intentId ||
        intent.investmentSlot !== slot
      )
        throw new Error("Selected investment wallet changed.");
      return intent;
    },
    async select(owner, intentId) {
      validateOwner(owner);
      const native = getBridge();
      if (!native?.selectEarnIntent)
        throw new Error("Earn cycle selection requires the updated native build.");
      const attempt = generation;
      const value = await native.selectEarnIntent(owner.walletId, intentId);
      if (attempt !== generation) throw new Error("Earn wallet operation cancelled.");
      const intent = decode(value, owner);
      if (!("intentId" in intent) || intent.intentId !== intentId)
        throw new Error("Selected earn cycle changed.");
      return intent;
    },
    cancel() {
      generation++;
      getBridge()?.lock();
    },
  };
}
