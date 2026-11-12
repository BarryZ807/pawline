import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { evidence, staffLogin, request } from "./helpers";
test("A02 A03 A16 A29 public navigation, actual empty state, 404 and enabled-control inventory", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  const links = await page
    .locator("header a,footer a")
    .evaluateAll((nodes) => [
      ...new Set(
        nodes
          .map((n) => (n as HTMLAnchorElement).getAttribute("href"))
          .filter(Boolean),
      ),
    ]);
  const inventory: any[] = [];
  for (const href of links) {
    await page
      .locator(
        `header a[href=${JSON.stringify(href)}],footer a[href=${JSON.stringify(href)}]`,
      )
      .first()
      .click();
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("main h1,main h2").first()).toBeVisible();
    inventory.push({
      route: href,
      controls: await page
        .locator("main a,main button,main input,main select,main textarea")
        .evaluateAll((nodes) =>
          nodes.map((n) => ({
            tag: n.tagName,
            type: n.getAttribute("type"),
            role: n.getAttribute("role"),
            label: (n.getAttribute("aria-label") || n.textContent || "")
              .trim()
              .replace(/\s+/g, " ")
              .slice(0, 100),
            disabled: n.hasAttribute("disabled"),
            href: n.getAttribute("href"),
          })),
        ),
    });
  }
  const allowedButtons = new Set([
    "Search",
    "Back to where you were",
    "Send my order link",
    "Send to the studio",
  ]);
  const unmapped = inventory.flatMap((r) =>
    r.controls
      .filter(
        (c: any) =>
          c.tag === "BUTTON" && !c.disabled && !allowedButtons.has(c.label),
      )
      .map((c: any) => ({ route: r.route, label: c.label })),
  );
  expect(unmapped).toEqual([]);
  await page.goto("/photo-guide");
  await page.getByRole("button", { name: "Back to where you were" }).click();
  await expect(page).toHaveURL(/\/terms$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/photo-guide$/);
  await page.goto("/orders/lookup");
  await page.getByLabel("Email address").fill("unknown-fixture@example.test");
  await page.getByRole("button", { name: "Send my order link" }).click();
  await expect(page.getByText(/If matching orders exist/)).toBeVisible();
  await page.goto("/shop");
  await page.getByLabel("Search gifts").fill("no-such-gift-xyz");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Nothing here just yet.").first()).toBeVisible();
  await page
    .getByRole("button", { name: /Clear/ })
    .or(page.getByRole("link", { name: /Clear/ }))
    .last()
    .click();
  await expect(page.locator(".product-card")).toHaveCount(5);
  const missing = await page.goto("/products/does-not-exist");
  expect(missing?.status()).toBe(404);
  await page.getByRole("link", { name: "Back to the shop" }).click();
  await expect(page).toHaveURL(/\/shop$/);
  expect(errors).toEqual([]);
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(
    evidence + "/controls-public.json",
    JSON.stringify(
      {
        inventory,
        unmappedEnabledButtons: unmapped,
        scope:
          "Public control types; parameterized product and staff actions are in their functional suites.",
      },
      null,
      2,
    ),
  );
});
test("A25 A29 mobile keyboard crop, repeat file selection, HEIC error, bag persistence and 200 percent layout", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
  await page.getByRole("link", { name: "Find their perfect gift" }).click();
  await page
    .getByRole("link", { name: /The Morning Companion/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Customize this item" }).click();
  await page.getByLabel("Upload front photo").setInputFiles({
    name: "photo.heic",
    mimeType: "image/heic",
    buffer: Buffer.from("not-a-supported-image"),
  });
  await expect(
    page.getByRole("alert").filter({ hasText: /JPG or PNG/ }),
  ).toBeVisible();
  for (let i = 0; i < 2; i++) {
    await page
      .getByLabel("Upload front photo")
      .setInputFiles("public/assets/mochi-front.png");
    await expect(
      page.getByText("Front photo ready", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Upload front photo")).toBeEnabled();
  }
  await page.getByRole("button", { name: "Next: make it theirs" }).click();
  await page.getByPlaceholder("Their favorite name").fill("Mochi");
  const zoom = page.getByRole("button", { name: "Zoom in", exact: true });
  await zoom.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Review your design" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Add to bag", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Your bag." })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Mochi", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await page.screenshot({ path: evidence + "/mobile-bag.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expect(
    page.getByRole("link", { name: "Continue to checkout" }),
  ).toBeVisible();
  await page.screenshot({
    path: evidence + "/zoom-200-bag.png",
    fullPage: true,
  });
  await context.close();
});
test("A18 A29 owner catalog and support controls change persisted records", async ({
  page,
  browser,
}) => {
  await staffLogin(page);
  const products = (await request(page, "admin/catalog")).data;
  const mug = products.find((p: any) => p.kind === "mug"),
    v = mug.variants[0];
  await page.goto("/admin/catalog/" + mug.id);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByLabel("Price · cents", { exact: true })
    .fill(String(v.price + 100));
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Verify editable demo price");
  await page.getByRole("button", { name: "Save catalog changes" }).click();
  expect(
    (await request(page, "admin/catalog")).data.find(
      (p: any) => p.id === mug.id,
    ).variants[0].price,
  ).toBe(v.price + 100);
  await page
    .locator("tr")
    .filter({ hasText: mug.name })
    .getByRole("button", { name: "Edit product" })
    .click();
  await page.getByLabel("Price · cents", { exact: true }).fill(String(v.price));
  await page.getByLabel("Reason", { exact: true }).fill("Restore test price");
  await page.getByRole("button", { name: "Save catalog changes" }).click();
  await page.goto("/admin/support");
  const buyerContext = await browser.newContext(),
    buyer = await buyerContext.newPage();
  await buyer.goto("/contact");
  await buyer.getByRole("button", { name: "Decline", exact: true }).click();
  await buyer.getByLabel("Email address").fill("support-ui@example.test");
  await buyer.getByLabel("Subject").fill("Sizing help");
  await buyer
    .getByLabel("Your message")
    .fill("How do I choose a shirt size in this local demo?");
  await buyer.getByRole("button", { name: "Send to the studio" }).click();
  await expect(buyer.getByText(/Your message is saved/)).toBeVisible();
  await page.reload();
  const ticket = page.locator(".support-card").filter({
    has: page.getByRole("heading", { name: "Sizing help", exact: true }),
  });
  await ticket.getByRole("button", { name: "Reply / update ticket" }).click();
  await page
    .getByLabel("Reply", { exact: true })
    .fill("Use the S–XL selector on the shirt page.");
  await page
    .getByRole("combobox", { name: "Ticket status" })
    .selectOption("closed");
  await page.getByRole("button", { name: "Save and notify" }).click();
  await expect(ticket.getByText("closed", { exact: true })).toBeVisible();
  const routes = [
    "orders",
    "production",
    "shipments",
    "jobs",
    "audit",
    "simulator",
  ];
  for (const r of routes) {
    await page
      .getByRole("navigation", { name: "Staff navigation" })
      .getByRole("link", {
        name: {
          orders: "Orders",
          production: "Production",
          shipments: "Shipments",
          jobs: "Background jobs",
          audit: "Audit trail",
          simulator: "Local simulator",
        }[r],
        exact: true,
      })
      .click();
    await expect(page.locator("main h1")).toBeVisible();
  }
  await buyerContext.close();
});

test("A18 delivery review and buyer-decided production date preserve original promises", async ({
  browser,
}) => {
  const oc = await browser.newContext(),
    bc = await browser.newContext();
  const owner = await oc.newPage(),
    buyer = await bc.newPage();
  await staffLogin(owner);
  await buyer.goto("/");
  await buyer.getByRole("button", { name: "Decline", exact: true }).click();
  const { quickBuy } = await import("./helpers");
  const o = await quickBuy(buyer, "operations-ui@example.test");
  await buyer.goto("/orders/" + o.ref);
  await buyer
    .getByRole("button", { name: "Request an address change" })
    .click();
  await buyer.getByLabel("street", { exact: true }).fill("2 Updated Demo Lane");
  await buyer.getByRole("button", { name: "Send for review" }).click();
  await owner.goto("/admin/support");
  const ticket = owner
    .locator(".support-card")
    .filter({ hasText: "2 Updated Demo Lane" });
  await ticket.getByRole("button", { name: "Approve delivery update" }).click();
  await owner
    .getByLabel("Review reason")
    .fill("Same demonstration delivery zone");
  await owner.getByRole("button", { name: "Confirm address update" }).click();
  await expect(ticket.getByText("closed", { exact: true })).toBeVisible();
  await owner.goto("/admin/orders/" + o.ref);
  await owner
    .getByRole("button", { name: "Propose a new production date" })
    .click();
  await owner
    .getByLabel("Proposed production date")
    .fill(new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10));
  await owner
    .getByLabel("Reason for date change")
    .fill("A customer-reviewed demonstration schedule change");
  await owner.getByRole("button", { name: "Send date proposal" }).click();
  await expect(owner.getByRole("dialog")).toHaveCount(0);
  await buyer.reload();
  await buyer.getByRole("button", { name: "Accept proposed date" }).click();
  await buyer.getByRole("button", { name: "Save my decision" }).click();
  await expect(buyer.getByText("PRODUCTION DATE · accepted")).toBeVisible();
  const final = (await request(buyer, "orders/" + o.ref)).data;
  expect(final.addressVersion).toBe(2);
  expect(final.address.street).toBe("2 Updated Demo Lane");
  expect(final.snapshot.address.street).not.toBe(final.address.street);
  expect(final.lines[0].originalShipDate).toBe(
    final.dateProposals[0].messages[0].originalDate,
  );
  await oc.close();
  await bc.close();
});
