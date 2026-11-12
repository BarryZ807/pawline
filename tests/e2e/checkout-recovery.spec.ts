import { test, expect } from "@playwright/test";
import { request, staffLogin } from "./helpers";
test("A05 A06 A19 declined payment retries once; refresh recovers the original business key", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await page.goto("/products/pet-portrait-mug");
  await page.getByRole("button", { name: "Customize this item" }).click();
  await page.getByRole("button", { name: "Try Coco" }).click();
  await page.getByRole("button", { name: "Next: make it theirs" }).click();
  await page.getByPlaceholder("Their favorite name").fill("Recovery Coco");
  await page.getByRole("button", { name: "Review your design" }).click();
  await page.getByRole("button", { name: "Add to bag", exact: true }).click();
  await page
    .getByRole("button", { name: "Increase Recovery Coco quantity" })
    .click();
  await expect(page.locator(".quantity-control span")).toHaveText("2");
  await page
    .getByRole("button", { name: "Decrease Recovery Coco quantity" })
    .click();
  await expect(page.locator(".quantity-control span")).toHaveText("1");
  await page.getByRole("link", { name: "Continue to checkout" }).click();
  await page.getByRole("button", { name: "Fill sample details" }).click();
  await page.getByLabel("Local payment mode").selectOption("declined");
  await page.getByRole("button", { name: "Review your total" }).click();
  await page.getByRole("button", { name: "Place demo order · $38.38" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: /Payment declined/ }),
  ).toBeVisible();
  expect((await request(page, "cart")).data.lines).toHaveLength(1);
  await page.getByRole("button", { name: "Review your total" }).click();
  let key = "";
  page.on("request", (r) => {
    if (r.url().endsWith("/api/checkout/attempts") && r.method() === "POST")
      key = r.headers()["idempotency-key"];
  });
  await page.getByRole("button", { name: "Place demo order · $38.38" }).click();
  await expect(page).toHaveURL(/\/orders\/PL-/);
  const ref = page.url().split("/").pop()!;
  expect(key).toBeTruthy();
  await page.evaluate((k) => {
    sessionStorage.removeItem("pawline-attempt");
    sessionStorage.setItem("pawline-pending-key", k);
  }, key);
  await page.goto("/checkout");
  await expect(page).toHaveURL(new RegExp("/orders/" + ref));
  expect((await request(page, "orders/" + ref)).data.total).toBe(3838);
  const foreign = await browser.newContext(),
    stranger = await foreign.newPage();
  await stranger.goto("/");
  expect((await request(stranger, "checkout/recovery?key=" + key)).status).toBe(
    404,
  );
  await foreign.close();
  const oc = await browser.newContext(),
    owner = await oc.newPage();
  await staffLogin(owner);
  const orders = (await request(owner, "admin/orders")).data;
  expect(orders.filter((o: any) => o.ref === ref)).toHaveLength(1);
  await oc.close();
});
