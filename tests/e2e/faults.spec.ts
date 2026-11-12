import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import {
  staffLogin,
  request,
  evidence,
  quickBuy,
  inboxMessages,
} from "./helpers";
async function control(action: string) {
  const root = process.env.CONTROL_DIR!;
  await fs.writeFile(root + "/" + action + ".request", "go");
  await expect(async () => {
    await fs.access(root + "/" + action + ".done");
  }).toPass({ timeout: 25000 });
}
test("A12 A16 A27 real worker, DB and Mailpit outages retain and recover state", async ({
  browser,
}) => {
  test.skip(
    !process.env.CONTROL_DIR,
    "Requires the isolated Compose fault controller",
  );
  test.setTimeout(180000);
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
  const timeline: any[] = [];
  await request(owner, "admin/simulator", "POST", {
    action: "workerPaused",
    value: true,
    reason: "Real recovery verification",
  });
  await expect(async () => {
    const m = (await request(owner, "admin/metrics?source=test")).data;
    expect(m.data.system.health.worker).toBe("paused");
  }).toPass({ timeout: 10000 });
  timeline.push({ event: "paused_visible", at: new Date().toISOString() });
  await owner.goto("/admin/orders");
  await control("stop-worker");
  const stopped = Date.now();
  await buyer.goto("/contact");
  await buyer.getByRole("button", { name: "Decline", exact: true }).click();
  await buyer.getByLabel("Email address").fill("recovery@example.test");
  await buyer.getByLabel("Subject").fill("Recovery test");
  await buyer
    .getByLabel("Your message", { exact: true })
    .fill("A local queue and persistence check.");
  await buyer.getByRole("button", { name: "Send to the studio" }).click();
  const queuedOrder = await quickBuy(buyer, "worker-recovery@example.test");
  expect(queuedOrder.total).toBe(3838);
  await expect(async () => {
    const m = (await request(owner, "admin/metrics?source=test")).data;
    expect(m.data.system.health.worker).toBe("stale");
    expect(
      m.data.alerts.filter(
        (a: any) => a.fingerprint === "worker-stale" && !a.resolvedAt,
      ),
    ).toHaveLength(1);
  }).toPass({ timeout: 45000, intervals: [1000, 2000, 3000] });
  timeline.push({
    event: "stale_recorded_without_monitor_tab",
    at: new Date().toISOString(),
    elapsedMs: Date.now() - stopped,
  });
  await owner.goto("/admin/monitor");
  await expect(owner.getByText("stale", { exact: true })).toBeVisible();
  await owner.screenshot({
    path: evidence + "/worker-stale.png",
    fullPage: true,
  });
  await control("start-worker");
  await request(owner, "admin/simulator", "POST", {
    action: "workerPaused",
    value: false,
    reason: "Recover worker",
  });
  await expect(async () => {
    const m = (await request(owner, "admin/metrics?source=test")).data;
    expect(m.data.system.health.worker).toBe("running");
    expect(
      m.data.alerts.some(
        (a: any) => a.fingerprint === "worker-stale" && a.resolvedAt,
      ),
    ).toBeTruthy();
  }).toPass({ timeout: 15000 });
  timeline.push({ event: "worker_recovered", at: new Date().toISOString() });
  await control("stop-db");
  await expect(owner.getByText(/Connection unknown/)).toBeVisible({
    timeout: 15000,
  });
  expect((await owner.request.get("/health/ready")).status()).toBe(503);
  await owner.screenshot({
    path: evidence + "/database-unknown.png",
    fullPage: true,
  });
  await control("start-db");
  await expect(
    owner.getByText("Connected", { exact: true }).first(),
  ).toBeVisible({ timeout: 20000 });
  timeline.push({ event: "database_recovered", at: new Date().toISOString() });
  await control("stop-mail");
  await expect(async () => {
    const m = (await request(owner, "admin/metrics?source=test")).data;
    expect(m.data.system.health.mail).toBe(false);
  }).toPass({ timeout: 15000 });
  const mailOrder = await quickBuy(buyer, "mail-recovery@example.test");
  expect(mailOrder.total).toBe(3838);
  const ticket = (
    await request(buyer, "contact", "POST", {
      email: "recovery@example.test",
      subject: "SMTP outage",
      message: "Please reply after mail recovers.",
    })
  ).data;
  await request(owner, "admin/support/" + ticket.id, "PATCH", {
    reply: "This response is retained until the inbox returns.",
    state: "closed",
  });
  await expect(async () => {
    const m = (await request(owner, "admin/jobs")).data;
    expect(
      m.some((j: any) => ["retry", "running"].includes(j.state)),
    ).toBeTruthy();
  }).toPass({ timeout: 12000 });
  await control("start-mail");
  await expect(async () => {
    const m = (await request(owner, "admin/metrics?source=test")).data;
    expect(m.data.system.health.mail).toBe(true);
  }).toPass({ timeout: 15000 });
  await expect(async () => {
    expect(
      (await inboxMessages(owner.request)).some((m: any) =>
        m.To.some((t: any) => t.Address === "mail-recovery@example.test"),
      ),
    ).toBeTruthy();
  }).toPass({ timeout: 20000 });
  timeline.push({ event: "mail_recovered", at: new Date().toISOString() });
  await request(owner, "admin/simulator", "POST", {
    action: "uploadFailure",
    value: true,
    reason: "Test safe upload failure",
  });
  const failed = await request(buyer, "assets/sample", "POST", {
    pet: "coco",
    view: "front",
  });
  expect(failed.status).toBe(503);
  await request(owner, "admin/simulator", "POST", {
    action: "uploadFailure",
    value: false,
    reason: "Restore uploads",
  });
  expect(
    (
      await request(buyer, "assets/sample", "POST", {
        pet: "coco",
        view: "front",
      })
    ).status,
  ).toBe(200);
  await fs.writeFile(
    evidence + "/physical-recovery.json",
    JSON.stringify(timeline, null, 2),
  );
  await fs.writeFile(process.env.CONTROL_DIR! + "/finish", "done");
  await oc.close();
  await bc.close();
});
