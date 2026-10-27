import Decimal from "decimal.js";

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

export function convertToBRL(value, currency, rates) {
  if (value === null || value === undefined) return null;
  if (currency === "BRL") return new Decimal(value).toString();
  const rate = rates?.[currency]?.toBRL;
  return rate === undefined ? null : new Decimal(value).mul(rate).toString();
}

export function calculateAnalytics(view, products, rates, filters = {}) {
  const selected = products.filter((product) => {
    if (view === "stock" && product.status !== "stock") return false;
    if (view === "sold" && product.status !== "sold") return false;
    if (view === "sold" && product.saleDate) {
      const date = new Date(`${product.saleDate}T00:00:00`);
      if (filters.month && date.getMonth() + 1 !== Number(filters.month)) return false;
      if (filters.year && date.getFullYear() !== Number(filters.year)) return false;
      if (filters.from && product.saleDate < filters.from) return false;
      if (filters.to && product.saleDate > filters.to) return false;
    }
    return true;
  });
  let costTotal = new Decimal(0);
  let profitCostTotal = new Decimal(0);
  let revenue = new Decimal(0);
  let marketSales = new Decimal(0);
  let marketReferences = new Decimal(0);
  let costsKnown = true;
  let profitKnown = true;
  let revenueKnown = true;
  let marketKnown = true;
  let profitProductCount = 0;
  let marketProductCount = 0;
  const unavailable = new Set();

  for (const product of selected) {
    const financiallyIncluded = product.salePrice !== null &&
      ((view === "stock" && product.status === "stock") ||
       ((view === "sold" || view === "all") && product.status === "sold"));
    const marketIncluded = product.salePrice !== null && product.marketValue !== null;
    if (financiallyIncluded) profitProductCount += 1;
    if (marketIncluded) marketProductCount += 1;
    const conversion = rates[product.currency]?.toBRL ?? (product.currency === "BRL" ? "1" : null);
    if (conversion === null) {
      unavailable.add(product.currency);
      costsKnown = false;
      if (financiallyIncluded) {
        profitKnown = false;
        revenueKnown = false;
      }
      if (marketIncluded) marketKnown = false;
      continue;
    }
    const rate = new Decimal(conversion);
    const productCost = new Decimal(product.costTotal ?? 0);
    costTotal = costTotal.plus(productCost.mul(rate));
    if (financiallyIncluded) {
      profitCostTotal = profitCostTotal.plus(productCost.mul(rate));
      revenue = revenue.plus(new Decimal(product.salePrice).mul(rate));
    }
    if (marketIncluded) {
      marketSales = marketSales.plus(new Decimal(product.salePrice).mul(rate));
      marketReferences = marketReferences.plus(new Decimal(product.marketValue).mul(rate));
    }
  }

  const profit = revenue.minus(profitCostTotal);
  const difference = marketSales.minus(marketReferences);
  return {
    products: selected,
    costProductCount: selected.length,
    profitProductCount,
    marketProductCount,
    costTotal: costsKnown ? costTotal.toString() : null,
    profitCostTotal: profitKnown ? profitCostTotal.toString() : null,
    revenue: revenueKnown && profitProductCount ? revenue.toString() : null,
    profit: revenueKnown && profitKnown && profitProductCount ? profit.toString() : null,
    profitStatus: !revenueKnown || !profitKnown || !profitProductCount ? "unavailable"
      : profit.isNegative() ? "loss" : profit.isPositive() ? "profit" : "break-even",
    marketDifference: marketKnown && marketProductCount && !marketReferences.isZero() ? difference.toString() : null,
    marketPercent: marketKnown && marketProductCount && !marketReferences.isZero()
      ? difference.div(marketReferences).mul(100).toString() : null,
    currencyUnavailable: [...unavailable].sort(),
  };
}

export function localDate() {
  const date = new Date();
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}
