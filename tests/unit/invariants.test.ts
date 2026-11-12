import { test } from "node:test";
import assert from "node:assert/strict";
import { contentHash } from "../../src/domain/common";
import { dateWindow, csvCell } from "../../src/domain/monitor";
import { priceOrder } from "../../src/domain/money";
test("A21 manifest fingerprint survives JSONB object-key reordering", () => {
  assert.equal(
    contentHash({ b: 2, a: { z: 3, k: 1 } }),
    contentHash({ a: { k: 1, z: 3 }, b: 2 }),
  );
  assert.notEqual(contentHash({ a: [1, 2] }), contentHash({ a: [2, 1] }));
});
test("A26 Los Angeles DST days have 23 and 25 actual hours", () => {
  const spring = dateWindow("2026-03-08", "2026-03-08"),
    fall = dateWindow("2026-11-01", "2026-11-01");
  assert.equal((+spring.end - +spring.start) / 3600000, 23);
  assert.equal((+fall.end - +fall.start) / 3600000, 25);
});
test("A26 frozen shipping and payment fee allocations conserve cents across SKUs", () => {
  const q = priceOrder(
    [
      { id: "a", price: 2101, quantity: 1 },
      { id: "b", price: 2898, quantity: 1 },
    ],
    {
      name: "Test",
      email: "test@example.test",
      street: "1 Demo",
      city: "Irvine",
      state: "CA",
      zip: "92618",
      country: "US",
    },
    "standard",
    "",
  );
  assert.equal(
    q.lines.reduce((n, l) => n + l.shippingAllocation, 0),
    599,
  );
  assert.equal(
    q.lines.reduce((n, l) => n + l.paymentFeeAllocation, 0),
    Math.floor((q.total * 27 + 500) / 1000) + 30,
  );
});
test("A10 CSV treats formula-like cells as literal strings", () => {
  assert.equal(csvCell("=2+3"), '"\'=2+3"');
  assert.equal(csvCell('a"b'), '"a""b"');
});
