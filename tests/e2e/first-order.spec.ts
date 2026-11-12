import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { settings as env, evidence } from "./helpers";

test("M2 — one Coco mug, durable checkout, separate owner session", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?utm_source=local-demo");
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await page.screenshot({
    path: evidence + "/home-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Find their perfect gift" }).click();
  await page
    .getByRole("link", { name: /The Morning Companion/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Customize this item" }).click();
  await page.getByRole("button", { name: "Try Coco" }).click();
  await page.getByRole("button", { name: "Next: make it theirs" }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Review your design" }).click();
  await page.getByRole("button", { name: "Add to bag", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your bag." })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Coco", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Continue to checkout" }).click();
  await page.getByRole("button", { name: "Fill sample details" }).click();
  await page.getByRole("button", { name: "Review your total" }).click();
  await page.getByRole("button", { name: "Place demo order · $38.38" }).click();
  await expect(
    page.getByRole("heading", { name: "Good things are on their way." }),
  ).toBeVisible();
  const orderRef = page.url().split("/").pop()!;
  await page.reload();
  await expect(
    page.getByText("ORDER " + orderRef, { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: evidence + "/buyer-order.png",
    fullPage: true,
  });
  const owner = await browser.newContext();
  const admin = await owner.newPage();
  await admin.goto("/account/sign-in");
  await admin.getByLabel("Email", { exact: true }).fill("owner@pawline.demo");
  await admin.getByLabel("Password", { exact: true }).fill(env.STAFF_PASSWORD!);
  await admin.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(admin.getByText(orderRef, { exact: true })).toBeVisible();
  await admin.reload();
  await expect(admin.getByText(orderRef, { exact: true })).toBeVisible();
  await admin.screenshot({
    path: evidence + "/owner-order.png",
    fullPage: true,
  });
  await owner.close();
  expect(errors).toEqual([]);
});
