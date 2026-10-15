-- Reverts 20261014160000_session_rotated_to. Rotation links are lost.
ALTER TABLE "Session" DROP COLUMN "rotatedToId";
