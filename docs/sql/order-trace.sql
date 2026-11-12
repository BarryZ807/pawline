-- Supply the exact order reference with psql --set=order_ref=PL-...
-- This file never changes any business records.
\pset pager off
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT EXISTS(SELECT 1 FROM "Order" WHERE ref=:'order_ref') AS order_found \gset
\if :order_found
SELECT '01 Order and original capture' AS section;
SELECT id,ref,"cartId","cartVersion","attemptId",subtotal,discount,tax,shipping,total,source,"paidAt" FROM "Order" WHERE ref=:'order_ref';
SELECT a.id,a.status,a.amount,a."quoteId",a."providerRef" FROM "Attempt" a JOIN "Order" o ON o."attemptId"=a.id WHERE o.ref=:'order_ref';
SELECT c.id,c.state,c.version FROM "Cart" c JOIN "Order" o ON o."cartId"=c.id WHERE o.ref=:'order_ref';
SELECT '02 Order lines, frozen revisions and photo IDs' AS section;
SELECT l.id,l."variantId",v.sku,l.quantity,l.net,l.tax,l.canceled,l.locked,l.state,l."revisionId" FROM "OrderLine" l JOIN "Order" o ON o.id=l."orderId" JOIN "Variant" v ON v.id=l."variantId" WHERE o.ref=:'order_ref' ORDER BY l.id;
SELECT r.id,r."designId",r.version,r.data->>'name' AS pet_name,r.data->>'frontId' AS front_image,r.data->>'sideId' AS side_image,r."previewId",r."productionId",r."manifestHash" FROM "Revision" r WHERE r.id IN (SELECT l."revisionId" FROM "OrderLine" l JOIN "Order" o ON o.id=l."orderId" WHERE o.ref=:'order_ref' UNION SELECT p."revisionId" FROM "Proof" p JOIN "OrderLine" l ON l.id=p."lineId" JOIN "Order" o ON o.id=l."orderId" WHERE o.ref=:'order_ref') ORDER BY r."designId",r.version;
SELECT '03 Explicit proofs and approved production fingerprints' AS section;
SELECT p.id,p."lineId",p.version,p.state,p."approvedAt",p."manifestHash",p."productionSha" FROM "Proof" p JOIN "OrderLine" l ON l.id=p."lineId" JOIN "Order" o ON o.id=l."orderId" WHERE o.ref=:'order_ref' ORDER BY p."lineId",p.version;
SELECT '04 Factory releases and parcel contents' AS section;
SELECT r.id,r."lineId",r."proofId",r.quantity,r.state,r."externalRef",r."manifestHash" FROM "ProductionRun" r JOIN "OrderLine" l ON l.id=r."lineId" JOIN "Order" o ON o.id=l."orderId" WHERE o.ref=:'order_ref';
SELECT s.id,s.ref,s.state,i."lineId",i."runId",i.quantity FROM "Shipment" s JOIN "Order" o ON o.id=s."orderId" LEFT JOIN "ShipmentItem" i ON i."shipmentId"=s.id WHERE o.ref=:'order_ref';
SELECT '05 Refunds and exact unit allocations' AS section;
SELECT r.id,r.ref,r.status,r.amount,a."lineId",a.quantity,a.net,a.tax,a.shipping FROM "Refund" r JOIN "Order" o ON o.id=r."orderId" LEFT JOIN "RefundAllocation" a ON a."refundId"=r.id WHERE o.ref=:'order_ref';
SELECT o.total AS captured,COALESCE((SELECT sum(r.amount) FROM "Refund" r WHERE r."orderId"=o.id AND r.status='succeeded'),0) AS refunded,o.total-COALESCE((SELECT sum(r.amount) FROM "Refund" r WHERE r."orderId"=o.id AND r.status='succeeded'),0) AS net FROM "Order" o WHERE o.ref=:'order_ref';
SELECT '06 Local provider receipts' AS section;
SELECT id,reference,type,amount,state FROM "SimReceipt" WHERE reference IN (SELECT a."providerRef" FROM "Attempt" a JOIN "Order" o ON o."attemptId"=a.id WHERE o.ref=:'order_ref' UNION SELECT r."externalRef" FROM "ProductionRun" r JOIN "OrderLine" l ON l.id=r."lineId" JOIN "Order" o ON o.id=l."orderId" WHERE o.ref=:'order_ref' UNION SELECT r.ref FROM "Refund" r JOIN "Order" o ON o.id=r."orderId" WHERE o.ref=:'order_ref');
SELECT id,reference,type,state FROM "SimReceipt" WHERE type='carrier' AND payload->>'shipmentId' IN (SELECT s.id FROM "Shipment" s JOIN "Order" o ON o.id=s."orderId" WHERE o.ref=:'order_ref');
SELECT '07 Notifications and asynchronous tasks' AS section;
WITH related_object AS (SELECT id FROM "Order" WHERE ref=:'order_ref' UNION SELECT l.id FROM "OrderLine" l JOIN "Order" o ON o.id=l."orderId" WHERE o.ref=:'order_ref' UNION SELECT p.id FROM "Proof" p JOIN "OrderLine" l ON l.id=p."lineId" JOIN "Order" o ON o.id=l."orderId" WHERE o.ref=:'order_ref' UNION SELECT r.id FROM "Refund" r JOIN "Order" o ON o.id=r."orderId" WHERE o.ref=:'order_ref' UNION SELECT s.id FROM "Shipment" s JOIN "Order" o ON o.id=s."orderId" WHERE o.ref=:'order_ref') SELECT n.id,n.key,n.state,n."sentAt" FROM "Notification" n WHERE EXISTS (SELECT 1 FROM related_object r WHERE n.key LIKE '%'||r.id||'%') OR n.html LIKE '%'||(SELECT ref FROM "Order" WHERE ref=:'order_ref')||'%' ORDER BY n."createdAt";
WITH related_object AS (SELECT id FROM "Order" WHERE ref=:'order_ref' UNION SELECT l.id FROM "OrderLine" l JOIN "Order" o ON o.id=l."orderId" WHERE o.ref=:'order_ref' UNION SELECT p.id FROM "Proof" p JOIN "OrderLine" l ON l.id=p."lineId" JOIN "Order" o ON o.id=l."orderId" WHERE o.ref=:'order_ref' UNION SELECT r.id FROM "Refund" r JOIN "Order" o ON o.id=r."orderId" WHERE o.ref=:'order_ref' UNION SELECT s.id FROM "Shipment" s JOIN "Order" o ON o.id=s."orderId" WHERE o.ref=:'order_ref'), related_notice AS (SELECT n.id FROM "Notification" n WHERE EXISTS (SELECT 1 FROM related_object r WHERE n.key LIKE '%'||r.id||'%') OR n.html LIKE '%'||(SELECT ref FROM "Order" WHERE ref=:'order_ref')||'%') SELECT j.id,j.kind,j.state,j.attempts,j."nextRunAt" FROM "Job" j WHERE j."effectKey" IN (SELECT 'capture:'||o."attemptId" FROM "Order" o WHERE o.ref=:'order_ref' UNION SELECT 'factory:'||r.id FROM "ProductionRun" r JOIN "OrderLine" l ON l.id=r."lineId" JOIN "Order" o ON o.id=l."orderId" WHERE o.ref=:'order_ref' UNION SELECT 'refund:'||r.id FROM "Refund" r JOIN "Order" o ON o.id=r."orderId" WHERE o.ref=:'order_ref' UNION SELECT 'email:'||id FROM related_notice) ORDER BY j."createdAt";
SELECT '08 Business audit events' AS section;
SELECT e.id,e.kind,e."objectId",e."createdAt" FROM "Event" e WHERE e."objectId" IN (SELECT id FROM "Order" WHERE ref=:'order_ref' UNION SELECT l.id FROM "OrderLine" l JOIN "Order" o ON o.id=l."orderId" WHERE o.ref=:'order_ref' UNION SELECT p.id FROM "Proof" p JOIN "OrderLine" l ON l.id=p."lineId" JOIN "Order" o ON o.id=l."orderId" WHERE o.ref=:'order_ref' UNION SELECT r.id FROM "ProductionRun" r JOIN "OrderLine" l ON l.id=r."lineId" JOIN "Order" o ON o.id=l."orderId" WHERE o.ref=:'order_ref') ORDER BY e."createdAt";
\else
\echo 'No order matches the supplied reference.'
DO $missing$ BEGIN RAISE EXCEPTION 'No order matches the supplied reference.'; END $missing$;
\endif
COMMIT;
