# Mobile → backend requests (2026-10-11)

Source: mobile `docs/missing-screens.md` §c/§e (full app test + 4 new screens: password reset, carrier edit
requests, unidentified "Was this you?", driver log edit). Referenced as `MB-<n>` in bugs.md / decisions.md.
Common rules from `mobile-requests-2026-10-08.md` apply (envelope, additive only, clientId idempotency, Swagger on everything).

## A. User-visible bugs
1. **Presigned URLs point at internal MinIO** (`http://127.0.0.1:19000/...`). Add `S3_PUBLIC_ENDPOINT` (optional): presign
   GET/PUT with a second S3 client whose endpoint is the public one (path-style), internal client keeps upload/delete.
   Unset → current behaviour. Planned value `https://eldapi.stackyard.uz` (nginx `location /<bucket>/` → MinIO, `Host $host`).
2. **`requiresAppUpdate` every launch** — server HOS engine 1.0.3, mobile Dart mirror 1.0.2. Fix = port 1.0.3 into the
   Dart mirror (`docs/hos-engine-1.0.3-changes.md`) and pass the shared conformance fixtures; server logic stays.
3. **Unidentified accepted by driver → `recordOrigin` must be 4** (Appendix A 4.4.4.2.4(e) "assumed from unidentified
   driver profile"), not 1. Check eRODS output too.
4. **PDFs 501**: `GET /mobile/dvirs/{id}/pdf` and `GET /mobile/logs/{date}/export?format=pdf` must return a PDF
   (reuse the web report generators if present).

## B. Push and realtime
5. Chat FCM on `message.new` — DONE 2026-10-10 (D-134), commit e0b711e. 2026-10-13 (D-146): data now also `objectType:"Conversation"`, `objectId:<conversationId>`, `category:"message"`.
   Read receipts DONE (D-146): realtime `message.read {conversationId, readerType:'DRIVER'|'STAFF', readerId, lastReadMessageId, readAt}` to `conversation:{id}`, `driver:{id}`, `user:{id}` on both reads; `Message.deliveredAt` set on thread fetch / read; mobile `participants[].lastReadAt`. Typing: client emits `typing {conversationId,isTyping}`, others in `conversation:{id}` receive `typing {conversationId,userType:'DRIVER'|'STAFF',userId,isTyping}`.
6. Push `data.objectType/objectId/category` — alerts/assignment DONE (D-134). Add: `EDIT_REQUEST` → `objectType:"EditRequest"`,
   `objectId:<editRequestId>`; `UNIDENTIFIED` → `objectType:"UnidentifiedSegment"`, `objectId:<segmentId>`.
7. New edit request (`POST /logs/{driverId}/edit-requests`) and unidentified confirmation request
   (`POST /unidentified/{id}/assign` with `requireDriverConfirmation`) → in-app Notification + FCM (`kind` EDIT_REQUEST / UNIDENTIFIED, data per #6).
8. Realtime: emit `conversation.new` to the driver room when staff opens a conversation with them; messages endpoint
   `GET /mobile/conversations/{id}/messages?after=<messageId|ISO>` cursor (ascending, for reconnect catch-up).

## C. Chat voice + files
9. Chat attachments: upload/presign kinds `CHAT_AUDIO` (aac, m4a, ≤10 MB) and `CHAT_FILE` (png/jpeg/pdf, ≤10 MB);
   message `type: TEXT|AUDIO|IMAGE|FILE` + `attachment{id,url,mimeType,sizeBytes,durationSec?}`; presign allowed to any
   conversation participant (driver or staff), nobody else.

## D. Data for the new screens
10. `GET /mobile/log-edit-requests` items: `date` (RODS day, home-terminal tz), `original{status,start,end,location}|null`,
    `proposedGraph[]` (server-computed day graph if accepted — same algorithm as accept), `requestedBy{id,name}`.
11. `GET /unidentified/confirmation-requests` segments: `startLocation`, `endLocation` (Appendix A 7.29 text),
    `unitNumber`, `startOdometerMi`, `endOdometerMi`.
12. accept/reject (`POST /logs/edit-requests/{id}/accept|reject`), `POST /unidentified/{id}/confirm`,
    `GET /unidentified/confirmation-requests`: confirm the real envelope and write response Swagger schemas.
13. `bootstrap`: `pendingEditRequestCount`, `pendingUnidentifiedCount`.
14. `GET /mobile/logs`: document `carriedOver`; `events[]` must contain every duty-status event of the day.
15. `GET /mobile/dvirs` list rows: `location`.

## E. Password reset
16. Driver without email: `forgot` still 200 (no enumeration); create an in-app notification for the carrier's admins
    ("driver X requested a password reset") so the carrier can use `/api/drivers/{id}/reset-password`. No SMS provider yet.
17. Reset code: 6-digit numeric code (15 min TTL, 5 wrong attempts invalidates it, new forgot invalidates old one);
    `POST /auth/driver/password/reset` accepts `{username|email, code, newPassword}`; old `token` form keeps working.
    Email text shows the code + expiry. Document TTL in Swagger.

## F. Decision
18. Offline inspection transfers: YES, the app queues them; backend accepts `clientId` (idempotent) and optional
    `requestedAt` on the driver transfer endpoint; replay returns the first result.
