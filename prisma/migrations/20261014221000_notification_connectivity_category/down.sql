-- DOWN migration for 20261014221000_notification_connectivity_category (dev database only).
UPDATE "Notification" SET "category" = 'MAINTENANCE'
WHERE "kind" = 'DEVICE' AND "category" = 'CONNECTIVITY';
