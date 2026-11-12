import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { evidence } from './helpers';

test('Design audit: responsive public pages, real images, browser errors and screenshots', async ({page}) => {
  test.setTimeout(180000);
  fs.mkdirSync(evidence,{recursive:true});
  const errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button',{name:'Decline',exact:true}).click();
  const records:any[]=[];
  for(const width of [320,390,768,1440,1920]) {
    await page.setViewportSize({width,height:width<500?844:1000});
    for(const route of ['/','/shop','/products/pet-portrait-mug','/how-it-works','/photo-guide','/cart','/account/sign-in']) {
      const response=await page.goto(route);
      expect(response?.status(),route).toBe(200);
      await expect(page.locator('main h1,main h2').first()).toBeVisible();
      await page.evaluate(()=>document.fonts.ready);
      await page.locator('footer').scrollIntoViewIfNeeded();
      await page.evaluate(async()=>{await Promise.all(Array.from(document.images).map(i=>i.decode().catch(()=>{})));window.scrollTo(0,0)});
      // Paint every viewport before full-page capture; Chromium can omit an offscreen
      // reused image even after decode() when jumping straight from footer to top.
      await page.evaluate(async()=>{for(let y=0;y<document.documentElement.scrollHeight;y+=innerHeight*.75){window.scrollTo(0,y);await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())))}window.scrollTo(0,0)});
      await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
      const metrics=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,images:Array.from(document.images).filter(i=>i.getBoundingClientRect().width>0).map(i=>({src:i.getAttribute('src'),loaded:i.complete&&i.naturalWidth>0})),resources:performance.getEntriesByType('resource').map(e=>({name:new URL(e.name).pathname,bytes:(e as PerformanceResourceTiming).transferSize}))}));
      records.push({width,route,...metrics});
      if([390,1440].includes(width)) await page.screenshot({path:`${evidence}/${width}-${route==='/'?'home':route.replaceAll('/','_')}.png`,fullPage:true});
      expect.soft(metrics.overflow,`${width} ${route} horizontal overflow`).toBeLessThanOrEqual(1);
      expect.soft(metrics.images.filter(i=>!i.loaded),`${width} ${route} broken images`).toEqual([]);
    }
  }
  fs.writeFileSync(evidence+'/responsive-audit.json',JSON.stringify({records,errors},null,2));
  expect(errors).toEqual([]);
});
