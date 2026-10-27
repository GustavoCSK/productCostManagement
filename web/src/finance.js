import Decimal from "decimal.js";

export function formatMoney(value, currency) {
  if (value === null || value === undefined || value === "") return "Não disponível";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(Number(value));
  } catch {
    return `${currency} ${new Decimal(value).toFixed(2)}`;
  }
}

export function convertToBRL(value, currency, rates) {
  if (value === null || value === undefined) return null;
  if (currency === "BRL") return new Decimal(value).toString();
  const rate = rates?.[currency]?.toBRL;
  if (rate === undefined) return null;
  return new Decimal(value).mul(rate).toString();
}

export function marketComparison(salePrice, marketValue) {
  if (salePrice === null || marketValue === null || marketValue === undefined) return null;
  const reference = new Decimal(marketValue);
  if (reference.isZero()) return null;
  const difference = new Decimal(salePrice).minus(reference);
  return {
    difference: difference.toString(),
    percentage: difference.div(reference).mul(100).toString(),
    position: difference.isPositive() ? "acima" : difference.isNegative() ? "abaixo" : "igual",
  };
}

export function localDate() {
  const date = new Date();
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}
