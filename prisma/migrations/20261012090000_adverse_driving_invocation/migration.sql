-- BUG-001 — 49 CFR §395.1(b)(1): adverse driving is a per-day exception that must be invoked and
-- annotated, not a permanent limit raise. `Driver.adverseDrivingEnabled` stays the permission flag;
-- this table records the days it was actually invoked. Additive only: existing rows stay valid.
CREATE TABLE "AdverseDrivingInvocation" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "logDate" DATE NOT NULL,
    "annotation" VARCHAR(255) NOT NULL,
    "invokedById" TEXT,
    "invokedByType" TEXT NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdverseDrivingInvocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdverseDrivingInvocation_driverId_logDate_key" ON "AdverseDrivingInvocation"("driverId", "logDate");

ALTER TABLE "AdverseDrivingInvocation" ADD CONSTRAINT "AdverseDrivingInvocation_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
