-- MB-17 — hashed 6-digit driver password-reset code (15 min TTL, 5 attempts). Additive only.

-- CreateTable
CREATE TABLE "DriverPasswordResetCode" (
    "driverId" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverPasswordResetCode_pkey" PRIMARY KEY ("driverId")
);

-- AddForeignKey
ALTER TABLE "DriverPasswordResetCode" ADD CONSTRAINT "DriverPasswordResetCode_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
