import { displayAmount, groupDigits, holdingAmount } from "@/domain/wallet/amounts";

test("groups whole digits without touching the fraction", () => {
  expect(groupDigits("12485.25")).toBe("12,485.25");
  expect(groupDigits("1234567")).toBe("1,234,567");
  expect(groupDigits("999.123456")).toBe("999.123456");
  expect(groupDigits("0.5")).toBe("0.5");
  expect(holdingAmount("12485250000", 6)).toBe("12,485.25");
  expect(holdingAmount("1000000000", 0)).toBe("1,000,000,000");
  expect(holdingAmount("19990574", 6)).toBe("19.990574");
});

test("display amounts keep at most six decimals and never round a holding up", () => {
  expect(displayAmount("21163707187261869", 18)).toBe("0.021163");
  expect(displayAmount("1999999999999999999", 18)).toBe("1.999999");
  expect(displayAmount("12485250000000000000000", 18)).toBe("12,485.25");
  expect(displayAmount("19990574", 6)).toBe("19.990574");
  expect(displayAmount("1000000000", 0)).toBe("1,000,000,000");
  expect(displayAmount("0", 18)).toBe("0");
  expect(displayAmount("999", 18)).toBe("<0.000001");
  expect(displayAmount("1000000000000", 18)).toBe("0.000001");
});
