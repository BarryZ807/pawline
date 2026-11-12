import { Prisma } from '@prisma/client';
import { db } from '../infra/db';
import { role, type Auth } from './auth';
import { assert } from './common';

/** Owner-only, read-only inspection. No credentials, arbitrary SQL, or session tokens. */
export async function databaseSummary(a: Auth) {
  role(a, 'owner');
  // Model identifiers come exclusively from the generated schema, never request input.
  const models = Prisma.dmmf.datamodel.models.map(model => model.name).sort();
  const counts = Prisma.join(models.map(name => Prisma.sql`SELECT ${name} AS "table", count(*)::int AS rows FROM ${Prisma.raw('"' + name + '"')}`), ' UNION ALL ');
  const [tables, connection, migrations, recentOrders] = await db.$transaction([
    db.$queryRaw<Array<{table: string; rows: number}>>(counts),
    db.$queryRaw<Array<{database: string; schema: string; version: string; checkedAt: Date}>>`SELECT current_database() AS database, current_schema() AS schema, current_setting('server_version') AS version, CURRENT_TIMESTAMP AS "checkedAt"`,
    db.$queryRaw<Array<{name: string; finishedAt: Date|null}>>`SELECT migration_name AS name, finished_at AS "finishedAt" FROM "_prisma_migrations" WHERE rolled_back_at IS NULL ORDER BY started_at DESC`,
    db.order.findMany({ orderBy: [{paidAt:'desc'},{id:'desc'}], take: 8, select: {id:true,ref:true,total:true,paidAt:true,source:true} }),
  ], { isolationLevel: 'RepeatableRead' });
  const available = await fetch('http://db-ui:5555', { signal: AbortSignal.timeout(1500), cache:'no-store' }).then(r => r.ok).catch(() => false);
  const port = Number(process.env.DATABASE_UI_PORT || 5555);
  return { connection: connection[0], tables, migrations, recentOrders,
    interface: { available, url: `http://127.0.0.1:${Number.isInteger(port)&&port>0&&port<65536?port:5555}` },
    storage: { database:'PostgreSQL named volume', media:'Private media named volume', mail:'Mailpit named volume' },
  };
}

export async function databaseOrderTrace(a: Auth, reference: string) {
  role(a, 'owner');
  assert(reference.length > 0 && reference.length <= 64, 'ORDER_REF', 'Enter an order reference.');
  return db.$transaction(async tx => {
    const order = await tx.order.findUnique({where:{ref:reference},select:{
      id:true,ref:true,cartId:true,cartVersion:true,attemptId:true,total:true,subtotal:true,discount:true,tax:true,shipping:true,source:true,paidAt:true,
      lines:{select:{id:true,variantId:true,revisionId:true,quantity:true,state:true,canceled:true,locked:true,net:true,tax:true,
        proofs:{orderBy:{version:'asc'},select:{id:true,version:true,state:true,revisionId:true,previewId:true,productionId:true,manifestHash:true,productionSha:true,approvedAt:true}},
        runs:{select:{id:true,proofId:true,externalRef:true,quantity:true,state:true,manifestHash:true}},
      }},
      refunds:{select:{id:true,ref:true,amount:true,status:true,allocations:{select:{lineId:true,quantity:true,net:true,tax:true,shipping:true}}}},
      shipments:{select:{id:true,ref:true,state:true,items:{select:{lineId:true,runId:true,quantity:true}}}},
    }});
    assert(order,'NOT_FOUND','No order matches this reference.',404);
    const revisionIds = [...new Set(order.lines.flatMap(line=>[line.revisionId,...line.proofs.map(proof=>proof.revisionId)]))];
    const [attempt, cart, revisions, variants] = await Promise.all([
      tx.attempt.findUnique({where:{id:order.attemptId},select:{id:true,quoteId:true,providerRef:true,status:true,amount:true}}),
      tx.cart.findUnique({where:{id:order.cartId},select:{id:true,state:true,version:true}}),
      tx.revision.findMany({where:{id:{in:revisionIds}},select:{id:true,designId:true,version:true,data:true,previewId:true,productionId:true,manifestHash:true}}),
      tx.variant.findMany({where:{id:{in:order.lines.map(line=>line.variantId)}},select:{id:true,sku:true,productId:true}}),
    ]);
    const assetIds = [...new Set(revisions.flatMap(revision=>{
      const data=revision.data as Record<string,unknown>;
      return [data.frontId,data.sideId,revision.previewId,revision.productionId].filter((id):id is string=>typeof id==='string');
    }).concat(order.lines.flatMap(line=>line.proofs.flatMap(proof=>[proof.previewId,proof.productionId]))))];
    const objectIds = [order.id,...order.lines.map(line=>line.id),...order.lines.flatMap(line=>line.proofs.map(proof=>proof.id)),...order.lines.flatMap(line=>line.runs.map(run=>run.id)),...order.refunds.map(refund=>refund.id),...order.shipments.map(shipment=>shipment.id)];
    const references = [attempt?.providerRef,...order.lines.flatMap(line=>line.runs.map(run=>run.externalRef)),...order.refunds.map(refund=>refund.ref)].filter((value):value is string=>!!value);
    const [assets, receipts, notifications, events] = await Promise.all([
      tx.asset.findMany({where:{id:{in:assetIds}},select:{id:true,kind:true,mime:true,bytes:true,width:true,height:true,sha:true,state:true}}),
      tx.simReceipt.findMany({where:{OR:[{reference:{in:references}},...order.shipments.map(shipment=>({type:'carrier',payload:{path:['shipmentId'],equals:shipment.id}}))]},select:{id:true,reference:true,type:true,amount:true,state:true}}),
      tx.notification.findMany({where:{OR:objectIds.map(id=>({key:{contains:id}}))},select:{id:true,key:true,state:true,sentAt:true},take:50,orderBy:{createdAt:'desc'}}),
      tx.event.findMany({where:{objectId:{in:objectIds}},select:{id:true,kind:true,objectId:true,createdAt:true},take:50,orderBy:{createdAt:'desc'}}),
    ]);
    const effectKeys=[...(attempt?['capture:'+attempt.id]:[]),...order.lines.flatMap(line=>line.runs.map(run=>'factory:'+run.id)),...order.refunds.map(refund=>'refund:'+refund.id),...notifications.map(notification=>'email:'+notification.id)];
    const jobs=await tx.job.findMany({where:{effectKey:{in:effectKeys}},select:{id:true,kind:true,state:true,attempts:true,nextRunAt:true,updatedAt:true},orderBy:{createdAt:'asc'}});
    // Only the photo IDs and pet name are needed to demonstrate the revision chain.
    const safeRevisions=revisions.map(({data,...revision})=>{const fields=data as Record<string,unknown>;return {...revision,name:fields.name,frontId:fields.frontId,sideId:fields.sideId};});
    const refunded=order.refunds.filter(refund=>refund.status==='succeeded').reduce((sum,refund)=>sum+refund.amount,0);
    return {checkedAt:new Date().toISOString(),order,attempt,cart,revisions:safeRevisions,variants,assets,receipts,notifications,jobs,events,totals:{captured:order.total,refunded,net:order.total-refunded}};
  },{isolationLevel:'RepeatableRead',timeout:15000});
}
