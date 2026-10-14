-- LIVE-027 — device/ELD notifications ("ELD connection lost", disconnected, malfunction) get their
-- own CONNECTIVITY segment instead of MAINTENANCE. Data-only and idempotent; the API already reads
-- old rows as CONNECTIVITY (`effectiveNotificationCategory`), so the order of deploy is free.
UPDATE "Notification" SET "category" = 'CONNECTIVITY'
WHERE "kind" = 'DEVICE' AND "category" = 'MAINTENANCE';
