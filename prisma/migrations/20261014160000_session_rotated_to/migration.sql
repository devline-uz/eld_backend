-- CODE-012/019 — a refresh rotation links the old session to its successor, so access tokens
-- issued on the old id stay valid until the sign-in itself is revoked. Nullable, no backfill:
-- existing rotated rows simply end their (<= 15 min) access tokens as before.
ALTER TABLE "Session" ADD COLUMN "rotatedToId" TEXT;
