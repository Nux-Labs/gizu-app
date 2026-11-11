import { act, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { MainnetWalletProvider, useMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import type { MainnetPortfolioSnapshot } from "@/domain/wallet/storedSigner";
import type { MainnetWalletSession } from "@/services/access";
import { deferred } from "../../support/renderApp";
import { mainnetPortfolio } from "../../support/mainnetWallet";

function Balance() {
  const { snapshot, error } = useMainnetWallet();
  return <Text>{error || (snapshot ? `${snapshot.totalAtoms} atoms` : "Loading wallet")}</Text>;
}

test("saved native balances render before a pending network refresh", async () => {
  const address = "0x" + "1".repeat(40);
  const session: MainnetWalletSession = {
    kind: "mainnet",
    walletId: "cached",
    address,
    accountId: address,
    accountIndex: 1,
    chainId: 143,
    method: "Passkey",
  };
  const network = deferred<MainnetPortfolioSnapshot>();
  const service = {
    getCachedMainnetPortfolio: async () => mainnetPortfolio("cached", address, "2670000"),
    getMainnetPortfolio: () => network.promise,
  };
  render(
    <MainnetWalletProvider session={session} service={service}>
      <Balance />
    </MainnetWalletProvider>,
  );
  expect(await screen.findByText("2670000 atoms")).toBeVisible();
  await act(async () => network.resolve(mainnetPortfolio("cached", address, "2700000")));
  expect(await screen.findByText("2700000 atoms")).toBeVisible();
});

test("a failed cache read still loads fresh balances", async () => {
  const address = "0x" + "1".repeat(40);
  const session: MainnetWalletSession = {
    kind: "mainnet",
    walletId: "cached",
    address,
    accountId: address,
    accountIndex: 1,
    chainId: 143,
    method: "Passkey",
  };
  const service = {
    getCachedMainnetPortfolio: async () => {
      throw new Error("Cache unavailable");
    },
    getMainnetPortfolio: async () => mainnetPortfolio("cached", address, "2700000"),
  };
  render(
    <MainnetWalletProvider session={session} service={service}>
      <Balance />
    </MainnetWalletProvider>,
  );
  expect(await screen.findByText("2700000 atoms")).toBeVisible();
});

test.each(["cache", "network"])("replacing a wallet rejects its late %s result", async (source) => {
  const address = "0x" + "1".repeat(40);
  const session: MainnetWalletSession = {
    kind: "mainnet",
    walletId: "first",
    address,
    accountId: address,
    accountIndex: 1,
    chainId: 143,
    method: "Passkey",
  };
  const pending = deferred<MainnetPortfolioSnapshot>();
  const first = {
    getCachedMainnetPortfolio:
      source === "cache" ? jest.fn().mockReturnValue(pending.promise) : undefined,
    getMainnetPortfolio: jest.fn().mockReturnValue(pending.promise),
  };
  const second = {
    getMainnetPortfolio: jest.fn().mockResolvedValue(mainnetPortfolio("second", address, "42")),
  };
  const view = render(
    <MainnetWalletProvider session={session} service={first}>
      <Balance />
    </MainnetWalletProvider>,
  );
  await act(async () => {});
  view.rerender(
    <MainnetWalletProvider session={{ ...session, walletId: "second" }} service={second}>
      <Balance />
    </MainnetWalletProvider>,
  );
  expect(await screen.findByText("42 atoms")).toBeVisible();
  await act(async () => pending.resolve(mainnetPortfolio("first", address, "1000000")));
  expect(screen.getByText("42 atoms")).toBeVisible();
  expect(screen.queryByText("1000000 atoms")).toBeNull();
});

test("native balances render while pricing is pending and late prices cannot replace a new wallet", async () => {
  const address = "0x" + "1".repeat(40);
  const session: MainnetWalletSession = {
    kind: "mainnet",
    walletId: "first",
    address,
    accountId: address,
    accountIndex: 1,
    chainId: 143,
    method: "Passkey",
  };
  const pending = deferred<MainnetPortfolioSnapshot>();
  const valuation = { value: jest.fn().mockReturnValue(pending.promise) };
  const first = {
    getMainnetPortfolio: jest.fn().mockResolvedValue(mainnetPortfolio("first", address, "100")),
  };
  const view = render(
    <MainnetWalletProvider session={session} service={first} valuation={valuation}>
      <Balance />
    </MainnetWalletProvider>,
  );
  expect(await screen.findByText("100 atoms")).toBeVisible();
  expect(valuation.value).toHaveBeenCalledTimes(1);
  const signal = valuation.value.mock.calls[0][1] as AbortSignal;
  const second = {
    getMainnetPortfolio: jest.fn().mockResolvedValue(mainnetPortfolio("second", address, "42")),
  };
  view.rerender(
    <MainnetWalletProvider session={{ ...session, walletId: "second" }} service={second}>
      <Balance />
    </MainnetWalletProvider>,
  );
  expect(await screen.findByText("42 atoms")).toBeVisible();
  expect(signal.aborted).toBe(true);
  await act(async () => pending.resolve(mainnetPortfolio("first", address, "1000000")));
  expect(screen.getByText("42 atoms")).toBeVisible();
});

test("an active display removes expired external prices while preserving native balances", async () => {
  jest.useFakeTimers();
  try {
    const now = Date.now();
    const address = "0x" + "1".repeat(40);
    const session: MainnetWalletSession = {
      kind: "mainnet",
      walletId: "priced",
      address,
      accountId: address,
      accountIndex: 1,
      chainId: 143,
      method: "Passkey",
    };
    const raw = mainnetPortfolio("priced", address, "42");
    const read = {
      getMainnetPortfolio: jest
        .fn()
        .mockResolvedValueOnce(raw)
        .mockReturnValue(new Promise(() => {})),
    };
    const valuation = {
      value: jest
        .fn()
        .mockResolvedValue({ ...raw, valuationExpiresAt: now + 1000, valuationComplete: true }),
    };
    function Probe() {
      const { snapshot } = useMainnetWallet();
      return (
        <Text>
          {snapshot
            ? `${snapshot.totalAtoms} atoms ${snapshot.valuationExpiresAt ? "priced" : "unpriced"}`
            : "Loading"}
        </Text>
      );
    }
    render(
      <MainnetWalletProvider session={session} service={read} valuation={valuation}>
        <Probe />
      </MainnetWalletProvider>,
    );
    await act(async () => {});
    expect(screen.getByText("42 atoms priced")).toBeVisible();
    await act(async () => {
      jest.advanceTimersByTime(1001);
    });
    expect(screen.getByText("42 atoms unpriced")).toBeVisible();
  } finally {
    jest.useRealTimers();
  }
});
