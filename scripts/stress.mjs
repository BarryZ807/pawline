import {PrismaClient} from '@prisma/client';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

if(process.env.DATA_SOURCE!=='test'||process.env.ALLOW_TEST_FAULTS!=='1') throw Error('Pressure testing requires an isolated test stack.');
const origin=process.env.APP_PUBLIC_ORIGIN,db=new PrismaClient(),report={startedAt:new Date().toISOString(),phases:[],purchases:[],failures:[]};
const samples=[],statuses={},sleep=ms=>new Promise(r=>setTimeout(r,ms));
let stage='setup';
function client(){return {cookie:'',csrf:''}}
async function call(c,path,method='GET',body,extra={},allowed=[200]){
 const start=performance.now();
 const headers={Origin:origin,...(c.cookie?{Cookie:c.cookie}:{}),...(c.csrf?{'x-csrf-token':c.csrf}:{}),...extra};
 if(body!==undefined)headers['Content-Type']='application/json';
 let r;
 try{r=await fetch(origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)})}
 catch(e){report.failures.push({stage,method,path:path.split('/').slice(0,3).join('/'),ms:Math.round(performance.now()-start),name:e.name,message:e.message,cause:e.cause?.code||e.cause?.message});throw e}
 const raw=await r.text();
 const cookie=r.headers.get('set-cookie');if(cookie)c.cookie=cookie.split(';')[0];
 const elapsed=performance.now()-start;
 samples.push({stage,method,path:path.split('?')[0].replace(/\b(?:c[a-z0-9]{20,}|[a-f0-9-]{30,})\b/g,':id'),ms:Math.round(elapsed),status:r.status});
 statuses[r.status]=(statuses[r.status]||0)+1;
 let data;try{data=JSON.parse(raw)}catch{data={}}
 if(path==='/api/bootstrap')c.csrf=data.csrf;
 if(!allowed.includes(r.status)){report.failures.push({stage,path:path.split('/').slice(0,3).join('/'),status:r.status,code:data.code||data.error?.code});throw Error(`${method} ${path.split('/').slice(0,3).join('/')} returned ${r.status}: ${data.message||data.error?.message||''}`)}
 return {status:r.status,data};
}
async function imageCall(c,path,method,body){
 for(let retry=0;retry<40;retry++){
  const r=await call(c,path,method,body,{},[200,429]);
  if(r.status===200)return r.data;
  await sleep(150+retry*60+Math.random()*150);
 }
 throw Error('Image backpressure did not clear');
}
const percentile=(xs,p)=>xs.slice().sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor(xs.length*p))]||0;
function summary(label){const list=samples.filter(s=>s.stage===label);return {name:label,requests:list.length,p50Ms:percentile(list.map(x=>x.ms),.5),p95Ms:percentile(list.map(x=>x.ms),.95),p99Ms:percentile(list.map(x=>x.ms),.99),maxMs:Math.max(0,...list.map(x=>x.ms)),serverErrors:list.filter(x=>x.status>=500).length}}
async function readPhase(vus,seconds,suffix=''){
 stage=`read-${vus}vu${suffix}`;const label=stage,start=Date.now(),end=start+seconds*1000;
 const clients=Array.from({length:vus},client);
 await Promise.all(clients.map(async(c,i)=>{
  await call(c,'/api/bootstrap');let n=0;
  while(Date.now()<end){
   const route=['/api/products','/api/cart','/api/products/pet-portrait-mug','/health/ready','/shop'][n++%5];
   await call(c,route);await sleep(80+(i%5)*20);
  }
 }));
 const metrics={...summary(label),vus,seconds:(Date.now()-start)/1000};
 report.phases.push(metrics);console.log(JSON.stringify(metrics));
 assert.equal(metrics.serverErrors,0);assert(metrics.p95Ms<1500,'Read p95 must stay below 1.5s');
}
async function buy(i,products){
 const c=client();await call(c,'/api/bootstrap');
 const p=products[i%products.length],v=p.variants[0];
 const d=(await call(c,'/api/designs','POST',{variantId:v.id})).data;
 const front=await imageCall(c,'/api/assets/sample','POST',{pet:i%2?'mochi':'coco',view:'front'});
 const side=p.kind==='tee'?await imageCall(c,'/api/assets/sample','POST',{pet:i%2?'mochi':'coco',view:'side'}):null;
 await imageCall(c,'/api/designs/'+d.id,'PATCH',{version:d.version,data:{...d.data,frontId:front.id,...(side?{sideId:side.id}:{}),name:'Load '+i}});
 await imageCall(c,'/api/cart/lines','POST',{designId:d.id,quantity:1});
 const cart=(await call(c,'/api/cart')).data;
 const code=i%3===0?'PAWS10':'';
 const q=(await call(c,'/api/checkout/quote','POST',{cartVersion:cart.version,address:{name:'Synthetic pressure fixture',email:`load-${i}-${randomUUID()}@example.test`,street:'1 Demo Lane',city:'Irvine',state:'CA',zip:'92618',country:'US'},method:'standard',code})).data;
 const net=v.price-(code?Math.round(v.price*.1):0),tax=Math.round(net*.08),expected=net+tax+(net>=5000?0:599);
 assert.equal(q.snapshot.total,expected);
 const key=randomUUID();
 const responses=await Promise.all(Array.from({length:6},(_,j)=>call(c,'/api/checkout/attempts','POST',{quoteId:q.id,expectedCartVersion:cart.version},{'idempotency-key':j<3?key:randomUUID()},[200,409])));
 const accepted=responses.filter(r=>r.status===200);assert(accepted.length>0);
 assert.equal(new Set(accepted.map(r=>r.data.id)).size,1);
 let at=accepted[0].data;
 for(let n=0;n<100&&at.status!=='paid';n++){await sleep(100);at=(await call(c,'/api/checkout/attempts/'+at.id)).data}
 assert.equal(at.status,'paid');
 const order=(await call(c,'/api/orders/'+at.orderRef)).data;
 assert.equal(order.total,expected);assert.equal(order.lines.length,1);
 const stranger=client();await call(stranger,'/api/bootstrap');
 await call(stranger,'/api/orders/'+at.orderRef,'GET',undefined,{},[404]);
 report.purchases.push({ref:order.ref,attemptId:at.id,cartId:cart.id,total:expected,kind:p.kind});
}
try{
 const startCounts=await db.order.count();assert.equal(startCounts,0,'Use a clean dedicated pressure stack');
 await db.variant.updateMany({data:{capacity:500}});
 const seed=client();await call(seed,'/api/bootstrap');const products=(await call(seed,'/api/products')).data;
 await readPhase(12,45);
 await readPhase(32,45);
 stage='mixed-purchase-12vu';
 const purchaseStart=Date.now();
 for(let wave=0;wave<10;wave++)await Promise.all(Array.from({length:12},(_,i)=>buy(wave*12+i,products)));
 const writes={...summary(stage),vus:12,orders:120,seconds:(Date.now()-purchaseStart)/1000};report.phases.push(writes);console.log(JSON.stringify(writes));
 assert.equal(writes.serverErrors,0);
 assert(writes.p95Ms<6000,'Mixed p95 must stay below 6s including rendering');
 stage='reconcile';
 const orders=await db.order.findMany(),captures=await db.simReceipt.findMany({where:{type:'capture',state:'succeeded'}}),variants=await db.variant.findMany();
 assert.equal(orders.length,120);assert.equal(captures.length,120);assert.equal(new Set(orders.map(o=>o.cartId)).size,120);
 assert.equal(orders.reduce((s,o)=>s+o.total,0),captures.reduce((s,c)=>s+c.amount,0));
 assert.equal(variants.reduce((s,v)=>s+v.allocated,0),120);assert.equal(variants.reduce((s,v)=>s+v.reserved,0),0);
 assert.equal(await db.attempt.count({where:{status:'paid'}}),120);
 for(const p of report.purchases)assert.equal(await db.order.count({where:{cartId:p.cartId}}),1);
 report.reconciliation={orders:orders.length,successfulCaptures:captures.length,total:orders.reduce((s,o)=>s+o.total,0),allocatedUnits:120,reservedUnits:0};
 await readPhase(32,30,'-after-purchases');
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=e.message;process.exitCode=1}
finally{
 report.completedAt=new Date().toISOString();report.statuses=statuses;report.requests=samples.length;
 report.resources={driver:process.memoryUsage(),cgroupPeakBytes:Number(await fs.readFile('/sys/fs/cgroup/memory.peak','utf8').catch(()=>0))||null};
 await fs.writeFile('/tmp/pawline-stress.json',JSON.stringify({...report,samples},null,2));
 console.log(JSON.stringify({...report,purchases:report.purchases.length}));
 await db.$disconnect();
}
