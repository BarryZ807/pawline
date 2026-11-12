import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { settings as env, evidence } from "./helpers";

async function login(page: Page, email: string) {
  await page.goto("/account/sign-in");
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(env.STAFF_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(
    email.startsWith("designer") ? /\/studio$/ : /\/admin$/,
  );
}
async function addMug(page: Page, pet: string) {
  await page.goto("/shop");
  await page
    .getByRole("link", { name: /The Morning Companion/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Customize this item" }).click();
  await page.getByRole("button", { name: "Try " + pet }).click();
  await page.getByRole("button", { name: "Next: make it theirs" }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  if (pet === "Mochi")
    await page.getByRole("button", { name: "Move crop right" }).click();
  await page.getByRole("button", { name: "Review your design" }).click();
  await page.getByRole("button", { name: "Add to bag", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your bag." })).toBeVisible();
}
async function publish(page: Page, pet: string, reference: string, first = true) {
  await page.goto("/studio");
  await page
    .locator(".job-card")
    .filter({ hasText: reference })
    .filter({ has: page.getByRole("heading", { name: pet, exact: true }) })
    .click();
  if (first)
    await page.getByRole("button", { name: "Claim this design" }).click();
  if (!first) {
    await page.getByLabel("Background color", { exact: true }).fill("#b9d7e3");
    await page.getByLabel("Crop scale").fill("0.7");
  }
  await page.getByLabel("Design time · minutes", { exact: false }).fill("7");
  await page.getByRole("button", { name: "Publish proof and notify" }).click();
  await page.getByRole("button", { name: "Publish and email proof" }).click();
  await expect(
    page.getByRole("heading", {
      name: first ? "Version 1" : "Version 2",
      exact: true,
    }),
  ).toBeVisible();
}
test("Golden A05–A08: two portraits, revised Mochi canceled, only Coco delivered", async ({
  browser,
}) => {
  test.setTimeout(180000);
  const buyerContext = await browser.newContext(),
    designerContext = await browser.newContext(),
    ownerContext = await browser.newContext();
  const origins = new Set<string>();
  for (const context of [buyerContext, designerContext, ownerContext])
    context.on("request", (r) => {
      origins.add(new URL(r.url()).origin);
    });
  const buyer = await buyerContext.newPage(),
    designer = await designerContext.newPage(),
    owner = await ownerContext.newPage();
  await buyer.goto("/?utm_source=golden& utm_medium=browser");
  await buyer.getByRole("button", { name: "Allow analytics" }).click();
  await addMug(buyer, "Coco");
  await addMug(buyer, "Mochi");
  await expect(buyer.locator(".bag-line")).toHaveCount(2);
  await buyer.getByRole("link", { name: "Continue to checkout" }).click();
  await buyer.getByRole("button", { name: "Fill sample details" }).click();
  await buyer.getByRole("button", { name: "Review your total" }).click();
  await buyer
    .getByRole("button", { name: "Place demo order · $64.78" })
    .click();
  await expect(
    buyer.getByRole("heading", { name: "Good things are on their way." }),
  ).toBeVisible();
  const orderRef = buyer.url().split("/").pop()!;
  await login(designer, "designer@pawline.demo");
  await publish(designer, "Coco", orderRef);
  await publish(designer, "Mochi", orderRef);
  await buyer.reload();
  await buyer
    .locator(".customer-line")
    .filter({ hasText: "Coco" })
    .getByRole("link", { name: "Review your proof" })
    .click();
  await expect(
    buyer.getByRole("heading", { name: "Looking like Coco?", exact: true }),
  ).toBeVisible();
  await expect(
    buyer.getByText("awaiting review", { exact: true }),
  ).toBeVisible();
  await buyer.getByRole("button", { name: "Approve this proof" }).click();
  await buyer.getByRole("button", { name: "Approve this version" }).click();
  await expect(buyer.getByText("approved", { exact: true })).toBeVisible();
  await buyer.goto("/orders/" + orderRef);
  await buyer
    .locator(".customer-line")
    .filter({ hasText: "Mochi" })
    .getByRole("link", { name: "Review your proof" })
    .click();
  await buyer
    .getByRole("button", { name: "Request changes", exact: true })
    .click();
  await buyer
    .getByLabel("Your feedback")
    .fill("Please use a blue background and a closer crop.");
  await buyer.getByRole("button", { name: "Send change request" }).click();
  await expect(
    buyer.getByText("changes requested", { exact: true }),
  ).toBeVisible();
  await publish(designer, "Mochi", orderRef, false);
  await login(owner, "owner@pawline.demo");
  await owner.getByRole("link", { name: orderRef, exact: false }).click();
  const mochi = owner.locator(".operations-line").filter({
    has: owner.getByRole("heading", { name: "Mochi", exact: true }),
  });
  await mochi.getByRole("button", { name: "Cancel and refund units" }).click();
  await owner
    .getByLabel("Reason", { exact: true })
    .fill("Buyer canceled Mochi before approval and production.");
  await owner
    .getByRole("button", { name: "Confirm cancellation & refund" })
    .click();
  await expect(async () => {
    await owner
      .getByRole("button", { name: "Refresh order", exact: true })
      .click();
    await expect(mochi.getByText("canceled", { exact: true })).toBeVisible();
  }).toPass({ timeout: 20000 });
  const coco = owner
    .locator(".operations-line")
    .filter({ has: owner.getByRole("heading", { name: "Coco", exact: true }) });
  await coco.getByRole("button", { name: "Release approved units" }).click();
  await owner
    .getByLabel("Reason", { exact: true })
    .fill("Golden case: produce the approved Coco proof.");
  await owner
    .getByRole("button", { name: "Confirm production release" })
    .click();
  await expect(async () => {
    await owner
      .getByRole("button", { name: "Refresh order", exact: true })
      .click();
    await expect(
      coco.getByRole("button", { name: "Start making", exact: true }),
    ).toBeVisible();
  }).toPass({ timeout: 20000 });
  await coco.getByRole("button", { name: "Start making", exact: true }).click();
  await coco
    .getByRole("button", { name: "Mark completed", exact: true })
    .click();
  await coco.getByRole("button", { name: "Pack units", exact: true }).click();
  await owner
    .getByLabel("Reason", { exact: true })
    .fill("Coco batch completed and verified.");
  await owner
    .getByRole("button", { name: "Create package", exact: true })
    .click();
  await owner.getByRole("button", { name: "Record first scan" }).click();
  await owner.getByRole("button", { name: "Mark in transit" }).click();
  await owner.getByRole("button", { name: "Mark delivered" }).click();
  await buyer.goto("/orders/" + orderRef);
  await expect(
    buyer
      .locator(".customer-line")
      .filter({ hasText: "Coco" })
      .getByText("delivered", { exact: true }),
  ).toBeVisible();
  await expect(
    buyer
      .locator(".customer-line")
      .filter({ hasText: "Mochi" })
      .getByText("canceled", { exact: true }),
  ).toBeVisible();
  const order = await buyer.evaluate(
    async (ref) => await (await fetch("/api/orders/" + ref)).json(),
    orderRef,
  );
  expect(order.total).toBe(6478);
  expect(order.refunded).toBe(3239);
  expect(
    order.lines.find((l: any) => l.revision.data.name === "Coco").runs,
  ).toHaveLength(1);
  const m = order.lines.find((l: any) => l.revision.data.name === "Mochi");
  expect(m.runs).toHaveLength(0);
  expect(m.proofs[0].version).toBe(2);
  expect(m.proofs[0].state).toBe("awaiting_review");
  expect(order.shipments).toHaveLength(1);
  expect(order.shipments[0].items).toHaveLength(1);
  expect(order.shipments[0].state).toBe("delivered");
  await buyer.screenshot({
    path: evidence + "/buyer-final.png",
    fullPage: true,
  });
  await owner.screenshot({
    path: evidence + "/owner-final.png",
    fullPage: true,
  });
  fs.writeFileSync(
    evidence + "/api-reconciliation.json",
    JSON.stringify(
      {
        orderRef,
        total: order.total,
        refunded: order.refunded,
        net: order.total - order.refunded,
        lines: order.lines.map((l: any) => ({
          name: l.revision.data.name,
          state: l.state,
          quantity: l.quantity,
          canceled: l.canceled,
          proofs: l.proofs.map((p: any) => ({
            version: p.version,
            state: p.state,
            manifestHash: p.manifestHash,
          })),
          productionRuns: l.runs.length,
        })),
        shipments: order.shipments.map((s: any) => ({
          state: s.state,
          items: s.items.length,
        })),
      },
      null,
      2,
    ),
  );
  expect([...origins]).toEqual([
    new URL(process.env.APP_PUBLIC_ORIGIN!).origin,
  ]);
  fs.writeFileSync(
    evidence + "/browser-network.json",
    JSON.stringify({ origins: [...origins], externalRequestCount: 0 }, null, 2),
  );
  await buyerContext.close();
  await designerContext.close();
  await ownerContext.close();
});
