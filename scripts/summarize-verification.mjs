import fs from 'node:fs/promises';
import path from 'node:path';
const root=process.argv[2], suites=[];
for(const entry of await fs.readdir(root,{withFileTypes:true})){
 if(!entry.isDirectory())continue;
 try{const r=JSON.parse(await fs.readFile(path.join(root,entry.name,'playwright.json'),'utf8'));suites.push({phase:entry.name,...r.stats});}catch{}
}
async function tap(file){try{const t=await fs.readFile(path.join(root,file),'utf8'),value=k=>Number(t.match(new RegExp('^(?:#|ℹ) '+k+' (\\d+)','m'))?.[1]||0);return{tests:value('tests'),passed:value('pass'),failed:value('fail'),skipped:value('skipped')}}catch{return null}}
const result=JSON.parse(await fs.readFile(path.join(root,'result.json'),'utf8'));
const unit=await tap('unit.log'),integration=await tap('integration.tap');
const browser=suites.reduce((s,r)=>({passed:s.passed+r.expected,failed:s.failed+r.unexpected,skipped:s.skipped+r.skipped,flaky:s.flaky+r.flaky}),{passed:0,failed:0,skipped:0,flaky:0});
let pressure=null;try{const p=JSON.parse(await fs.readFile(path.join(root,'pressure.json'),'utf8'));pressure={status:p.status,requests:p.requests,phases:p.phases,reconciliation:p.reconciliation,failures:p.failures}}catch{}
const summary={...result,image:(await fs.readFile(path.join(root,'image.txt'),'utf8')).trim(),unit,integration,browser,totalPassed:(unit?.passed||0)+(integration?.passed||0)+browser.passed,suites,pressure};
await fs.writeFile(path.join(root,'summary.json'),JSON.stringify(summary,null,2));
