-- Geofence colour + "count time inside as on-duty yard move" (web overlay 11.1 · Create a geofence).
-- Additive only: a new enum and two NOT NULL columns with defaults, so existing rows are backfilled.

-- CreateEnum
CREATE TYPE "GeofenceColour" AS ENUM ('BLUE', 'GREEN', 'AMBER', 'RED', 'VIOLET');

-- AlterTable
ALTER TABLE "Geofence" ADD COLUMN     "colour" "GeofenceColour" NOT NULL DEFAULT 'BLUE',
ADD COLUMN     "countAsYardMove" BOOLEAN NOT NULL DEFAULT false;
