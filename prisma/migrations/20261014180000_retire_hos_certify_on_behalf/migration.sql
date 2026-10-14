-- CODE-029: certification is driver-only. `hosCertifyOnBehalf` stays in the permission contract
-- (older clients still send it) but grants nothing; stored role rows are normalised to NONE.
-- Data-only and idempotent; the API already reads the key as NONE without this migration.
UPDATE "Role"
SET "permissions" = jsonb_set("permissions"::jsonb, '{hosCertifyOnBehalf}', '"NONE"'::jsonb)
WHERE "permissions"::jsonb ? 'hosCertifyOnBehalf'
  AND "permissions"::jsonb ->> 'hosCertifyOnBehalf' <> 'NONE';
