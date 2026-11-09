import { act, fireEvent, screen, userEvent, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { createMockTransactionService, type TransactionService } from "@/services/transactions";
import { TransactionError, type Quote, type OperationKind } from "@/domain/transactions";
import { investmentFixture } from "@/services/fixtures/investments";
import { renderApp, deferred } from "../../support/renderApp";

beforeEach(() => jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null));
afterEach(() => jest.restoreAllMocks());
async function enter(service = createMockTransactionService()) {
  renderApp(undefined, undefined, undefined, service);
  await screen.findByRole("button", { name: "Continue with passkey" });
  await userEvent.press(screen.getByRole("button", { name: "Continue with passkey" }));
  await screen.findByText("Available USDC: 184204");
}
async function open(kind: OperationKind) {
  if (kind === "deposit" || kind === "withdraw")
    await userEvent.press(
      screen.getByRole("button", { name: kind === "deposit" ? "Receive" : "Send" }),
    );
  else {
    await userEvent.press(screen.getByRole("button", { name: "Open VTX holding" }));
    await userEvent.press(screen.getByRole("button", { name: kind === "buy" ? "Buy" : "Sell" }));
  }
}
async function review(kind: OperationKind, amount = kind === "buy" ? "10000" : "100") {
  await userEvent.type(
    screen.getByLabelText(`Amount in ${kind === "sell" ? "VTX" : "USDC"}`),
    amount,
  );
  await userEvent.press(
    screen.getByRole("button", { name: `Review ${kind === "withdraw" ? "withdrawal" : kind}` }),
  );
  await screen.findByRole("button", {
    name: `Confirm ${kind === "withdraw" ? "withdrawal" : kind}`,
  });
}
async function confirm(kind: OperationKind) {
  await userEvent.press(
    screen.getByRole("button", { name: `Confirm ${kind === "withdraw" ? "withdrawal" : kind}` }),
  );
}
test.each(["buy", "sell", "deposit", "withdraw"] as OperationKind[])(
  "%s reviews, submits, confirms and keeps a receipt after closing",
  async (kind) => {
    await enter();
    await open(kind);
    await review(kind);
    expect(screen.getByText("Fees included")).toBeVisible();
    await confirm(kind);
    expect(await screen.findByRole("header", { name: "Confirmation pending" })).toBeVisible();
    await userEvent.press(screen.getByRole("button", { name: "Check status" }));
    expect(await screen.findByRole("header", { name: "Operation confirmed" })).toBeVisible();
    await userEvent.press(screen.getByRole("button", { name: "Back" }));
    if (kind === "buy" || kind === "sell")
      await userEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: "View operation · confirmed" })).toBeVisible();
    if (kind === "deposit") expect(screen.getByText("Available USDC: 184304")).toBeVisible();
    if (kind === "withdraw") expect(screen.getByText("Available USDC: 184103.58")).toBeVisible();
    await userEvent.press(screen.getByRole("button", { name: "View activity" }));
    expect(await screen.findByText(/operation-1/)).toBeVisible();
  },
);
test("malformed, zero and oversized amounts cannot advance; fee-aware Max can", async () => {
  await enter();
  await open("deposit");
  for (const value of ["0", "1..2", "999999", "1.1234567"]) {
    const input = screen.getByLabelText("Amount in USDC");
    await userEvent.clear(input);
    await userEvent.type(input, value);
    await userEvent.press(screen.getByRole("button", { name: "Review deposit" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm deposit" })).toBeNull();
  }
  await userEvent.press(screen.getByRole("button", { name: "Max" }));
  expect(screen.getByLabelText("Amount in USDC")).toHaveDisplayValue("42179.58");
  await userEvent.press(screen.getByRole("button", { name: "Review deposit" }));
  expect(await screen.findByRole("button", { name: "Confirm deposit" })).toBeEnabled();
  await userEvent.press(screen.getByRole("button", { name: "Edit amount" }));
  expect(screen.getByLabelText("Amount in USDC")).toHaveDisplayValue("42179.58");
});
test("vault minimum and locked holdings have actionable validation", async () => {
  await enter();
  await open("buy");
  await userEvent.type(screen.getByLabelText("Amount in USDC"), "1");
  await userEvent.press(screen.getByRole("button", { name: "Review buy" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/Minimum purchase is 10000 USDC/);
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  await userEvent.press(screen.getByRole("button", { name: "Open OBS holding" }));
  await userEvent.press(screen.getByRole("button", { name: "Sell" }));
  await userEvent.type(screen.getByLabelText("Amount in OBS"), "1");
  await userEvent.press(screen.getByRole("button", { name: "Review sell" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/No unlocked units/);
});
test.each(["rejection", "failure", "settlement-failure"] as const)(
  "recovers from %s through a fresh review",
  async (scenario) => {
    await enter(createMockTransactionService(undefined, { scenario }));
    await open("withdraw");
    await review("withdraw");
    await confirm("withdraw");
    if (scenario === "settlement-failure")
      await userEvent.press(await screen.findByRole("button", { name: "Check status" }));
    await userEvent.press(await screen.findByRole("button", { name: "Review again" }));
    expect(screen.getByLabelText("Amount in USDC")).toHaveDisplayValue("100");
    await userEvent.press(screen.getByRole("button", { name: "Review withdrawal" }));
    await confirm("withdraw");
    expect(await screen.findByRole("header", { name: "Confirmation pending" })).toBeVisible();
  },
);
test("expired review never submits and can be refreshed", async () => {
  let now = 0;
  const service = createMockTransactionService(undefined, { now: () => now });
  const submit = jest.spyOn(service, "submit");
  await enter(service);
  await open("deposit");
  await review("deposit");
  now = 60001;
  await confirm("deposit");
  expect(await screen.findByRole("alert")).toHaveTextContent(/Quote expired/);
  expect(submit).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Review again" }));
  await userEvent.press(screen.getByRole("button", { name: "Review deposit" }));
  await confirm("deposit");
  expect(await screen.findByRole("header", { name: "Confirmation pending" })).toBeVisible();
});
test("unknown submission survives dismissal and reconciles without submitting twice", async () => {
  const service = createMockTransactionService(undefined, { scenario: "unknown" });
  const submit = jest.spyOn(service, "submit");
  await enter(service);
  await open("deposit");
  await review("deposit");
  await confirm("deposit");
  expect(await screen.findByRole("header", { name: "Submission status unknown" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Review again" })).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  await userEvent.press(await screen.findByRole("button", { name: "View operation · unknown" }));
  await userEvent.press(screen.getByRole("button", { name: "Check status" }));
  expect(await screen.findByRole("header", { name: "Operation confirmed" })).toBeVisible();
  expect(submit).toHaveBeenCalledTimes(1);
});
test("delayed confirmation and status errors retain the operation for recovery", async () => {
  const service = createMockTransactionService(undefined, { scenario: "delayed" });
  const status = jest.spyOn(service, "status").mockRejectedValueOnce(new Error("offline"));
  await enter(service);
  await open("sell");
  await review("sell");
  await confirm("sell");
  await userEvent.press(await screen.findByRole("button", { name: "Check status" }));
  expect(await screen.findByText(/Unable to check status/)).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Check status" }));
  expect(await screen.findByRole("header", { name: "Confirmation pending" })).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Check status" }));
  expect(await screen.findByRole("header", { name: "Operation confirmed" })).toBeVisible();
  expect(status).toHaveBeenCalledTimes(3);
});
test("cancelling an outstanding signature prevents late submission", async () => {
  const service = createMockTransactionService();
  const signing = deferred<string>();
  jest.spyOn(service, "sign").mockReturnValue(signing.promise);
  const submit = jest.spyOn(service, "submit");
  await enter(service);
  await open("deposit");
  await review("deposit");
  await confirm("deposit");
  await userEvent.press(await screen.findByRole("button", { name: "Cancel signing" }));
  await act(async () => signing.resolve("late"));
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(/Nothing was submitted/);
});
test("late quote result after dismissal cannot open a review; quote failure can retry", async () => {
  const service = createMockTransactionService();
  const pending = deferred<Quote>();
  const q = await service.quote({ kind: "deposit", amount: "100" });
  const quote = jest
    .spyOn(service, "quote")
    .mockRejectedValueOnce(new Error("offline"))
    .mockReturnValueOnce(pending.promise);
  await enter(service);
  await open("deposit");
  await userEvent.type(screen.getByLabelText("Amount in USDC"), "100");
  await userEvent.press(screen.getByRole("button", { name: "Review deposit" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/Unable to get a quote/);
  await userEvent.press(screen.getByRole("button", { name: "Review deposit" }));
  expect(screen.getByRole("button", { name: "Getting quote" })).toBeDisabled();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  await act(async () => pending.resolve(q));
  expect(screen.queryByRole("button", { name: "Confirm deposit" })).toBeNull();
  expect(quote).toHaveBeenCalledTimes(2);
});
test("balance loading failure recovers from an available transaction entry point", async () => {
  const service = createMockTransactionService({ ...investmentFixture, vaults: [], holdings: [] });
  jest.spyOn(service, "load").mockRejectedValueOnce(new Error("offline"));
  renderApp(undefined, undefined, undefined, service);
  await screen.findByRole("button", { name: "Continue with passkey" });
  await userEvent.press(screen.getByRole("button", { name: "Continue with passkey" }));
  await userEvent.press(await screen.findByRole("button", { name: "Receive" }));
  await userEvent.press(await screen.findByRole("button", { name: "Reload balances" }));
  expect(await screen.findByLabelText("Amount in USDC")).toBeVisible();
});
test("double confirm while submission is outstanding creates only one operation", async () => {
  const service = createMockTransactionService();
  const deferredSubmission = deferred<Awaited<ReturnType<TransactionService["submit"]>>>();
  const submit = jest.spyOn(service, "submit").mockReturnValue(deferredSubmission.promise);
  await enter(service);
  await open("deposit");
  await review("deposit");
  const button = screen.getByRole("button", { name: "Confirm deposit" });
  act(() => {
    fireEvent.press(button);
    fireEvent.press(button);
  });
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("header", { name: "Submitting operation" })).toBeVisible();
  await act(async () => deferredSubmission.reject(new Error("connection lost")));
  expect(await screen.findByRole("header", { name: "Submission status unknown" })).toBeVisible();
});
test("signing service errors are recoverable without implying a submission", async () => {
  const service = createMockTransactionService();
  jest.spyOn(service, "sign").mockRejectedValueOnce(new Error("unavailable"));
  await enter(service);
  await open("deposit");
  await review("deposit");
  await confirm("deposit");
  expect(await screen.findByRole("alert")).toHaveTextContent(/Signing failed/);
});

test("confirmed operation remains confirmed when balance reload fails, then recovers", async () => {
  const service = createMockTransactionService();
  await enter(service);
  await open("deposit");
  await review("deposit");
  await confirm("deposit");
  jest.spyOn(service, "load").mockRejectedValueOnce(new Error("offline"));
  await userEvent.press(await screen.findByRole("button", { name: "Check status" }));
  expect(await screen.findByRole("header", { name: "Operation confirmed" })).toBeVisible();
  expect(await screen.findByRole("alert")).toHaveTextContent(/Unable to load available balances/);
  expect(screen.queryByText("Balances have been updated after confirmation.")).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Reload balances" }));
  expect(await screen.findByText("Balances have been updated after confirmation.")).toBeVisible();
});

test("closing a pending operation retains it and blocks another order", async () => {
  await enter(createMockTransactionService(undefined, { scenario: "delayed" }));
  await open("deposit");
  await review("deposit");
  await confirm("deposit");
  await screen.findByRole("header", { name: "Confirmation pending" });
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  await userEvent.press(await screen.findByRole("button", { name: "Send" }));
  expect(await screen.findByRole("header", { name: "Confirmation pending" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Review withdrawal" })).toBeNull();
});
test("sign overlay follows signing and submission, then leaves an unknown outcome visible", async () => {
  const service = createMockTransactionService();
  const signing = deferred<string>();
  const submission = deferred<Awaited<ReturnType<TransactionService["submit"]>>>();
  jest.spyOn(service, "sign").mockReturnValue(signing.promise);
  jest.spyOn(service, "submit").mockReturnValue(submission.promise);
  await enter(service);
  await open("deposit");
  await review("deposit");
  await confirm("deposit");
  expect(await screen.findByText("Signing with passkey")).toBeVisible();
  expect(screen.getByRole("button", { name: "Cancel signing" })).toBeEnabled();
  await act(async () => signing.resolve("signature"));
  expect(screen.getByText("Sending")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Cancel signing" })).toBeNull();
  await act(async () => submission.reject(new Error("connection lost")));
  expect(await screen.findByRole("header", { name: "Submission status unknown" })).toBeVisible();
  expect(screen.queryByText("Sending")).toBeNull();
  expect(screen.queryByText("Confirmed")).toBeNull();
});
test("a rejected signature shows the rejection result over the recovery view", async () => {
  const service = createMockTransactionService();
  const signing = deferred<string>();
  jest.spyOn(service, "sign").mockReturnValue(signing.promise);
  await enter(service);
  await open("withdraw");
  await review("withdraw");
  await confirm("withdraw");
  expect(await screen.findByText("Signing with passkey")).toBeVisible();
  await act(async () => signing.reject(new TransactionError("Signing was rejected.", "rejected")));
  expect(screen.getByText("Signature rejected")).toBeVisible();
  expect(screen.getByRole("header", { name: "Signing rejected" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Review again" })).toBeEnabled();
});
