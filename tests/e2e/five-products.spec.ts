import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { createHash } from "node:crypto";
import sharp from "sharp";
import AxeBuilder from '@axe-core/playwright';
import {
  staffLogin,
  dismiss,
  publishFor,
  approve,
  fulfill,
  request,
  evidence,
} from "./helpers";
const products = [
  ["mug", "The Morning Companion", 2400, 1000],
  ["shirt", "The Best Friend Tee", 1800, 2100],
  ["balls", "The Lucky Six", 900, 900],
  ["tee", "The Little Caddie", 1400, 900],
  ["headcover", "The Fairway Friend", 1600, 1800],
] as const;
for (const [kind, title, width, height] of products)
  test(`A17 A25 ${kind}: actual uploaded image to approved master and delivered parcel`, async ({
    browser,
  }) => {
    test.setTimeout(180000);
    const bc = await browser.newContext(),
      dc = await browser.newContext(),
      oc = await browser.newContext();
    const buyer = await bc.newPage(),
      designer = await dc.newPage(),
      owner = await oc.newPage();
    const errors: string[] = [];
    const accessibility:any[]=[];
    const checkA11y=async(page:any,stage:string)=>{
      const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
      accessibility.push({stage,violations:result.violations});
      fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(evidence+'/'+kind+'-flow-accessibility.json',JSON.stringify(accessibility,null,2));
      expect.soft(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),kind+' '+stage).toEqual([]);
    };
    buyer.on("pageerror", (e) => errors.push(e.message));
    await buyer.goto("/");
    await buyer.getByRole("button", { name: "Decline", exact: true }).click();
    await buyer.getByRole("link", { name: "Find their perfect gift" }).click();
    await buyer
      .getByRole("link", { name: new RegExp(title) })
      .first()
      .click();
    if (kind === "shirt")
      await buyer
        .getByLabel("Choose your option")
        .selectOption({ label: "Dark / M" });
    await buyer.getByRole("button", { name: "Customize this item" }).click();
    await buyer
      .getByLabel("Upload front photo", { exact: true })
      .setInputFiles("public/assets/coco-front.png");
    if (kind === "tee") {
      await expect(
        buyer.getByText("Front photo ready", { exact: true }),
      ).toBeVisible();
      await expect(
        buyer.getByLabel("Upload side photo", { exact: true }),
      ).toBeEnabled();
      await expect(
        buyer.getByRole("button", { name: "Next: make it theirs" }),
      ).toBeDisabled();
      await buyer
        .getByLabel("Upload side photo", { exact: true })
        .setInputFiles("public/assets/coco-side.png");
    }
    await buyer.getByRole("button", { name: "Next: make it theirs" }).click();
    await buyer.getByPlaceholder("Their favorite name").fill("Coco");
    await checkA11y(buyer,'personalize');
    await buyer.getByRole("button", { name: "Zoom in", exact: true }).click();
    await buyer.getByRole("button", { name: "Review your design" }).click();
    await expect(
      buyer.getByAltText("Your rendered personal design preview"),
    ).toBeVisible();
    fs.mkdirSync(evidence, { recursive: true });
    await checkA11y(buyer,'preview');
    await buyer.screenshot({
      path: evidence + "/" + kind + "-preview.png",
      fullPage: true,
    });
    await buyer
      .getByRole("button", { name: "Add to bag", exact: true })
      .click();
    await buyer.getByRole("link", { name: "Continue to checkout" }).click();
    await buyer.getByRole("button", { name: "Fill sample details" }).click();
    await buyer.getByRole("button", { name: "Review your total" }).click();
    await checkA11y(buyer,'checkout-review');
    await buyer.getByRole("button", { name: /Place demo order/ }).click();
    await expect(
      buyer.getByRole("heading", { name: "Good things are on their way." }),
    ).toBeVisible();
    const reference = buyer.url().split("/").pop()!;
    await staffLogin(designer, "designer");
    await publishFor(designer, reference);
    await checkA11y(designer,'designer-proof');
    await buyer.goto('/orders/'+reference);
    await buyer.getByRole('link',{name:'Review your proof'}).click();
    await expect(buyer.getByRole('heading',{name:'Looking like Coco?'})).toBeVisible();
    await checkA11y(buyer,'proof-approval');
    await approve(buyer, reference);
    await staffLogin(owner);
    await fulfill(owner, reference);
    await checkA11y(owner,'owner-fulfilled');
    await buyer.goto("/orders/" + reference);
    const order = (await request(buyer, "orders/" + reference)).data;
    expect(order.lines[0].state).toBe("delivered");
    expect(order.lines[0].snapshot.product.kind).toBe(kind);
    const proof = order.lines[0].proofs[0];
    expect(proof.manifest.kind).toBe(kind);
    expect(proof.manifest.dimensions).toEqual({ width, height });
    expect(order.lines[0].runs[0].manifestHash).toBe(proof.manifestHash);
    const bytes = await (
      await buyer.request.get("/api/media/" + proof.productionId)
    ).body();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      proof.productionSha,
    );
    if (kind === "shirt") {
      const preview = await (
        await buyer.request.get("/api/media/" + proof.previewId)
      ).body();
      const pixel = await sharp(preview)
        .extract({ left: 400, top: 600, width: 1, height: 1 })
        .raw()
        .toBuffer();
      expect([...pixel].slice(0, 3)).toEqual([36, 53, 45]);
    }
    const meta = await sharp(bytes).metadata();
    expect([meta.width, meta.height]).toEqual([width, height]);
    if (kind === "tee") expect(proof.manifest.source.sideSha).toHaveLength(64);
    if (kind === "shirt") expect(proof.manifest.variant.color).toBe("Dark");
    await buyer.locator('a[href*="/shipments/"]').click();
    await expect(
      buyer.getByText("delivered", { exact: true }).first(),
    ).toBeVisible();
    if (kind === "headcover") {
      await owner.goto("/admin/orders/" + reference);
      await owner
        .getByRole("button", { name: "Issue a goodwill credit" })
        .click();
      await owner.getByLabel("Merchandise credit · cents").fill("100");
      await owner.getByLabel("Tax credit · cents").fill("8");
      await owner
        .getByLabel("Exception reason")
        .fill("Demonstrate a money-only service credit");
      await owner
        .getByRole("button", { name: "Confirm goodwill refund" })
        .click();
      await expect(async () => {
        const updated = (await request(buyer, "orders/" + reference)).data;
        expect(updated.refunded).toBe(108);
        expect(updated.lines[0].state).toBe("delivered");
        expect(updated.lines[0].canceled).toBe(0);
      }).toPass({ timeout: 15000 });
    }
    expect(errors).toEqual([]);
    await bc.close();
    await dc.close();
    await oc.close();
  });
