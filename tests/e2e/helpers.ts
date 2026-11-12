import { expect, type Page, type APIRequestContext } from "@playwright/test";
import fs from "node:fs";
export const settings = fs.existsSync(process.env.PAWLINE_ENV_FILE || ".env")
  ? Object.fromEntries(
      fs
        .readFileSync(process.env.PAWLINE_ENV_FILE || ".env", "utf8")
        .split("\n")
        .filter((x) => x.includes("="))
        .map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]),
    )
  : process.env;
export const evidence = process.env.QA_DIR || "artifacts/qa/regression";
export async function dismiss(page: Page) {
  const button = page.getByRole("button", { name: "Decline", exact: true });
  await expect(page.locator("main")).toBeVisible();
  if (await button.isVisible()) await button.click();
}
export async function staffLogin(page: Page, role = "owner") {
  await page.goto("/account/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(role + "@pawline.demo");
  await dismiss(page);
  await page
    .getByLabel("Password", { exact: true })
    .fill(settings.STAFF_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(role === "owner" ? /\/admin$/ : /\/studio$/);
}
export async function request(
  page: Page,
  path: string,
  method = "GET",
  body?: any,
  headers: Record<string, string> = {},
) {
  return page.evaluate(
    async ({ path, method, body, headers }) => {
      const b = await (await fetch("/api/bootstrap")).json();
      const r = await fetch("/api/" + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": b.csrf,
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, data: await r.json() };
    },
    { path, method, body, headers },
  );
}
export async function publishFor(page: Page, orderRef: string, name = "Coco") {
  await page.goto("/studio");
  await page
    .locator(".job-card")
    .filter({ hasText: orderRef })
    .filter({ has: page.getByRole("heading", { name, exact: true }) })
    .click();
  await page.getByRole("button", { name: "Claim this design" }).click();
  await page.getByLabel("Design time · minutes").fill("5");
  await page.getByRole("button", { name: "Publish proof and notify" }).click();
  await page.getByRole("button", { name: "Publish and email proof" }).click();
  await expect(
    page.getByRole("heading", { name: "Version 1", exact: true }),
  ).toBeVisible();
}
export async function approve(page: Page, reference: string) {
  await page.goto("/orders/" + reference);
  await page.getByRole("link", { name: "Review your proof" }).click();
  await page.getByRole("button", { name: "Approve this proof" }).click();
  await page.getByRole("button", { name: "Approve this version" }).click();
  await expect(page.getByText("approved", { exact: true })).toBeVisible();
}
export async function fulfill(page: Page, reference: string) {
  await page.goto("/admin/orders/" + reference);
  await page.getByRole("button", { name: "Release approved units" }).click();
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Verified current approved production master.");
  await page
    .getByRole("button", { name: "Confirm production release" })
    .click();
  await expect(async () => {
    await page
      .getByRole("button", { name: "Refresh order", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Start making", exact: true }),
    ).toBeVisible();
  }).toPass({ timeout: 20000 });
  await page.getByRole("button", { name: "Start making", exact: true }).click();
  await page
    .getByRole("button", { name: "Mark completed", exact: true })
    .click();
  await page.getByRole("button", { name: "Pack units", exact: true }).click();
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Completed production checked and packed.");
  await page
    .getByRole("button", { name: "Create package", exact: true })
    .click();
  for (const name of ["Record first scan", "Mark in transit", "Mark delivered"])
    await page.getByRole("button", { name }).click();
  await expect(
    page.locator(".shipment-row").getByText("delivered", { exact: true }),
  ).toBeVisible();
}
export async function inboxMessages(http: APIRequestContext) {
  const base =
    process.env.MAIL_ORIGIN || "http://127.0.0.1:" + settings.MAIL_PORT;
  const r = await http.get(base + "/api/v1/messages", {
    headers: {
      Authorization:
        "Basic " +
        Buffer.from("operator:" + settings.MAIL_PASSWORD).toString("base64"),
    },
  });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).messages;
}
export async function mailContent(http: APIRequestContext, id: string) {
  const base =
    process.env.MAIL_ORIGIN || "http://127.0.0.1:" + settings.MAIL_PORT;
  return (
    await http.get(base + "/api/v1/message/" + id, {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from("operator:" + settings.MAIL_PASSWORD).toString("base64"),
      },
    })
  ).json();
}
export async function quickBuy(page: Page, email: string) {
  const d = (
    await request(page, "designs", "POST", { variantId: "mug-porcelain" })
  ).data;
  const pet = (
    await request(page, "assets/sample", "POST", { pet: "coco", view: "front" })
  ).data;
  expect(
    (
      await request(page, "designs/" + d.id, "PATCH", {
        version: d.version,
        data: { ...d.data, frontId: pet.id, name: "Coco" },
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
  const a = (
    await request(
      page,
      "checkout/attempts",
      "POST",
      { quoteId: q.id, expectedCartVersion: c.version },
      { "idempotency-key": crypto.randomUUID() },
    )
  ).data;
  expect(a.status).toBe("paid");
  return (await request(page, "orders/" + a.orderRef)).data;
}
