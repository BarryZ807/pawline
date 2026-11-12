-- Read-only snapshot of the database used by the current Pawline instance.
\pset pager off
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT current_database() AS database, current_schema() AS schema, current_setting('server_version') AS postgres_version, CURRENT_TIMESTAMP AS checked_at;
SELECT 'Alert' AS table_name, count(*) AS rows FROM "Alert"
UNION ALL
SELECT 'Asset' AS table_name, count(*) AS rows FROM "Asset"
UNION ALL
SELECT 'Attempt' AS table_name, count(*) AS rows FROM "Attempt"
UNION ALL
SELECT 'CapacityEffect' AS table_name, count(*) AS rows FROM "CapacityEffect"
UNION ALL
SELECT 'Cart' AS table_name, count(*) AS rows FROM "Cart"
UNION ALL
SELECT 'CartLine' AS table_name, count(*) AS rows FROM "CartLine"
UNION ALL
SELECT 'Design' AS table_name, count(*) AS rows FROM "Design"
UNION ALL
SELECT 'Event' AS table_name, count(*) AS rows FROM "Event"
UNION ALL
SELECT 'Grant' AS table_name, count(*) AS rows FROM "Grant"
UNION ALL
SELECT 'Heartbeat' AS table_name, count(*) AS rows FROM "Heartbeat"
UNION ALL
SELECT 'Job' AS table_name, count(*) AS rows FROM "Job"
UNION ALL
SELECT 'Notification' AS table_name, count(*) AS rows FROM "Notification"
UNION ALL
SELECT 'Order' AS table_name, count(*) AS rows FROM "Order"
UNION ALL
SELECT 'OrderAccess' AS table_name, count(*) AS rows FROM "OrderAccess"
UNION ALL
SELECT 'OrderLine' AS table_name, count(*) AS rows FROM "OrderLine"
UNION ALL
SELECT 'Product' AS table_name, count(*) AS rows FROM "Product"
UNION ALL
SELECT 'ProductionRun' AS table_name, count(*) AS rows FROM "ProductionRun"
UNION ALL
SELECT 'Proof' AS table_name, count(*) AS rows FROM "Proof"
UNION ALL
SELECT 'Quote' AS table_name, count(*) AS rows FROM "Quote"
UNION ALL
SELECT 'RateLimit' AS table_name, count(*) AS rows FROM "RateLimit"
UNION ALL
SELECT 'Refund' AS table_name, count(*) AS rows FROM "Refund"
UNION ALL
SELECT 'RefundAllocation' AS table_name, count(*) AS rows FROM "RefundAllocation"
UNION ALL
SELECT 'RequestMetric' AS table_name, count(*) AS rows FROM "RequestMetric"
UNION ALL
SELECT 'Reservation' AS table_name, count(*) AS rows FROM "Reservation"
UNION ALL
SELECT 'Revision' AS table_name, count(*) AS rows FROM "Revision"
UNION ALL
SELECT 'Session' AS table_name, count(*) AS rows FROM "Session"
UNION ALL
SELECT 'Setting' AS table_name, count(*) AS rows FROM "Setting"
UNION ALL
SELECT 'Shipment' AS table_name, count(*) AS rows FROM "Shipment"
UNION ALL
SELECT 'ShipmentItem' AS table_name, count(*) AS rows FROM "ShipmentItem"
UNION ALL
SELECT 'SimReceipt' AS table_name, count(*) AS rows FROM "SimReceipt"
UNION ALL
SELECT 'Ticket' AS table_name, count(*) AS rows FROM "Ticket"
UNION ALL
SELECT 'User' AS table_name, count(*) AS rows FROM "User"
UNION ALL
SELECT 'Variant' AS table_name, count(*) AS rows FROM "Variant"
ORDER BY table_name;
SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at;
SELECT id, slug, kind, active FROM "Product" ORDER BY id;
SELECT id, sku, capacity, reserved, allocated, capacity-reserved-allocated AS available FROM "Variant" ORDER BY sku;
COMMIT;
