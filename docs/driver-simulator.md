# Haydovchi simulyatori (live driver simulator) · 2026-10-13

`scripts/sim-drivers.ts` — ~30 ta haydovchini **haqiqiy API** orqali ON DUTY qilib, US interstate
yo'llarida "haydatadi". Web panel (Live Fleet xaritasi, Dashboard, HOS Logs, realtime, alertlar)
ularni xuddi haqiqiy haydovchidek ko'radi. Qaror: `decisions.md` D-148.

## Qanday ishlaydi (haqiqiy ilova yo'li)

| Qadam | Chaqiruv | Izoh |
|---|---|---|
| Kirish | `POST /auth/login/driver` (parol `Onebook2026`) | server o'zi 5/1 login yozuvini qo'yadi (D-130) |
| Unit | o'z uniti yoki `POST /mobile/select-vehicle` | faqat haqiqiy PT30/PT40 ulanmagan unitlar; `johnsmith`, `devline.qa01` hech qachon olinmaydi |
| Qurilma | `POST /mobile/virtual-devices` serial `VPT30_SIM01..99` | Virtual ELD; carrier `erodsMode=TEST` bo'lishi shart |
| BLE | `POST /ingest/ble-state CONNECTED`, har 5 daq `POST /ingest/device-status` | |
| Smena boshi | `6/1` engine power-up + `EV_ENGINE_ON` + `POST /mobile/duty-status ON` | pre-trip 10–15 daq |
| Harakat | `1/3` D (recordOrigin 1) birinchi > 5 mph nuqtada | ilovaning `EldEventGenerator` qoidasi |
| Har soat | `2/1` intermediate log | |
| To'xtash | 0 mph 5+1 daq → `1/4` ON (avtomatik) | yoqilg'i 15 daq ON; tanaffus: `duty-status OFF` ≥30 daq → `ON` |
| Smena oxiri | post-trip → `6/3` + `EV_ENGINE_OFF` + `duty-status OFF`, 10 soat dam | normal: ≤10.5 soat haydash / 13.5 soat smena |
| Telemetriya | `POST /ingest/telemetry`, 1 nuqta / 60 s, start/stop o'tishlari doim yuboriladi | |

Har hodisa server algoritmi bilan checksum qilinadi (`src/modules/ingest/checksum.ts`), vaqtlar — real
soat (siqilmagan). HOS, violation, realtime, alertlar — server o'zi hisoblaydi.

## Ishga tushirish

```bash
cd backend
npm run sim:drivers -- --drivers 3 --once        # sinov: sozlash + 1 tick
npm run sim:drivers -- --drivers 30              # Ctrl-C gacha; chiqishda hammasi OFF DUTY
npm run sim:drivers -- --stop                    # hammani OFF DUTY qilib chiqadi
npm run sim:drivers -- --cleanup                 # OFF + virtual qurilmani unpair + tanlangan unitni bo'shatish
npm run sim:drivers -- --dry-run                 # faqat o'qiydi: kim/qaysi unit tanlanishini ko'rsatadi
```

pm2 (fon rejimi; `--kill-timeout` — SIGINT da 30 haydovchini OFF qilishga vaqt):

```bash
cd /root/projects/devline/eld_logistics/backend
pm2 start node_modules/ts-node/dist/bin.js --name eld-sim --kill-timeout 60000 -- -T scripts/sim-drivers.ts --drivers 30
pm2 logs eld-sim      # har tick bitta qator
pm2 stop eld-sim      # SIGINT → haydovchilar OFF DUTY
pm2 delete eld-sim
```

## Flaglar

| Flag | Default | Ma'nosi |
|---|---|---|
| `--drivers N` | 30 | haydovchilar soni (max 99) |
| `--interval S` | 3 | tick oralig'i; haydovchilar tick ichida tekis taqsimlanadi |
| `--point-every S` | 3 | telemetriya zichligi; real vaqt xaritasi uchun 3 s (oradagi harakatni web animatsiya qiladi) (ilova shartnomasi 60 s, kichikrog'i `denserThanContract` deb sanaladi) |
| `--once` | — | sozlash + bitta tick, OFF qilmasdan chiqadi |
| `--stop` | — | hammani OFF DUTY, BLE DISCONNECTED |
| `--cleanup` | — | `--stop` + `POST /devices/:id/unpair` + `POST /mobile/release-vehicle` (faqat sim tanlagan unitlar); state `.cleaned-*.json` ga ko'chadi |
| `--dry-run` | — | hech narsa yozmaydi |
| `--quick-start` | — | har ishga tushirishda birinchi pre-trip 1–3 daq (demo uchun tez D); kruiz 50–60 mph |
| `--violation-drivers N` | 0 | birinchi N slot tanaffussiz, 12.5 soat haydash / 15.5 soat smenagacha → BREAK_30, DRIVING_11, SHIFT_14 (real vaqtda!) |
| `--backfill-hours H` | 0 | faqat yangi haydovchi sozlanganda: bugungi tarixni o'tgan vaqt bilan yozadi (max 14). **Diqqat:** server >10 daq eski hodisaga `malfunction T` qo'yadi (202 + warning) |
| `--duration S` | 0 | S soniyadan keyin OFF qilib chiqadi |
| `--login-gap S` | 15 | loginlar oralig'i (min 12): `/auth/login/driver` 5/daq/IP, nginx ortidagi hamma bilan umumiy |
| `--exclude a,b` | — | qo'shimcha chetlatiladigan username'lar |
| `--api URL` | `http://127.0.0.1:3002/api` | yoki `SIM_API_URL` |
| `--state FILE` | `scripts/sim/.state/sim-state.json` | tokenlar, qurilma, odometr, pozitsiya, yuborilmagan navbat (gitignore) |

Env: `SIM_ADMIN_EMAIL` (default `sarah.chen@…`), `SIM_PASSWORD` (default `Onebook2026`).

## Qayta ishga tushirish

State fayl saqlanadi: qayta ishga tushganda o'sha haydovchilar, qurilmalar va pozitsiyadan davom etadi
(login qayta qilinmaydi — token 24 soat, refresh avtomatik). Uzilish 10 daqiqadan uzun bo'lsa tarix
"to'ldirilmaydi" — o'sha joydan davom etadi. `--stop` bilan to'xtatilgan haydovchilar qayta ishga
tushganda darhol yangi smena boshlaydi.

## Ma'lum cheklovlar

- Yangi juftlangan unitning birinchi aloqasida server 24 soatlik oynadagi bo'shliq sababli `E`, `L` malfunction va
  diagnostic `2` yozadi (haqiqiy PT30 da ham shunday) — unit boshiga sutkada bir marta.
- `POST /mobile/hos-state` yuborilmaydi: web HOS ni serverda hisoblaydi; soxta ilova holati faqat drift alert beradi.
- Login 5/daq/IP: 30 haydovchini birinchi sozlash ~8 daqiqa oladi (keyingi ishga tushirishlarda login yo'q).
- `--violation-drivers` buzilishlari real vaqtda keladi (BREAK_30 ~8 soat, DRIVING_11 ~11 soat haydashdan keyin).

## Tozalash

```bash
npm run sim:drivers -- --cleanup
npm run virtual-eld:purge -- --before=<ertangi sana> --dry-run   # virtual telemetriya / raw event
```

`EldEvent` (RODS) yozuvlari hech qachon o'chirilmaydi (FMCSA). Testlar: `npm run sim:test`, tiplar: `npm run sim:typecheck`.
