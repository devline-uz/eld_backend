-- Reverts 20261012090000_adverse_driving_invocation. Drops the per-day invocation ledger (its rows are lost).
DROP TABLE "AdverseDrivingInvocation";
