-- Reverts 20261008140000_driver_day_details (D-129).
ALTER TABLE "Dvir" DROP COLUMN "trailerNumber";

DROP TABLE "DriverDayDetails";
