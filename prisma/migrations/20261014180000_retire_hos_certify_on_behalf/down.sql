-- Reverts 20261014180000_retire_hos_certify_on_behalf. DATA-ONLY migration: the previous per-role
-- hosCertifyOnBehalf levels were not recorded, so they cannot be restored. Best effort is a no-op:
-- the key stays 'NONE', which the API treats identically (it grants nothing either way).
SELECT 1;
