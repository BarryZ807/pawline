import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { staffLogin, request, evidence } from "./helpers";
test("A14 A28 restored database, approved files and references remain usable after restart", async ({
  page,
}) => {
  await staffLogin(page);
  const orders = (await request(page, "admin/orders")).data;
  expect(orders.length).toBeGreaterThan(0);
  const candidate = orders.find((o: any) =>
    o.lines.some((l: any) => l.state === "delivered"),
  );
  expect(candidate).toBeTruthy();
  await page.goto("/admin/orders/" + candidate.ref);
  await expect(
    page.getByRole("heading", { name: candidate.ref, exact: true }),
  ).toBeVisible();
  const order = (await request(page, "admin/orders/" + candidate.ref)).data;
  for (const line of order.lines) {
    for (const proof of line.proofs) {
      const response = await page.request.get(
        "/api/media/" + proof.productionId,
      );
      expect(response.ok()).toBeTruthy();
      expect(response.headers()["content-type"]).toContain("image/png");
    }
  }
  const sim = (await request(page, "admin/simulator")).data;
  const factory = sim.receipts.filter((r: any) => r.type === "factory");
  expect(new Set(factory.map((r: any) => r.reference)).size).toBe(
    factory.length,
  );
  await page.goto("/admin/monitor");
  await expect(
    page.getByText("Connected", { exact: true }).first(),
  ).toBeVisible();
  fs.mkdirSync(evidence, { recursive: true });
  await page.screenshot({
    path: evidence + "/restored-monitor.png",
    fullPage: true,
  });
  fs.writeFileSync(
    evidence + "/restored-browser.json",
    JSON.stringify(
      {
        orders: orders.length,
        uniqueFactoryReferences: factory.length,
        orderRef: candidate.ref,
        status: "PASS",
      },
      null,
      2,
    ),
  );
});
