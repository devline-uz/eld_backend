-- B-160 — per-driver reset-code budget (5 codes / 24 h, 24 h lock after 15 wrong guesses). Additive only.

-- CreateTable
CREATE TABLE "DriverPasswordResetThrottle" (
    "driverId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "codesIssued" INTEGER NOT NULL DEFAULT 0,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "DriverPasswordResetThrottle_pkey" PRIMARY KEY ("driverId")
);

-- AddForeignKey
ALTER TABLE "DriverPasswordResetThrottle" ADD CONSTRAINT "DriverPasswordResetThrottle_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
