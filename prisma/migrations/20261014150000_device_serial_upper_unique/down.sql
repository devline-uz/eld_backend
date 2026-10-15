-- Reverts 20261014150000_device_serial_upper_unique. Drops the index only. The upper-casing/trim of
-- existing Device.serial values is a one-way data normalisation and is NOT undone (original casing
-- was not kept; the plain "Device_serial_key" unique stays valid).
DROP INDEX "Device_serial_upper_key";
