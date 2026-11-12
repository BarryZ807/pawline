import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import {evidence} from './helpers';
test('H12 every gallery thumbnail paints real product pixels and each view opens',async({page})=>{
 test.setTimeout(90000);fs.mkdirSync(evidence,{recursive:true});
 const audit=[];
 for(const slug of ['pet-portrait-mug','pet-portrait-shirt','pet-photo-golf-balls','sculpted-pet-golf-tee','pet-driver-headcover']){
  const response=await page.goto('/products/'+slug);expect(response?.status()).toBe(200);
  const decline=page.getByRole('button',{name:'Decline',exact:true});if(await decline.isVisible())await decline.click();
  const thumbs=page.locator('.thumbs button');await expect(thumbs).toHaveCount(3);
  for(let i=0;i<3;i++){
   const b=thumbs.nth(i);await b.scrollIntoViewIfNeeded();
   await b.locator('img').evaluate((img:HTMLImageElement)=>img.decode());
   const before=await b.screenshot({path:evidence+'/'+slug+'-thumb-'+i+'.png'});
   const shape=await b.locator('img').evaluate((img:HTMLImageElement)=>({src:img.currentSrc,display:getComputedStyle(img).display,opacity:getComputedStyle(img).opacity,width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height}));
   audit.push({slug,index:i,bytes:before.length,...shape});expect.soft(before.length,slug+' thumbnail '+i+' has visible image detail').toBeGreaterThan(1500);
   await b.click();await expect(b).toHaveAttribute('aria-pressed','true');
   await page.locator('.main-product-photo img').evaluate((img:HTMLImageElement)=>img.decode());
  }
  if(slug==='pet-portrait-shirt'){
   await page.getByLabel('Choose your option').selectOption('shirt-dark-m');
   await expect(page.locator('.main-product-photo img')).toHaveAttribute('src',/shirt-dark-v2/);
   await expect(page.locator('.main-product-photo img')).toHaveAttribute('alt',/Dark color/);
   await page.locator('.main-product-photo img').evaluate((img:HTMLImageElement)=>img.decode());
   await page.locator('.main-product-photo').screenshot({path:evidence+'/dark-shirt-product.png'});
   await page.getByLabel('Choose your option').selectOption('shirt-light-m');
   await expect(page.locator('.main-product-photo img')).toHaveAttribute('src',/\/shirt-800.webp/);
  }
 }
 fs.writeFileSync(evidence+'/gallery-paint.json',JSON.stringify(audit,null,2));
});
