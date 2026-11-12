import { test } from "node:test";
import assert from "node:assert/strict";
import {
  priceOrder,
  allocate,
  halfUp,
  defaultRules,
} from "../../src/domain/money";
const address = {
  name: "Taylor",
  email: "taylor@example.test",
  street: "100 Sample Lane",
  city: "Irvine",
  state: "CA",
  zip: "92618",
  country: "US",
};
test("Golden two-pet order: exact row tax and total", () => {
  const q = priceOrder(
    [
      { id: "a", price: 2999, quantity: 1 },
      { id: "b", price: 2999, quantity: 1 },
    ],
    address,
    "standard",
    "",
  );
  assert.equal(q.subtotal, 5998);
  assert.equal(q.tax, 480);
  assert.equal(q.shipping, 0);
  assert.equal(q.total, 6478);
  assert.deepEqual(
    q.lines.map((l) => l.units[0].net + l.units[0].tax),
    [3239, 3239],
  );
});
test("A22 six unit refunds retain the last cent", () => {
  const q = priceOrder(
    [{ id: "a", price: 2999, quantity: 6 }],
    address,
    "standard",
    "PAWS10",
  );
  assert.equal(q.total, 17491);
  assert.deepEqual(
    q.lines[0].units.map((u) => u.net + u.tax),
    [2915, 2915, 2915, 2915, 2915, 2916],
  );
});
test("A26 discounted two-pet order retains per-line rounding", () => {
  const q = priceOrder(
    [
      { id: "a", price: 2999, quantity: 1 },
      { id: "b", price: 2999, quantity: 1 },
    ],
    address,
    "standard",
    "PAWS10",
  );
  assert.equal(q.subtotal - q.discount, 5398);
  assert.equal(q.tax, 432);
  assert.equal(q.total, 5830);
});
test("A22 full cancellation includes original shipping", () => {
  const q = priceOrder(
    [{ id: "a", price: 2999, quantity: 1 }],
    address,
    "standard",
    "",
  );
  assert.equal(q.total, 3838);
});
test("Shipping threshold applies after discount", () => {
  for (const [price, code, shipping] of [
    [4999, "", 599],
    [5000, "", 0],
    [5000, "PAWS10", 599],
  ] as const)
    assert.equal(
      priceOrder([{ id: "a", price, quantity: 1 }], address, "standard", code)
        .shipping,
      shipping,
    );
});
test("Remainder allocation is stable and conserves every cent", () => {
  for (let total = 0; total < 200; total++) {
    const result = allocate(total, [31, 42, 27]);
    assert.equal(
      result.reduce((a, b) => a + b, 0),
      total,
    );
    assert(result.every(Number.isInteger));
  }
  assert.equal(halfUp(5, 2), 3);
});
test("Unsupported destinations, bad coupons and empty bags are refused", () => {
  assert.throws(() => priceOrder([], address, "standard", ""));
  assert.throws(() =>
    priceOrder(
      [{ id: "a", price: 1, quantity: 1 }],
      { ...address, state: "HI" },
      "standard",
      "",
    ),
  );
  assert.throws(() =>
    priceOrder(
      [{ id: "a", price: 1, quantity: 1 }],
      address,
      "standard",
      "INVALID",
    ),
  );
  assert.equal(
    priceOrder(
      [{ id: "a", price: 1000, quantity: 1 }],
      { ...address, state: "DC", zip: "20001" },
      "standard",
      "",
    ).tax,
    0,
  );
});

test('H08 10000 deterministic mixed carts conserve cents across every unit and allocation',()=>{
 let seed=20261101;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed};
 for(let i=0;i<10000;i++){
  const input=Array.from({length:1+random()%5},(_,j)=>({id:'line-'+j,price:random()%100000,quantity:1+random()%20}));
  const coupon=i%2?'PAWS10':'',method=i%3?'standard':'express';
  const q=priceOrder(input,address,method,coupon);
  const gross=input.reduce((n,l)=>n+BigInt(l.price)*BigInt(l.quantity),0n);
  const discount=coupon?(gross*10n+50n)/100n:0n;
  assert.equal(q.subtotal,Number(gross));assert.equal(q.discount,Number(discount));
  assert.equal(q.lines.reduce((n,l)=>n+l.units.reduce((s,u)=>s+u.net+u.tax,0),0)+q.shipping,q.total);
  assert.equal(q.lines.reduce((n,l)=>n+l.shippingAllocation,0),q.shipping);
  assert.equal(q.lines.reduce((n,l)=>n+l.paymentFeeAllocation,0),Number((BigInt(q.total)*27n+500n)/1000n)+30);
  for(const l of q.lines){assert.equal(l.units.length,l.quantity);assert(l.units.every(u=>Number.isSafeInteger(u.net)&&Number.isSafeInteger(u.tax)&&u.net>=0&&u.tax>=0));}
  assert.deepEqual(priceOrder(input.toReversed(),address,method,coupon),q);
 }
});

test('H15 coupon date boundaries, eligible product minimum and mixed-line allocation', async () => {
  const { validateCoupon } = await import('../../src/domain/money');
  const rules = {...defaultRules, couponStartsAt:'2026-01-01T00:00:00Z',couponEndsAt:'2027-01-01T00:00:00Z',couponMinimum:5000,couponProductIds:['mug']};
  const input=[{id:'a',productId:'mug',price:2999,quantity:2},{id:'b',productId:'shirt',price:3499,quantity:1}];
  assert.doesNotThrow(()=>validateCoupon('PAWS10',rules,input,new Date(rules.couponStartsAt)));
  assert.throws(()=>validateCoupon('PAWS10',rules,input,new Date('2025-12-31T23:59:59Z')),/valid dates/);
  assert.throws(()=>validateCoupon('PAWS10',rules,input,new Date(rules.couponEndsAt)),/valid dates/);
  assert.throws(()=>validateCoupon('PAWS10',rules,[input[1]],new Date('2026-06-01')),/does not apply/);
  assert.throws(()=>validateCoupon('PAWS10',rules,[{...input[0],quantity:1},input[1]],new Date('2026-06-01')),/minimum/);
  const q=priceOrder(input,address,'standard','PAWS10',{...rules,couponStartsAt:defaultRules.couponStartsAt,couponEndsAt:defaultRules.couponEndsAt});
  assert.equal(q.discount,600);assert.equal(q.lines[0].discount,600);assert.equal(q.lines[1].discount,0);
});
