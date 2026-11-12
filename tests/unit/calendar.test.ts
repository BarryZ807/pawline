import { test } from "node:test";
import assert from "node:assert/strict";
import { businessDays } from "../../src/domain/common";
test("Business targets skip local weekends and retain wall time across DST", () => {
  assert.equal(
    businessDays(new Date("2026-10-31T06:30:00Z"), 1).toISOString(),
    "2026-11-03T07:30:00.000Z",
  );
});
