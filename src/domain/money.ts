import { assert, now } from "./common";
export const money = (c: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    c / 100,
  );
export const halfUp = (n: number, d: number) =>
  Math.floor((n + Math.floor(d / 2)) / d);
export function allocate(total: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const result = weights.map((w) => Math.floor((total * w) / sum));
  const remainders = weights
    .map((w, i) => ({ i, r: (total * w) % sum }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (
    let left = total - result.reduce((a, b) => a + b, 0), i = 0;
    left > 0;
    left--, i++
  )
    result[remainders[i].i]++;
  return result;
}
export type PriceInput = { id: string; price: number; quantity: number; productId?: string };
export type Address = {
  name: string;
  email: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
};
export const STATES =
  "AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(
    " ",
  );
export function validateAddress(a: Address) {
  assert(a && typeof a === "object" && ["name", "email", "street", "city", "state", "zip", "country"].every(k => typeof (a as any)[k] === "string" && (a as any)[k].length <= 500), "ADDRESS", "Complete the delivery address using text fields.");
  assert(
    a && a.country === "US" && STATES.includes(a.state),
    "DESTINATION",
    "We ship to the contiguous United States and DC in this demo.",
  );
  assert(
    /^\d{5}(-\d{4})?$/.test(a.zip),
    "ZIP",
    "Enter a five-digit US ZIP code.",
  );
  assert(
    a.name?.trim() && a.street?.trim() && a.city?.trim(),
    "ADDRESS",
    "Complete the delivery address.",
  );
  assert(
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a.email) && a.email.length < 255,
    "EMAIL",
    "Enter a valid email address.",
  );
}
export type Rules = {
  standard: number;
  express: number;
  threshold: number;
  discountPercent: number;
  code: string;
  version: number;
  couponStartsAt?: string;
  couponEndsAt?: string;
  couponMinimum?: number;
  couponProductIds?: string[];
};
export const defaultRules: Rules = {
  standard: 599,
  express: 1199,
  threshold: 5000,
  discountPercent: 10,
  code: "PAWS10",
  version: 1,
  couponStartsAt: "2000-01-01T00:00:00.000Z",
  couponEndsAt: "2100-01-01T00:00:00.000Z",
  couponMinimum: 0,
  couponProductIds: [],
};
export function validateCoupon(code: string, rules: Rules, input: PriceInput[], at = now()) {
  assert(typeof code === "string" && (!code || code.toUpperCase() === rules.code), "PROMO", "This promo code is not available.");
  if (!code) return;
  const start = new Date(rules.couponStartsAt ?? defaultRules.couponStartsAt!);
  const end = new Date(rules.couponEndsAt ?? defaultRules.couponEndsAt!);
  assert(at >= start && at < end, "PROMO_EXPIRED", "This promo code is outside its valid dates. Remove it or use another code.", 409);
  const products = rules.couponProductIds ?? [];
  const eligible = input.filter(l => !products.length || products.includes(l.productId || ""));
  assert(eligible.length > 0, "PROMO_SCOPE", "This promo code does not apply to the products in your bag.");
  assert(eligible.reduce((sum, l) => sum + l.price * l.quantity, 0) >= (rules.couponMinimum ?? 0), "PROMO_MINIMUM", "The eligible merchandise subtotal is below this promo code’s minimum.");
}
export function priceOrder(
  input: PriceInput[],
  address: Address,
  method: string,
  code: string,
  rules = defaultRules,
) {
  validateAddress(address);
  assert(input.length > 0, "EMPTY_CART", "Add an item to your bag first.");
  assert(
    ["standard", "express"].includes(method),
    "SHIPPING",
    "Choose a delivery method.",
  );
  const sorted = [...input].sort((a, b) => a.id.localeCompare(b.id));
  for (const l of sorted)
    assert(
      Number.isInteger(l.price) &&
        l.price >= 0 &&
        Number.isInteger(l.quantity) &&
        l.quantity > 0 &&
        l.quantity <= 20,
      "QUANTITY",
      "Choose 1–20 units.",
    );
  const values = sorted.map((l) => l.price * l.quantity);
  const subtotal = values.reduce((a, b) => a + b, 0);
  validateCoupon(code, rules, sorted);
  const eligibleValues = sorted.map((l, i) => !rules.couponProductIds?.length || rules.couponProductIds.includes(l.productId || "") ? values[i] : 0);
  const discount = code ? halfUp(eligibleValues.reduce((sum, n) => sum + n, 0) * rules.discountPercent, 100) : 0;
  const discounts = allocate(discount, eligibleValues);
  const lines = sorted.map((l, i) => {
    const net = values[i] - discounts[i];
    const tax =
      address.state === "CA" && address.zip.startsWith("92618")
        ? halfUp(net * 8, 100)
        : 0;
    const unitDiscount = allocate(discounts[i], Array(l.quantity).fill(1));
    const netUnits = unitDiscount.map((d) => l.price - d);
    const taxUnits = allocate(tax, netUnits);
    return {
      ...l,
      discount: discounts[i],
      net,
      tax,
      units: netUnits.map((n, j) => ({
        ordinal: j + 1,
        net: n,
        tax: taxUnits[j],
      })),
    };
  });
  const shipping =
    method === "express"
      ? rules.express
      : subtotal - discount >= rules.threshold
        ? 0
        : rules.standard;
  const tax = lines.reduce((a, l) => a + l.tax, 0);
  const total = subtotal - discount + shipping + tax;
  const shippingAllocations = allocate(
    shipping,
    lines.map((l) => l.net),
  );
  const paymentFeeAllocations = allocate(
    halfUp(total * 27, 1000) + 30,
    lines.map((l) => l.net),
  );
  return {
    lines: lines.map((line, i) => ({
      ...line,
      shippingAllocation: shippingAllocations[i],
      paymentFeeAllocation: paymentFeeAllocations[i],
    })),
    subtotal,
    discount,
    shipping,
    tax,
    total,
    method,
    code,
    ruleVersion: rules.version,
  };
}
