-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'buyer',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "principal" TEXT NOT NULL,
    "userId" TEXT,
    "csrf" TEXT NOT NULL,
    "analytics" BOOLEAN NOT NULL DEFAULT false,
    "attribution" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'demo',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Grant" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "version" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAccess" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subtitle" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "template" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Variant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "size" TEXT,
    "price" INTEGER NOT NULL,
    "cost" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "allocated" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ready',
    "kind" TEXT NOT NULL DEFAULT 'source',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Design" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL DEFAULT '{}',
    "previewId" TEXT,
    "productionId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Design_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Revision" (
    "id" TEXT NOT NULL,
    "designId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "previewId" TEXT NOT NULL,
    "productionId" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cart" (
    "id" TEXT NOT NULL,
    "principal" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "version" INTEGER NOT NULL DEFAULT 1,
    "activeAttemptId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CartLine" (
    "id" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "CartLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "cartVersion" INTEGER NOT NULL,
    "principal" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attempt" (
    "id" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "cartVersion" INTEGER NOT NULL,
    "quoteId" TEXT NOT NULL,
    "principal" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "amount" INTEGER NOT NULL,
    "scenario" TEXT NOT NULL DEFAULT 'success',
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'reserved',
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapacityEffect" (
    "id" TEXT NOT NULL,
    "effectKey" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapacityEffect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "principal" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "cartVersion" INTEGER NOT NULL,
    "attemptId" TEXT NOT NULL,
    "address" JSONB NOT NULL,
    "addressVersion" INTEGER NOT NULL DEFAULT 1,
    "snapshot" JSONB NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL,
    "tax" INTEGER NOT NULL,
    "shipping" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'demo',
    "attribution" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "net" INTEGER NOT NULL,
    "tax" INTEGER NOT NULL,
    "unitSlices" JSONB NOT NULL,
    "canceled" INTEGER NOT NULL DEFAULT 0,
    "locked" INTEGER NOT NULL DEFAULT 0,
    "held" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'awaiting_design',
    "assignedTo" TEXT,
    "workDraft" JSONB,
    "minutes" INTEGER,
    "deadline" TIMESTAMP(3) NOT NULL,
    "originalShipDate" TIMESTAMP(3) NOT NULL,
    "changesUsed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proof" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "revisionId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'awaiting_review',
    "previewId" TEXT NOT NULL,
    "productionId" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "previewSha" TEXT NOT NULL,
    "productionSha" TEXT NOT NULL,
    "feedback" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Proof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionRun" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "releaseNo" INTEGER NOT NULL,
    "proofId" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'original',
    "parentId" TEXT,
    "reason" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "units" JSONB NOT NULL,
    "cost" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'submitting',
    "scenario" TEXT NOT NULL DEFAULT 'success',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'label_created',
    "method" TEXT NOT NULL,
    "cost" INTEGER NOT NULL,
    "address" JSONB NOT NULL,
    "events" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentItem" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "ShipmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "scenario" TEXT NOT NULL DEFAULT 'success',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "succeededAt" TIMESTAMP(3),

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundAllocation" (
    "id" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "units" JSONB NOT NULL,
    "quantity" INTEGER NOT NULL,
    "net" INTEGER NOT NULL,
    "tax" INTEGER NOT NULL,
    "shipping" INTEGER NOT NULL,

    CONSTRAINT "RefundAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimReceipt" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "effectKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "leaseId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "objectId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'demo',
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "principal" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "orderId" TEXT,
    "lineId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'contact',
    "subject" TEXT NOT NULL,
    "messages" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Heartbeat" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Heartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestMetric" (
    "id" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "duration" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_principal_idx" ON "Session"("principal");

-- CreateIndex
CREATE UNIQUE INDEX "Grant_tokenHash_key" ON "Grant"("tokenHash");

-- CreateIndex
CREATE INDEX "Grant_scope_purpose_idx" ON "Grant"("scope", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "OrderAccess_sessionId_orderId_key" ON "OrderAccess"("sessionId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_sku_key" ON "Variant"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_key_key" ON "Asset"("key");

-- CreateIndex
CREATE INDEX "Asset_owner_idx" ON "Asset"("owner");

-- CreateIndex
CREATE INDEX "Design_owner_idx" ON "Design"("owner");

-- CreateIndex
CREATE UNIQUE INDEX "Revision_designId_version_key" ON "Revision"("designId", "version");

-- CreateIndex
CREATE INDEX "Cart_principal_state_idx" ON "Cart"("principal", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Attempt_providerRef_key" ON "Attempt"("providerRef");

-- CreateIndex
CREATE INDEX "Attempt_status_idx" ON "Attempt"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Attempt_principal_key_key" ON "Attempt"("principal", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_attemptId_variantId_key" ON "Reservation"("attemptId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "CapacityEffect_effectKey_key" ON "CapacityEffect"("effectKey");

-- CreateIndex
CREATE UNIQUE INDEX "Order_ref_key" ON "Order"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "Order_attemptId_key" ON "Order"("attemptId");

-- CreateIndex
CREATE INDEX "Order_principal_paidAt_idx" ON "Order"("principal", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_cartId_cartVersion_key" ON "Order"("cartId", "cartVersion");

-- CreateIndex
CREATE INDEX "OrderLine_state_idx" ON "OrderLine"("state");

-- CreateIndex
CREATE UNIQUE INDEX "Proof_lineId_version_key" ON "Proof"("lineId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionRun_externalRef_key" ON "ProductionRun"("externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionRun_lineId_releaseNo_key" ON "ProductionRun"("lineId", "releaseNo");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_ref_key" ON "Shipment"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentItem_shipmentId_runId_key" ON "ShipmentItem"("shipmentId", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_ref_key" ON "Refund"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_key_key" ON "Refund"("key");

-- CreateIndex
CREATE UNIQUE INDEX "SimReceipt_reference_key" ON "SimReceipt"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Job_effectKey_key" ON "Job"("effectKey");

-- CreateIndex
CREATE INDEX "Job_state_nextRunAt_idx" ON "Job"("state", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_key_key" ON "Notification"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_messageId_key" ON "Notification"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "Event_eventId_key" ON "Event"("eventId");

-- CreateIndex
CREATE INDEX "Event_kind_createdAt_idx" ON "Event"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "Event_objectId_idx" ON "Event"("objectId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_ref_key" ON "Ticket"("ref");

-- CreateIndex
CREATE INDEX "Alert_fingerprint_resolvedAt_idx" ON "Alert"("fingerprint", "resolvedAt");

-- CreateIndex
CREATE INDEX "RequestMetric_createdAt_idx" ON "RequestMetric"("createdAt");

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartLine" ADD CONSTRAINT "CartLine_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proof" ADD CONSTRAINT "Proof_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "OrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionRun" ADD CONSTRAINT "ProductionRun_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "OrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundAllocation" ADD CONSTRAINT "RefundAllocation_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "Variant" ADD CONSTRAINT "capacity_nonnegative" CHECK ("capacity" >= 0 AND "reserved" >= 0 AND "allocated" >= 0 AND "reserved" + "allocated" <= "capacity" AND "price" >= 0 AND "cost" >= 0);
ALTER TABLE "CartLine" ADD CONSTRAINT "quantity_valid" CHECK ("quantity" BETWEEN 1 AND 20);
ALTER TABLE "OrderLine" ADD CONSTRAINT "line_quantity_consistent" CHECK ("quantity" > 0 AND "canceled" >= 0 AND "locked" >= 0 AND "held" >= 0 AND "canceled" + "locked" + "held" <= "quantity");
ALTER TABLE "Order" ADD CONSTRAINT "order_amounts_valid" CHECK ("total" >= 0 AND "total" = "subtotal" - "discount" + "tax" + "shipping");
ALTER TABLE "Refund" ADD CONSTRAINT "refund_positive" CHECK ("amount" > 0);
CREATE UNIQUE INDEX "one_pending_attempt_per_cart" ON "Attempt" ("cartId") WHERE "status" IN ('pending','unknown');
CREATE UNIQUE INDEX "one_open_cart_per_principal" ON "Cart" ("principal") WHERE "state" IN ('open','processing');
CREATE UNIQUE INDEX "one_open_alert" ON "Alert" ("fingerprint") WHERE "resolvedAt" IS NULL;
