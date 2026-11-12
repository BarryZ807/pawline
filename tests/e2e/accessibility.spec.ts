import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import {evidence,staffLogin} from './helpers';

test('WCAG AA automated audit: public, customer and staff templates',async({page})=>{
 test.setTimeout(180000);
 fs.mkdirSync(evidence,{recursive:true});
 const records:any[]=[];
 await page.goto('/');
 await page.getByRole('button',{name:'Decline',exact:true}).click();
 const scan=async(route:string)=>{
  await page.goto(route);
  await expect(page.locator('main h1,main h2,main [role="alert"]').first()).toBeVisible();
  await page.evaluate(()=>document.fonts.ready);
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
  records.push({route,violations:result.violations,incomplete:result.incomplete.map(i=>({id:i.id,nodes:i.nodes.length}))});
  expect.soft(result.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),route).toEqual([]);
 };
 for(const route of ['/','/shop','/products/pet-portrait-mug','/products/pet-portrait-shirt','/products/pet-photo-golf-balls','/products/sculpted-pet-golf-tee','/products/pet-driver-headcover','/how-it-works','/photo-guide','/faq','/shipping-returns','/cart','/orders/lookup','/contact','/account/sign-in','/privacy','/terms','/demo','/account/register','/account/forgot','/proof/invalid','/order-access/invalid','/account/reset/invalid','/account/claim/invalid','/customize/invalid','/orders/invalid']) await scan(route);
 if(process.env.AUDIT_STAFF==='1'){
  await staffLogin(page);
  for(const route of ['/admin','/admin/catalog','/admin/orders','/admin/monitor','/admin/database','/studio','/admin/support','/admin/production','/admin/shipments','/admin/simulator','/admin/jobs','/admin/audit','/admin/catalog/mug','/account']) await scan(route);
 }
 fs.writeFileSync(evidence+'/accessibility.json',JSON.stringify(records,null,2));
});
