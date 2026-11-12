import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import {staffLogin,request,quickBuy,publishFor,approve,fulfill,evidence} from './helpers';

test('Database inspection is owner-only and returns real PostgreSQL metadata without credentials',async({page,browser})=>{
 await page.goto('/');
 expect((await request(page,'admin/database')).status).toBe(403);
 expect((await request(page,'admin/database/orders/PL-0000000000')).status).toBe(403);
 await page.goto('/admin/database');
 await expect(page.getByRole('heading',{name:'Your staff workspace is private.'})).toBeVisible();
 const designer=await browser.newPage();await staffLogin(designer,'designer');
 expect((await request(designer,'admin/database')).status).toBe(403);
 await staffLogin(page);
 const response=await request(page,'admin/database');expect(response.status).toBe(200);
 const data=response.data;expect(data.connection.database).toBe('pawline');expect(data.connection.version).toMatch(/^17\./);
 expect(data.tables).toHaveLength(33);expect(data.tables.find((t:any)=>t.table==='Product').rows).toBe(5);
 expect(data.interface.available).toBe(true);expect(new URL(data.interface.url).hostname).toBe('127.0.0.1');
 const text=JSON.stringify(data);for(const forbidden of ['passwordHash','DATABASE_URL','SESSION_SECRET','postgresql://'])expect(text).not.toContain(forbidden);
 expect((await request(page,'admin/database/orders/PL-0000000000')).status).toBe(404);
 await page.goto('/admin/database');await expect(page.getByRole('link',{name:'Open database interface'})).toHaveAttribute('href',data.interface.url);
 await expect(page.getByRole('button',{name:'Refresh database'})).toBeEnabled();
 expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
 fs.mkdirSync(evidence,{recursive:true});await page.screenshot({path:evidence+'/database-overview-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:evidence+'/database-overview-mobile.png',fullPage:true});
 fs.writeFileSync(evidence+'/database-summary.json',JSON.stringify(data,null,2));await designer.close();
});

test('A real order links private images, revisions, approved proof, production and delivered shipment in the database view',async({browser})=>{
 test.setTimeout(180000);
 const bc=await browser.newContext(),dc=await browser.newContext(),oc=await browser.newContext();
 try{
  const buyer=await bc.newPage(),designer=await dc.newPage(),owner=await oc.newPage();
  await buyer.goto('/');await buyer.getByRole('button',{name:'Decline',exact:true}).click();
  const order=await quickBuy(buyer,'database-flow@example.test');
  await staffLogin(designer,'designer');await publishFor(designer,order.ref);await approve(buyer,order.ref);
  await staffLogin(owner);await fulfill(owner,order.ref);
  await owner.getByRole('link',{name:'Database',exact:true}).click();
  await owner.getByLabel('Order reference',{exact:true}).fill(order.ref);await owner.getByRole('button',{name:'Trace database records'}).click();
  await expect(owner.getByRole('region',{name:'Order database trace'})).toBeVisible();
  const result=(await request(owner,'admin/database/orders/'+order.ref)).data;
  expect(result.order.id).toBe(order.id);expect(result.attempt.status).toBe('paid');expect(result.cart.state).toBe('closed');
  expect(result.order.lines[0].state).toBe('delivered');expect(result.order.lines[0].proofs[0].state).toBe('approved');
  expect(result.order.lines[0].runs[0].proofId).toBe(result.order.lines[0].proofs[0].id);
  expect(result.order.lines[0].runs[0].manifestHash).toBe(result.order.lines[0].proofs[0].manifestHash);
  expect(result.assets.some((asset:any)=>asset.kind==='source'&&asset.sha.length===64)).toBe(true);
  expect(result.order.shipments[0].items[0].lineId).toBe(result.order.lines[0].id);expect(result.order.shipments[0].state).toBe('delivered');
  expect(result.totals).toEqual({captured:order.total,refunded:0,net:order.total});
  expect(result.receipts.filter((receipt:any)=>receipt.type==='capture'&&receipt.state==='succeeded')).toHaveLength(1);
  expect(result.receipts.filter((receipt:any)=>receipt.type==='carrier').length).toBeGreaterThanOrEqual(3);
  expect(result.jobs.some((job:any)=>job.kind==='email')).toBe(true);
  await owner.locator('summary').filter({hasText:'04 · Proof versions and explicit approval'}).click();
  await expect(owner.locator('.database-records[open] pre')).toContainText('approved');
  const download=owner.waitForEvent('download');await owner.getByRole('button',{name:'Download trace JSON'}).click();const file=await download;
  expect(file.suggestedFilename()).toBe('pawline-database-'+order.ref+'.json');
  fs.mkdirSync(evidence,{recursive:true});await file.saveAs(evidence+'/downloaded-trace.json');
  expect(JSON.parse(fs.readFileSync(evidence+'/downloaded-trace.json','utf8')).order.id).toBe(order.id);
  await owner.evaluate(()=>{document.documentElement.style.scrollBehavior='auto';window.scrollTo(0,0)});
  await owner.screenshot({path:evidence+'/database-order-trace.png',fullPage:true});
  fs.writeFileSync(evidence+'/database-order-trace.json',JSON.stringify(result,null,2));
 }finally{await bc.close();await dc.close();await oc.close();}
});

test('Bundled Prisma Studio opens real Product records and has no missing local assets',async({page})=>{
 const errors:string[]=[],failed:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('response',response=>{if(response.status()>=400)failed.push(response.status()+' '+response.url());});
 await page.goto(process.env.DATABASE_UI_ORIGIN||'http://127.0.0.1:5555');
 await expect(page.getByText('All Models',{exact:true})).toBeVisible();
 await page.getByText('Product',{exact:true}).click();
 await expect(page.getByText('The Morning Companion',{exact:true})).toBeVisible();
 await expect(page.getByText('The Little Caddie',{exact:true})).toBeVisible();
 fs.mkdirSync(evidence,{recursive:true});await page.screenshot({path:evidence+'/prisma-studio-products.png'});
 expect(errors).toEqual([]);expect(failed).toEqual([]);
 fs.writeFileSync(evidence+'/prisma-studio-check.json',JSON.stringify({pageErrors:errors,failedRequests:failed,productRecordsVisible:true},null,2));
});
