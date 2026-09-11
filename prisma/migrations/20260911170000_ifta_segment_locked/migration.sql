-- TZ §15 — once an IFTA quarter closes its IftaSegment rows are locked and never recomputed.
ALTER TABLE "IftaSegment" ADD COLUMN "locked" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "IftaSegment_locked_idx" ON "IftaSegment"("locked");
