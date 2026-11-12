import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  request,
  staffLogin,
  inboxMessages,
  mailContent,
  evidence,
  settings,
} from "./helpers";
async function buy(page: any, email: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  const d = (
    await request(page, "designs", "POST", { variantId: "mug-porcelain" })
  ).data;
  const asset = (
    await request(page, "assets/sample", "POST", {
      pet: "mochi",
      view: "front",
    })
  ).data;
  expect(
    (
      await request(page, "designs/" + d.id, "PATCH", {
        version: d.version,
        data: { ...d.data, frontId: asset.id, name: "Mochi" },
      })
    ).status,
  ).toBe(200);
  await request(page, "cart/lines", "POST", { designId: d.id, quantity: 1 });
  const c = (await request(page, "cart")).data;
  const q = (
    await request(page, "checkout/quote", "POST", {
      cartVersion: c.version,
      address: {
        name: "Synthetic Buyer",
        email,
        street: "1 Demo Lane",
        city: "Irvine",
        state: "CA",
        zip: "92618",
        country: "US",
      },
      method: "standard",
      code: "",
    })
  ).data;
  const at = (
    await request(
      page,
      "checkout/attempts",
      "POST",
      { quoteId: q.id, expectedCartVersion: c.version },
      { "idempotency-key": randomUUID() },
    )
  ).data;
  expect(at.status).toBe("paid");
  return (await request(page, "orders/" + at.orderRef)).data;
}
async function latestMail(http: any, subject: string, email: string) {
  let found: any;
  await expect(async () => {
    found = (await inboxMessages(http)).find(
      (m: any) =>
        m.Subject === subject && m.To.some((t: any) => t.Address === email),
    );
    expect(found).toBeTruthy();
  }).toPass({ timeout: 20000 });
  return mailContent(http, found.ID);
}
const link = (mail: any) =>
  mail.HTML.match(/href="([^"]+)"/)![1].replaceAll("&amp;", "&");
test("A10 A13 A18 A24 A30 private mail, explicit claim, reset, role and CSRF boundaries", async ({
  browser,
  request: http,
}) => {
  test.setTimeout(120000);
  const b = await browser.newContext(),
    s = await browser.newContext(),
    d = await browser.newContext();
  const buyer = await b.newPage(),
    stranger = await s.newPage(),
    designer = await d.newPage();
  const email = "claim-" + randomUUID().slice(0, 8) + "@example.test";
  const order = await buy(buyer, email);
  await stranger.goto("/");
  expect((await request(stranger, "orders/" + order.ref)).status).toBe(404);
  expect(
    (
      await stranger.request.get(
        "/api/media/" + order.lines[0].revision.previewId,
      )
    ).status(),
  ).toBe(404);
  expect((await request(stranger, "admin/orders")).status).toBe(403);
  const csrf = (await request(buyer, "bootstrap")).data.csrf;
  expect(
    (
      await buyer.request.post("/api/cart/lines", {
        headers: { Origin: "http://foreign.invalid", "x-csrf-token": csrf },
        data: {},
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await buyer.request.post("/api/cart/lines", {
        headers: { Origin: process.env.APP_PUBLIC_ORIGIN! },
        data: {},
      })
    ).status(),
  ).toBe(403);
  const mailbase =
    process.env.MAIL_ORIGIN || "http://127.0.0.1:" + settings.MAIL_PORT;
  expect((await http.get(mailbase + "/api/v1/messages")).status()).toBe(401);
  const mail = await latestMail(http, "Your Pawline order is in", email);
  const url = link(mail);
  expect(new URL(url).origin).toBe(process.env.APP_PUBLIC_ORIGIN);
  await stranger.goto(url);
  await expect(
    stranger.getByRole("heading", { name: "Good things are on their way." }),
  ).toBeVisible();
  const accountCtx = await browser.newContext();
  const account = await accountCtx.newPage();
  await account.goto("/account/register");
  await account.getByRole("button", { name: "Decline", exact: true }).click();
  await account.getByLabel("Your name", { exact: true }).fill("Fixture Buyer");
  await account.getByLabel("Email", { exact: true }).fill(email);
  await account
    .getByLabel("Password", { exact: true })
    .fill("LocalFixture123!");
  await account
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(account).toHaveURL(/\/account$/);
  expect((await request(account, "account")).data.orders).toHaveLength(0);
  await request(account, "account/claim-request", "POST", {
    orderRef: order.ref,
  });
  const claimMail = await latestMail(http, "Confirm your order claim", email);
  const claimURL = link(claimMail);
  await account.goto(claimURL);
  await account.reload();
  expect((await request(account, "account")).data.orders).toHaveLength(0);
  await account.getByRole("button", { name: "Confirm order claim" }).click();
  await expect(account).toHaveURL(new RegExp("/orders/" + order.ref));
  expect((await request(account, "account")).data.orders).toHaveLength(1);
  await request(account, "auth/forgot", "POST", { email });
  const resetMail = await latestMail(
    http,
    "Reset your Pawline password",
    email,
  );
  await account.goto(link(resetMail));
  expect((await request(account, "account")).status).toBe(200);
  await account.getByLabel("New password").fill("ChangedLocal123!");
  await account.getByRole("button", { name: "Update password" }).click();
  await expect(account.getByText(/password is updated/)).toBeVisible();
  expect((await request(account, "account")).status).toBe(401);
  await staffLogin(designer, "designer");
  expect((await request(designer, "admin/orders")).status).toBe(403);
  expect(
    (
      await request(designer, `admin/orders/${order.id}/refunds`, "POST", {
        lineId: order.lines[0].id,
        quantity: 1,
        key: randomUUID(),
        reason: "Forbidden",
      })
    ).status,
  ).toBe(403);
  await b.close();
  await s.close();
  await d.close();
  await accountCtx.close();
});
test("A11 A26 monitor updates in 10 seconds and CSV matches its filtered ledger", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const oc = await browser.newContext(),
    bc = await browser.newContext();
  const owner = await oc.newPage(),
    buyer = await bc.newPage();
  await staffLogin(owner);
  await owner.goto("/admin/monitor");
  await owner
    .getByRole("combobox", { name: "Source", exact: true })
    .selectOption("test");
  await expect(
    owner.getByText("Connected", { exact: true }).first(),
  ).toBeVisible();
  const before = (await request(owner, "admin/metrics?source=test")).data;
  const start = Date.now();
  await buyer.goto("/?utm_source=monitor-check");
  await buyer.getByRole("button", { name: "Allow analytics" }).click();
  await buyer.getByRole("link", { name: "Find their perfect gift" }).click();
  await buyer
    .getByRole("link", { name: /The Morning Companion/ })
    .first()
    .click();
  await expect(async () => {
    const text = await owner.locator(".monitor-columns").first().innerText();
    expect(text).toContain(
      before.data.traffic.observableSessions + 1 + " observable sessions",
    );
  }).toPass({ timeout: 10000 });
  const latency = Date.now() - start;
  const after = (await request(owner, "admin/metrics?source=test")).data;
  expect(after.data.traffic.observableSessions).toBeGreaterThan(
    before.data.traffic.observableSessions,
  );
  const csv = await (
    await owner.request.get("/api/admin/export?source=test")
  ).text();
  expect(csv).toContain("captured_cents");
  for (const record of after.data.records)
    expect(csv).toContain('"' + record.captured + '"');
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(
    evidence + "/monitor-latency.json",
    JSON.stringify(
      {
        startedAt: new Date(start).toISOString(),
        visibleAt: new Date().toISOString(),
        elapsedMs: latency,
        apiAsOf: after.asOf,
        observableBefore: before.data.traffic.observableSessions,
        observableAfter: after.data.traffic.observableSessions,
      },
      null,
      2,
    ),
  );
  await owner.screenshot({ path: evidence + "/monitor.png", fullPage: true });
  await oc.close();
  await bc.close();
});
