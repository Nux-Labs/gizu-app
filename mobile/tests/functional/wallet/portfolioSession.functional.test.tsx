import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AppState, Button, Text, View } from "react-native";
import { MainnetWalletProvider, useMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import type { MainnetPortfolioSnapshot } from "@/domain/wallet/storedSigner";
import type { MainnetWalletSession } from "@/services/access";
import { deferred } from "../../support/renderApp";
import * as nativeBridge from "@/services/wallet/nativeBridge";
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

test("foreground refreshes balances while price expiry alone does not request another native balance", async () => {
  jest.useFakeTimers();
  try {
    const address = "0x" + "1".repeat(40);
    const session: MainnetWalletSession = {
      kind: "mainnet",
      walletId: "observed",
      address,
      accountId: address,
      accountIndex: 1,
      chainId: 143,
      method: "Passkey",
    };
    const raw = mainnetPortfolio("observed", address, "2670000");
    const service = { getMainnetPortfolio: jest.fn().mockResolvedValue(raw) };
    const valuation = {
      value: jest.fn().mockResolvedValue({ ...raw, valuationExpiresAt: Date.now() + 1000 }),
    };
    render(
      <MainnetWalletProvider session={session} service={service} valuation={valuation}>
        <Balance />
      </MainnetWalletProvider>,
    );
    await act(async () => {});
    expect(screen.getByText("2670000 atoms")).toBeVisible();
    const callbacks = jest
      .mocked(AppState.addEventListener)
      .mock.calls.filter(([event]) => event === "change")
      .map(([, callback]) => callback);
    act(() => callbacks.forEach((callback) => callback("background")));
    await act(async () => callbacks.forEach((callback) => callback("active")));
    expect(service.getMainnetPortfolio).toHaveBeenCalledTimes(2);
    await act(async () => {
      jest.advanceTimersByTime(1001);
    });
    expect(service.getMainnetPortfolio).toHaveBeenCalledTimes(2);
    expect(screen.getByText("2670000 atoms")).toBeVisible();
  } finally {
    jest.useRealTimers();
  }
});

test("an action supersedes an earlier balance read without letting its late result overwrite new funds", async () => {
  const address = "0x" + "1".repeat(40);
  const session: MainnetWalletSession = {
    kind: "mainnet",
    walletId: "observed",
    address,
    accountId: address,
    accountIndex: 1,
    chainId: 143,
    method: "Passkey",
  };
  const old = deferred<MainnetPortfolioSnapshot>();
  const service = {
    getMainnetPortfolio: jest
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(mainnetPortfolio("observed", address, "1000000")),
  };
  function Probe() {
    const wallet = useMainnetWallet();
    return (
      <View>
        <Text>{wallet.snapshot?.totalAtoms ?? "pending"}</Text>
        <Button title="Wallet action finished" onPress={() => void wallet.refreshAfterAction()} />
      </View>
    );
  }
  render(
    <MainnetWalletProvider session={session} service={service}>
      <Probe />
    </MainnetWalletProvider>,
  );
  await waitFor(() => expect(service.getMainnetPortfolio).toHaveBeenCalledTimes(1));
  fireEvent.press(screen.getByRole("button", { name: "Wallet action finished" }));
  await act(async () => {});
  expect(service.getMainnetPortfolio).toHaveBeenCalledTimes(1);
  await act(async () => old.resolve(mainnetPortfolio("observed", address, "9000000")));
  expect(await screen.findByText("1000000")).toBeVisible();
  expect(screen.getByText("1000000")).toBeVisible();
  expect(screen.queryByText("9000000")).toBeNull();
});

test("an action during private balance authentication queues its read and always clears the unlock indicator", async () => {
  const address = "0x" + "1".repeat(40);
  const session: MainnetWalletSession = {
    kind: "mainnet",
    walletId: "observed",
    address,
    accountId: address,
    accountIndex: 1,
    chainId: 143,
    method: "Passkey",
  };
  const open = deferred<import("@/domain/wallet/storedSigner").StoredWalletState>();
  const signer = jest.spyOn(nativeBridge, "getStoredSigner").mockReturnValue({
    openWallet: jest.fn().mockReturnValue(open.promise),
  } as unknown as NonNullable<ReturnType<typeof nativeBridge.getStoredSigner>>);
  const service = {
    getMainnetPortfolio: jest
      .fn()
      .mockResolvedValue(mainnetPortfolio("observed", address, "1000000")),
  };
  function Probe() {
    const wallet = useMainnetWallet();
    return (
      <View>
        <Text>{wallet.snapshot?.totalAtoms ?? "pending"}</Text>
        <Text>{wallet.unlockingPrivateBalance ? "Authenticating" : "Authentication finished"}</Text>
        <Button
          title="Refresh private balance"
          onPress={() => void wallet.unlockPrivateBalance()}
        />
        <Button title="Wallet action finished" onPress={() => void wallet.refreshAfterAction()} />
      </View>
    );
  }
  try {
    render(
      <MainnetWalletProvider session={session} service={service}>
        <Probe />
      </MainnetWalletProvider>,
    );
    await screen.findByText("1000000");
    fireEvent.press(screen.getByRole("button", { name: "Refresh private balance" }));
    expect(await screen.findByText("Authenticating")).toBeVisible();
    fireEvent.press(screen.getByRole("button", { name: "Wallet action finished" }));
    await act(async () => {});
    expect(service.getMainnetPortfolio).toHaveBeenCalledTimes(1);
    await act(async () => open.resolve({ status: "ready", walletId: "observed", accounts: [] }));
    expect(await screen.findByText("Authentication finished")).toBeVisible();
    await waitFor(() => expect(service.getMainnetPortfolio.mock.calls.length).toBeGreaterThan(1));
  } finally {
    signer.mockRestore();
  }
});

test("a wallet action settling in the background waits for foreground without losing its balance update", async () => {
  const address = "0x" + "1".repeat(40);
  const session: MainnetWalletSession = {
    kind: "mainnet",
    walletId: "observed",
    address,
    accountId: address,
    accountIndex: 1,
    chainId: 143,
    method: "Passkey",
  };
  const service = {
    getMainnetPortfolio: jest
      .fn()
      .mockResolvedValueOnce(mainnetPortfolio("observed", address, "3000000"))
      .mockResolvedValue(mainnetPortfolio("observed", address, "1000000")),
  };
  function Probe() {
    const wallet = useMainnetWallet();
    return (
      <View>
        <Text>{wallet.snapshot?.totalAtoms ?? "pending"}</Text>
        <Button title="Wallet action finished" onPress={() => void wallet.refreshAfterAction()} />
      </View>
    );
  }
  render(
    <MainnetWalletProvider session={session} service={service}>
      <Probe />
    </MainnetWalletProvider>,
  );
  await screen.findByText("3000000");
  const callbacks = jest
    .mocked(AppState.addEventListener)
    .mock.calls.filter(([event]) => event === "change")
    .map(([, callback]) => callback);
  act(() => callbacks.forEach((callback) => callback("background")));
  fireEvent.press(screen.getByRole("button", { name: "Wallet action finished" }));
  await act(async () => {});
  expect(service.getMainnetPortfolio).toHaveBeenCalledTimes(1);
  act(() => callbacks.forEach((callback) => callback("active")));
  expect(await screen.findByText("1000000")).toBeVisible();
  expect(service.getMainnetPortfolio).toHaveBeenCalledTimes(2);
});

test.each([false, true])(
  "an action refresh interrupted by backgrounding retries after foreground (resume before read finishes: %s)",
  async (resumeFirst) => {
    const address = "0x" + "1".repeat(40);
    const session: MainnetWalletSession = {
      kind: "mainnet",
      walletId: "observed",
      address,
      accountId: address,
      accountIndex: 1,
      chainId: 143,
      method: "Passkey",
    };
    const interrupted = deferred<MainnetPortfolioSnapshot>();
    const service = {
      getMainnetPortfolio: jest
        .fn()
        .mockResolvedValueOnce(mainnetPortfolio("observed", address, "3000000"))
        .mockReturnValueOnce(interrupted.promise)
        .mockResolvedValue(mainnetPortfolio("observed", address, "1000000")),
    };
    function Probe() {
      const wallet = useMainnetWallet();
      return (
        <View>
          <Text>{wallet.snapshot?.totalAtoms ?? "pending"}</Text>
          <Button title="Wallet action finished" onPress={() => void wallet.refreshAfterAction()} />
        </View>
      );
    }
    render(
      <MainnetWalletProvider session={session} service={service}>
        <Probe />
      </MainnetWalletProvider>,
    );
    await screen.findByText("3000000");
    fireEvent.press(screen.getByRole("button", { name: "Wallet action finished" }));
    await waitFor(() => expect(service.getMainnetPortfolio).toHaveBeenCalledTimes(2));
    const callbacks = jest
      .mocked(AppState.addEventListener)
      .mock.calls.filter(([event]) => event === "change")
      .map(([, callback]) => callback);
    act(() => callbacks.forEach((callback) => callback("background")));
    if (resumeFirst) act(() => callbacks.forEach((callback) => callback("active")));
    await act(async () => interrupted.reject(new Error("App backgrounded")));
    if (!resumeFirst) {
      expect(service.getMainnetPortfolio).toHaveBeenCalledTimes(2);
      act(() => callbacks.forEach((callback) => callback("active")));
    }
    expect(await screen.findByText("1000000")).toBeVisible();
    expect(service.getMainnetPortfolio).toHaveBeenCalledTimes(3);
  },
);
