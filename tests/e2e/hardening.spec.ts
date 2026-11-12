import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import {evidence,request,staffLogin} from './helpers';

test('H05 gallery identity, invalid quantity, responsive CTA, and mobile menu focus',async({page})=>{
 await page.setViewportSize({width:1280,height:720});
 await page.goto('/products/pet-portrait-shirt');
 await page.getByRole('button',{name:'Decline',exact:true}).click();
 await page.getByRole('button',{name:'View sample original photo'}).click();
 await expect(page.locator('.main-product-photo img')).toHaveAttribute('alt',/Mochi/);
 await page.getByRole('button',{name:'View product detail'}).click();
 await expect(page.locator('.main-product-photo img')).toHaveJSProperty('complete',true);
 await page.getByRole('button',{name:'View product image'}).click();
 const cta=page.getByRole('button',{name:'Customize this item'});
 const box=await cta.boundingBox();expect(box!.y+box!.height).toBeLessThanOrEqual(720);
 await page.getByLabel('Quantity',{exact:true}).fill('0');
 await expect(page.getByRole('button',{name:'Choose 1–20 whole items'})).toBeDisabled();
 await page.getByLabel('Quantity',{exact:true}).fill('1.5');
 await expect(page.getByRole('button',{name:'Choose 1–20 whole items'})).toBeDisabled();
 await page.getByLabel('Quantity',{exact:true}).fill('1');
 await expect(cta).toBeEnabled();
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Open menu'}).focus();await page.keyboard.press('Enter');
 await expect(page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Shop all',exact:true})).toBeFocused();
 for(let i=0;i<7;i++)await page.keyboard.press('Tab');
 expect(await page.evaluate(()=>!!document.activeElement?.closest('.site-header'))).toBe(true);
 await page.keyboard.press('Escape');
 await expect(page.getByRole('button',{name:'Open menu'})).toBeFocused();
 await page.screenshot({path:evidence+'/mobile-product.png',fullPage:true});
});

test('H06 cold homepage transfers less than 3 MB and all premium assets decode',async({browser})=>{
 const c=await browser.newContext({viewport:{width:1440,height:900}}),page=await c.newPage();
 await page.goto('/');
 await page.getByRole('button',{name:'Decline',exact:true}).click();
 await page.evaluate(()=>{document.documentElement.style.scrollBehavior='auto'});
 await page.locator('footer').scrollIntoViewIfNeeded();
 await page.evaluate(async()=>Promise.all(Array.from(document.images).map(i=>i.decode())));
 const result=await page.evaluate(()=>({bytes:performance.getEntriesByType('resource').reduce((n,e)=>n+(e as PerformanceResourceTiming).transferSize,0),images:Array.from(document.images).map(i=>({src:i.currentSrc.replace(location.origin,''),width:i.naturalWidth,height:i.naturalHeight})),navigation:performance.getEntriesByType('navigation').map(e=>({duration:e.duration}))}));
 fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(evidence+'/homepage-performance.json',JSON.stringify(result,null,2));
 expect(result.bytes).toBeLessThan(3_000_000);
 expect(result.images.every(i=>i.width>0)).toBeTruthy();
 await c.close();
});

test('H07 source upload failures preserve prior photo and can recover without lost edits',async({page,browser})=>{
 const owner=await browser.newPage();await staffLogin(owner);
 await page.goto('/products/pet-portrait-mug');await page.getByRole('button',{name:'Decline',exact:true}).click();
 await page.getByRole('button',{name:'Customize this item'}).click();
 await page.getByRole('button',{name:/Try Coco/}).click();
 await expect(page.getByText('Front photo ready',{exact:true})).toBeVisible();
 const before=await page.getByAltText('Your front photo',{exact:true}).getAttribute('src');
 // A real storage outage, not an intercepted successful API response.
 const on=await request(owner,'admin/simulator','POST',{action:'uploadFailure',value:true,reason:'Hardening upload recovery'});
 expect(on.status).toBe(200);
 try{
  await page.getByLabel('Upload front photo').setInputFiles('public/assets/mochi-front.png');
  await expect(page.getByRole('alert').filter({hasText:/storage is unavailable/})).toBeVisible();
  expect(await page.getByAltText('Your front photo',{exact:true}).getAttribute('src')).toBe(before);
 }finally{await request(owner,'admin/simulator','POST',{action:'uploadFailure',value:false,reason:'Restore after recovery test'})}
 await page.bringToFront();
 await page.getByLabel('Upload front photo').setInputFiles('public/assets/mochi-front.png');
 await expect(page.getByText('Front photo ready',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Next: make it theirs'}).click();
 await page.getByPlaceholder('Their favorite name').fill('Recovered');
 await page.getByRole('button',{name:'Review your design'}).click();
 await page.getByRole('button',{name:'Add to bag',exact:true}).click();
 await expect(page.getByText('Recovered',{exact:true})).toBeVisible();
 await owner.close();
});

test('H10 malformed nested links return actual 404 responses with a working recovery route',async({page})=>{
 for(const route of ['/shop/unknown','/account/unknown','/admin/unknown','/studio/jobs/a/extra','/orders','/products/absent/extra']){
  expect((await page.goto(route))?.status(),route).toBe(404);
  await page.getByRole('link',{name:'Back to the shop'}).click();
  await expect(page).toHaveURL(/\/shop$/);
 }
});

test('H11 malformed requests reject safely without corrupting a saved design or catalog',async({page,browser})=>{
 await page.goto('/shop');
 await expect(page.locator('.product-card')).toHaveCount(5);
 for(const body of [null,[],7,{variantId:null},{variantId:{}},{}]) expect((await request(page,'designs','POST',body)).status).toBe(422);
 const d=(await request(page,'designs','POST',{variantId:'mug-porcelain'})).data;
 for(const data of [null,[],{...d.data,crop:null},{...d.data,crop:{x:1,y:0,w:0.000001,h:1}},{...d.data,crop:{x:'0',y:0,w:1,h:1}},{...d.data,name:7},{...d.data,frontId:{}},{...d.data,background:'url(bad)'}]){
  expect((await request(page,'designs/'+d.id,'PATCH',{version:d.version,data})).status).toBe(422);
  expect((await request(page,'designs/'+d.id)).data.version).toBe(d.version);
 }
 const pet=(await request(page,'assets/sample','POST',{pet:'coco',view:'front'})).data;
 expect((await request(page,'designs/'+d.id,'PATCH',{version:d.version,data:{...d.data,frontId:pet.id,name:'Validated'}})).status).toBe(200);
 expect((await request(page,'cart/lines','POST',{designId:d.id,quantity:1})).status).toBe(200);
 const cart=(await request(page,'cart')).data;
 const address={name:'Validation buyer',email:'validation@example.test',street:'1 Demo Lane',city:'Irvine',state:'CA',zip:'92618',country:'US'};
 for(const bad of [null,{...address,name:3},{...address,zip:92618},{...address,email:[]},{...address,street:'x'.repeat(501)}]) expect((await request(page,'checkout/quote','POST',{cartVersion:cart.version,address:bad,method:'standard',code:''})).status).toBe(422);
 expect((await request(page,'checkout/quote','POST',{cartVersion:cart.version,address,method:'standard',code:{}})).status).toBe(422);
 expect((await request(page,'checkout/attempts','POST',{quoteId:null,expectedCartVersion:cart.version},{'idempotency-key':'invalid-quote-fixture'})).status).toBe(422);
 expect((await request(page,'cart')).data.version).toBe(cart.version);
 const owner=await browser.newPage();await staffLogin(owner);
 const products=(await request(owner,'admin/catalog')).data,mug=products.find((p:any)=>p.id==='mug'),v=mug.variants[0];
 for(const bad of [{...mug,variants:null},{...mug,reason:1},{...mug,variants:[{...v,price:2147483648}]},{...mug,variants:[{...v,capacity:-1}]},{...mug,variants:[{...v,active:'true'}]}]) expect((await request(owner,'admin/catalog/mug','PATCH',{reason:'Invalid input regression',...bad})).status).toBe(422);
 for(const value of ['0.123','invalid','-1','Infinity']) expect((await request(owner,'studio?page='+value)).status).toBe(200);
 const after=(await request(owner,'admin/catalog')).data.find((p:any)=>p.id==='mug').variants.find((x:any)=>x.id===v.id);
 expect(after.price).toBe(v.price);expect(after.capacity).toBe(v.capacity);expect(after.version).toBe(v.version);
 await owner.close();
});

test('H14 simultaneous first visits keep one usable guest session across tabs',async({browser})=>{
 test.setTimeout(90000);
 for(let round=0;round<3;round++){
  const context=await browser.newContext({reducedMotion:'reduce'}),a=await context.newPage(),b=await context.newPage();
  for(const page of [a,b])await page.route('**/api/bootstrap',async route=>{await new Promise(r=>setTimeout(r,100));await route.continue()});
  await Promise.all([a,b].map(page=>page.goto('/products/pet-portrait-mug')));
  for(const page of [a,b]){
   await expect(page.getByRole('button',{name:'Customize this item'})).toBeEnabled();
   const decline=page.getByRole('button',{name:'Decline',exact:true});if(await decline.isVisible())await decline.click();
  }
  for(const page of [a,b]){await page.bringToFront();await page.getByRole('button',{name:'Customize this item'}).click();await expect(page).toHaveURL(/\/customize\//)}
  expect(a.url()).not.toBe(b.url());
  for(const page of [a,b]){await page.reload();await expect(page.getByRole('heading',{name:'Let’s make it personal.'})).toBeVisible()}
  await context.close();
 }
});

test('H18 unsaved edits survive canceled link, back and reload; discard restores the saved draft',async({page})=>{
 await page.goto('/products/pet-portrait-mug');await page.getByRole('button',{name:'Decline',exact:true}).click();
 await page.getByRole('button',{name:'Customize this item'}).click();
 await page.getByRole('button',{name:/Try Coco/}).click();
 await page.getByRole('button',{name:'Next: make it theirs'}).click();
 const designUrl=page.url(),name=page.getByPlaceholder('Their favorite name');
 await name.fill('Keep this edit');
 page.once('dialog',async d=>{expect(d.message()).toContain('Discard your unsaved changes');await d.dismiss()});
 await page.getByRole('link',{name:'Continue shopping',exact:true}).click();
 await expect(page).toHaveURL(designUrl);await expect(name).toHaveValue('Keep this edit');
 const backDialog=page.waitForEvent('dialog');await page.evaluate(()=>history.back());await (await backDialog).dismiss();
 await expect(page).toHaveURL(designUrl);await expect(name).toHaveValue('Keep this edit');
 const reload=page.waitForEvent('dialog');await page.evaluate(()=>{setTimeout(()=>location.reload(),0)});
 const dialog=await reload;expect(dialog.type()).toBe('beforeunload');await dialog.dismiss();
 await expect(name).toHaveValue('Keep this edit');
 page.once('dialog',d=>d.accept());await page.getByRole('link',{name:'Continue shopping',exact:true}).click();
 await expect(page).toHaveURL(/\/shop$/);
 await page.goto(designUrl);await page.getByRole('tab',{name:'Layout'}).click();
 await expect(name).toHaveValue('Coco');
 await name.fill('Saved safely');await page.getByRole('button',{name:'Save draft',exact:true}).click();
 await expect(page.locator('.save-state')).toContainText('Saved at');
 let prompted=false;page.once('dialog',async d=>{prompted=true;await d.dismiss()});
 await page.getByRole('link',{name:'Continue shopping',exact:true}).click();await expect(page).toHaveURL(/\/shop$/);expect(prompted).toBe(false);
});

test('H19 failed photo save retains the previous photo and current unsaved name',async({page})=>{
 await page.goto('/products/pet-portrait-mug');await page.getByRole('button',{name:'Decline',exact:true}).click();
 await page.getByRole('button',{name:'Customize this item'}).click();await page.getByRole('button',{name:/Try Coco/}).click();
 await expect(page.getByText('Front photo ready',{exact:true})).toBeVisible();
 const designId=page.url().split('/').pop()!,original=await page.getByAltText('Your front photo',{exact:true}).getAttribute('src');
 await page.getByRole('tab',{name:'Layout'}).click();await page.getByPlaceholder('Their favorite name').fill('Keep my name');
 await page.getByRole('tab',{name:'Photo(s)'}).click();
 // A real server version conflict, not a fabricated successful upload response.
 const d=(await request(page,'designs/'+designId)).data;
 await request(page,'designs/'+designId,'PATCH',{version:d.version,data:d.data});
 await page.getByLabel('Upload front photo').setInputFiles('public/assets/mochi-front.png');
 await expect(page.getByRole('alert')).toBeVisible();
 expect(await page.getByAltText('Your front photo',{exact:true}).getAttribute('src')).toBe(original);
 await page.getByRole('tab',{name:'Layout'}).click();await expect(page.getByPlaceholder('Their favorite name')).toHaveValue('Keep my name');
 await expect(page.locator('.save-state')).toContainText('Unsaved changes');
});

test('H20 audit role/date/event filters and CSV reflect the same real records',async({page})=>{
 await staffLogin(page);await page.goto('/admin/audit');
 await page.getByRole('combobox',{name:'Actor role',exact:true}).selectOption('owner');
 await page.getByLabel('Filter events',{exact:true}).fill('account.login');await page.getByRole('button',{name:'Apply filters'}).click();
 const response=await request(page,'admin/audit?role=owner&event=account.login');expect(response.status).toBe(200);
 await expect(page.locator('.audit-summary')).toContainText(response.data.total+' matching events');
 expect(response.data.items.every((e:any)=>e.role==='owner'&&e.kind.includes('account.login'))).toBe(true);
 const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Export matching events'}).click();
 const download=await downloadPromise;const stream=await download.createReadStream();const parts=[];for await(const chunk of stream!)parts.push(chunk);
 const csv=Buffer.concat(parts).toString('utf8');expect(csv.split('\r\n').length).toBe(response.data.total+1);expect(csv).not.toContain('owner@pawline.demo');
 await page.getByLabel('Filter events',{exact:true}).fill('no.such.event');await page.getByRole('button',{name:'Apply filters'}).click();
 await expect(page.getByText('No audit events match these filters.')).toBeVisible();
 await page.getByRole('link',{name:'Clear filters'}).click();await expect(page).toHaveURL(/\/admin\/audit$/);
});
