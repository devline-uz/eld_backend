-- MR-4 (docs/mobile-requests-2026-10-08.md) — PATCH /mobile/trip: multiple shipping documents /
-- trailer numbers and the explicit bobtail flag. Additive, defaults keep old rows valid.
ALTER TABLE "Trip" ADD COLUMN "shippingDocuments" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "trailerNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "bobtail" BOOLEAN NOT NULL DEFAULT false;
