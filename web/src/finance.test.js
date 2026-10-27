import { describe, expect, it } from "vitest";
import { convertToBRL, marketComparison } from "./finance.js";

describe("currency conversions", () => {
  it("uses the stored exchange rate for BRL conversion", () => {
    expect(convertToBRL("12.34", "USD", { USD: { toBRL: "5.25" } })).toBe("64.785");
  });

  it("returns unavailable when no rate is present", () => {
    expect(convertToBRL("12", "EUR", {})).toBeNull();
  });

  it("returns the original amount when the product currency is BRL", () => {
    expect(convertToBRL("12.34", "BRL", {})).toBe("12.34");
  });
});

describe("market comparison", () => {
  it("calculates difference, percentage, and direction precisely", () => {
    expect(marketComparison("120.25", "100")).toEqual({
      difference: "20.25",
      percentage: "20.25",
      position: "acima",
    });
  });

  it("does not divide by a zero market reference", () => {
    expect(marketComparison("120", "0")).toBeNull();
  });
});
