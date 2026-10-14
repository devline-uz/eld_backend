# Mobil dasturchi uchun savollar — bitta qurilma qoidasi, PT30 va offline rejim (2026-10-14)

Backend tomondan tayyorlandi. Har bir savolga raqami bilan qisqa javob yozing. Sinov o'tkazilgan bo'lsa, natijasini ham qo'shing.

## Qaror: bir vaqtda faqat bitta qurilma

Owner qarori (2026-10-14): **bitta haydovchi bir vaqtning o'zida faqat bitta qurilmada tizimda bo'ladi.** Bu Turck planshet yoki telefon bo'lishi mumkin, lekin ikkalasi birga emas.

- **Co-driver** bundan mustasno emas, lekin u ziddiyat ham emas: ikki haydovchi bitta planshetda switch orqali ishlaydi. Qoida har bir haydovchiga alohida qo'llanadi.
- **Nega:** zamonaviy ELD ilovalari (J.J. Keller, GPS Insight, BigRoad, Samsara va boshqalar) bir vaqtda bir nechta qurilmani taqiqlaydi.
  - Ikki qurilma bitta ELD ga ulansa, ma'lumot yo'qoladi.
  - BigRoad tajribasi: ELD ikkala qurilmaga ulanishga urinadi va hech biriga to'g'ri ulana olmaydi.
- **Holat:** backend kodi hali yozilmagan. Quyidagi savollarga javob olgandan keyin yoziladi.

### Backend taklifi (muhokama uchun qoralama)

1. **Yangi kirish yutadi.** Haydovchi B qurilmaga kirsa, server uning boshqa barcha sessiyalarini (A qurilma) bekor qiladi.
   - Muqobil variant: B ni A chiqmaguncha bloklash. Biz buni tavsiya qilmaymiz: telefon yo'qolsa yoki buzilsa, haydovchi kira olmaydi va admin aralashuvi kerak bo'ladi.
2. **B da ogohlantirish.** Server B ga "Siz boshqa qurilmada kirgansiz (Turck tablet, 12 daqiqa oldin)" degan ma'lumotni qaytaradi. Haydovchi tasdiqlagandan keyingina A chiqariladi.
3. **A ga xabar.** A darhol socket orqali `session.replaced` hodisasini oladi. Socket bo'lmasa, keyingi API so'rovida 401 `SESSION_REPLACED` qaytadi. Xato kodi `TOKEN_INVALID` dan alohida bo'ladi, ilova sababni ko'rsata olishi uchun.
4. **§395 yozuvi.** A uchun server majburiy logout yozuvini yozadi (§395 4.5.1.5).
5. **Qurilma identifikatori.** Login'da `deviceId`, `deviceLabel`, `platform` va `appVersion` qabul qilinadi.
   - Hozir haydovchi login bu maydonlarni qabul qilmaydi. Qo'shiladi.
   - Bir xil `deviceId` bilan qayta kirish "boshqa qurilma" hisoblanmaydi.

Ochiq masala: **A qurilmadagi yuborilmagan yozuvlar** (pastdagi C bo'lim).

---

## 1-qism. Bitta qurilma qoidasi

### A. Qoida va foydalanuvchi tajribasi
1. Yuqoridagi "yangi kirish yutadi + B da tasdiqlash" varianti sizga to'g'ri keladimi? Yoki "A chiqmaguncha B ga kirib bo'lmaydi" varianti kerakmi? Sababini yozing.
2. B dagi ogohlantirish oynasida nima ko'rsatilsin? Masalan: qurilma nomi, oxirgi faollik vaqti, A da yuborilmagan yozuvlar soni.
3. A chiqarilganda haydovchiga qanday xabar ko'rsatiladi? Matnni taklif qiling. Masalan: "You were signed out because you signed in on another device".
4. Haydash paytida (motion lock yoqilgan) A dan chiqarish xavfsizmi? Server bu holatda B ni rad etishi kerakmi yoki A to'xtaguncha kutishi kerakmi?

### B. Qurilma identifikatori
5. Ilova barqaror `deviceId` yarata oladimi? Masalan, secure storage'da UUID. Ilova qayta o'rnatilsa yoki ma'lumotlari tozalansa, bu ID o'zgaradimi?
6. `deviceLabel` uchun nima yuborasiz? Masalan, "Turck T-xxx" yoki telefon modeli. Planshet va telefonni qanday farqlaysiz?
7. Login'da `deviceId`, `deviceLabel`, `platform`, `appVersion` maydonlarini yuborishga tayyormisiz? Boshqa kerakli maydon bormi?

### C. Chiqarilgan qurilmadagi (A) yuborilmagan yozuvlar
8. A chiqarilgan paytda navbatda yuborilmagan yozuvlar (ELD hodisalari, duty status, DVIR, sertifikat) bo'lsa, ular bilan nima qilish kerak? Quyidagi variantlardan qaysi biri ma'qul?
   - (a) A qisqa muddatli, faqat yozuv yuborishga ruxsat beradigan "drain" huquqi bilan navbatni yuborib tugatadi.
   - (b) Yozuvlar A da qoladi. Haydovchi A ga qayta kirganda yuboriladi.
   - (c) B ga kirishdan oldin A dagi navbat bo'shatilishi shart. Buning uchun server A dan yuborilmagan yozuvlar sonini bilishi kerak.
9. Ilova serverga davriy ravishda "navbatda N ta yozuv bor" degan ma'lumot yubora oladimi? Masalan, sync yoki hos-state bilan. Shunda B dagi ogohlantirishda buni ko'rsatish mumkin bo'ladi.
10. A chiqarilganda lokal kesh (haydovchi ma'lumotlari, jurnal) o'chiriladimi? Yuborilmagan yozuvlar ham o'chib ketmasligi kafolatlanganmi?

### D. Chiqarilgan qurilma offline bo'lsa
11. A offline bo'lsa, u chiqarilganini bilmaydi va PT30 dan yozishda davom etadi. Internet qaytganda A ning yozuvlari bilan B ning yozuvlari o'rtasidagi ziddiyat qanday hal qilinadi?
12. A qayta onlayn bo'lganda 401 `SESSION_REPLACED` oladi. Shu paytgacha yig'ilgan yozuvlarni yo'qotmaslik uchun ilova nima qiladi?
13. Server A dan kelgan, lekin A chiqarilgan vaqtdan keyingi yozuvlarni qabul qilsinmi, rad etsinmi yoki "ko'rib chiqish kerak" deb belgilasinmi?

### E. PT30 va qurilma almashinuvi
14. A ga `session.replaced` kelganda, ilova PT30 Bluetooth ulanishini darhol uzadimi va foreground service'ni to'xtatadimi? Shunda B ulana oladi.
15. A ning PT30 dagi ACK qilinmagan yozuvlari B ulanganda B ga o'tadimi? Bu dublikatga olib kelmaydimi? Dublikat `uuid` yoki `(device, occurredAt, seq)` bo'yicha serverda ushlanadi.
16. Logout'da ham PT30 ulanishi uziladimi?
17. PT30 ga bir vaqtda faqat bitta qurilma ulana oladimi? Ulangan PT30 ga boshqa qurilma ulanmoqchi bo'lsa nima bo'ladi?

### F. Co-driver va umumiy planshet
18. Ikki haydovchi bitta planshetda switch orqali ishlaydi. Co-driver o'z telefonidan kirsa, uning planshetdagi sessiyasi bekor bo'ladi va jamoa buziladi. Bu holatda nima bo'lishi kerak?
    - Server telefondagi kirishni rad etsinmi?
    - Yoki planshetdagi co-driver juftligini avtomatik tugatsinmi?
19. Switch qilinganda planshetda ikkala haydovchining sessiyasi bormi yoki faqat rulda o'tirganniki? Bugungi o'zgarishdan keyin server rulni bo'shatgan haydovchining sessiyasini bekor qiladi (N2). Bu bitta qurilma qoidasi bilan qanday mos keladi?
20. Mashinada qoladigan umumiy planshetda haydovchi chiqmasdan ketib qolsa va boshqa qurilmadan kirsa, planshetdagi sessiya bekor bo'lgach planshet qanday holatga o'tadi? Login ekraniga o'tadimi? Kesh tozalanadimi?

---

## 2-qism. PT30 Bluetooth ulanishi

### G. Ulanish barqarorligi
21. Uzilgandan keyin avtomatik qayta ulanish bormi? Qancha vaqtda ulanadi?
22. Ilova fonda bo'lsa, ekran o'chsa yoki Android battery optimization yoqilgan bo'lsa, ulanish saqlanadimi (foreground service)? Turck planshetida sinalganmi?
23. Haydash paytida Bluetooth uzilsa, necha daqiqadan keyin diagnostika yoki malfunction yoziladi va haydovchiga qanday ko'rsatiladi?
24. Uzilish paytidagi yo'l qayta ulanganda PT30 xotirasidan olinadimi yoki unidentified driving bo'lib qoladimi?

### H. Noto'g'ri qurilma yoki mashina
25. Depoda yaqin turgan boshqa mashinaning PT30 siga ulanib qolishdan himoya bormi? PT30 dan kelgan VIN mashinaning VIN'i bilan solishtiriladimi? MAC mos kelmasa banner chiqadimi (MD-168)?
26. Admin mashinani boshqa haydovchiga o'tkazsa (`vehicle.unassigned`), ilova eski PT30 dan uziladimi? Yangi mashina biriktirilsa (`vehicle.assigned`), yangi PT30 ga o'zi ulanadimi?
27. Virtual ELD va real PT30 bir akkauntda aralashib qolmaydimi?

---

## 3-qism. Offline rejim — internet yo'q paytda saqlab turish va keyin yuborish

TZ bo'yicha zanjir: PT30 xotirasi (30 kun) → ilovaning lokal Drift bazasi → server.

### I. PT30 → ilova (Bluetooth bor, internet yo'q)
28. Internet yo'q paytda PT30 dan kelgan hodisalar (duty, engine on/off, intermediate log, login/logout, malfunction) va telemetriya lokal bazaga yoziladimi? Qaysi jadvallarga?
29. Ilova PT30 ga ACK'ni qachon yuboradi: lokal bazaga yozilgandan keyinmi yoki serverga yuborilgandan keyinmi? ACK berilgan yozuv PT30 dan o'chadimi?
30. Ilova yopilsa, telefon o'chib qolsa yoki batareya tugasa, lokal bazaga yozilmagan yozuvlar yo'qoladimi? PT30 ularni keyin qayta beradimi?
31. Telemetriya offline'da qanday saqlanadi? Downsampling bormi? 3 kunlik chegara ishlaydimi?

### J. Bluetooth ham, internet ham yo'q (yoki ilova ochilmagan)
32. Ilova PT30 ga ulanmagan paytda mashina yursa, PT30 o'z xotirasiga yozadimi? Qayta ulanganda ilova bu "stored events"ni o'qib oladimi? Bu real PT30 da sinalganmi?
33. Bu hodisalar haydovchiga qanday ko'rsatiladi: unidentified driving bo'lib keladimi yoki o'z-o'zidan haydovchiga yoziladimi?
34. PT30 xotirasi to'lib qolsa nima bo'ladi?

### K. Internet qaytganda
35. Navbat avtomatik yuboriladimi? Qachon: tarmoq paydo bo'lishi bilanoq, ilova fondan qaytganda, backoff tugaganda? Ilova fonda yoki ekran o'chgan bo'lsa ham yuboriladimi?
36. Yozuvlar tartib bilan (`occurredAt` va sequence ID bo'yicha) yuboriladimi? 500 tadan ko'p bo'lsa bo'laklarga bo'linadimi?
37. Yuborish o'rtasida internet uzilsa, qayta yuborganda dublikat bo'lmaydimi? Har bir yozuvga yuborishdan **oldin** doimiy `uuid`/`clientId` beriladimi?
38. Server 4xx bilan rad etgan yozuv bilan nima qilinadi? Navbatda qotib qolmaydimi, haydovchiga ko'rsatiladimi?
39. Server 5xx qaytarsa yoki timeout bo'lsa, retry cheksizmi? Backoff ishlaydimi?

### L. Offline paytdagi auth
40. Offline paytda access token muddati tugasa, ilova ishlashda davom etadimi? Internet qaytganda avval refresh qilinib, keyin navbat yuboriladimi? Refresh xato bersa (`REFRESH_TOKEN_REUSED`, `TOKEN_INVALID`, `SESSION_REPLACED`), navbatdagi yozuvlar nima bo'ladi?
41. Navbatda yozuv turgan paytda co-driver switch bo'lsa, yozuvlar to'g'ri haydovchi nomidan yuboriladimi?

### M. Vaqt va ziddiyatlar
42. Telefon soati noto'g'ri bo'lsa yoki orqaga ketsa nima bo'ladi? Vaqt qaysi manbadan olinadi: PT30, GPS yoki telefon?
43. Offline paytda admin vebdan log tahrirlash so'rovi yuborsa yoki mashinani boshqa haydovchiga o'tkazsa, internet qaytganda ziddiyat qanday hal qilinadi?
44. Offline'da hisoblangan HOS soatlari (lokal dvigatel) bilan server hisobi farq qilsa nima bo'ladi?

### N. Offline paytda haydovchi harakatlari
45. Offline'da quyidagilar ishlaydimi va navbatga tushadimi: duty status, PC/YM, sertifikatlash, DVIR (rasmlari bilan), xabar yozish?
46. DVIR rasmlari internet qaytganda alohida yuklanadimi? Katta rasmlar navbatni to'xtatib qo'ymaydimi?
47. Offline'da DOT inspeksiya rejimi ochiladimi? 8 kunlik jurnal va output fayl (CSV) ilovaning o'zida yasaladimi?

### O. Haydovchiga ko'rsatish
48. "No connection — records are stored on the device" banneri va "N records not sent" hisobchisi ishlaydimi?
49. Navbat 30 kundan oshsa yoki 200 MB ga yetsa, ogohlantirish chiqadimi?
50. Uzoq vaqt offline bo'lsa (masalan 24 soatdan ko'p), §395.34 bo'yicha data transfer malfunction yoziladimi?

---

## 4-qism. Sinov holati

51. Real PT30 bilan qaysi qurilmada sinaldi: Turck planshetidami, telefondami? Android versiyasi qanday?
52. Android 12+ dagi `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT` va joylashuv ruxsatlari ikkala form-factor'da sinalganmi?
53. Quyidagi holatlar real PT30 bilan sinalganmi? Har birida yozuvlar soni PT30, lokal baza va server o'rtasida mos keldimi?
    - samolyot rejimida 1 soat haydash, keyin internetni yoqish;
    - Bluetooth'ni haydash o'rtasida o'chirib yoqish;
    - ilovani majburan yopish;
    - telefonni qayta yoqish.
54. Bitta qurilma qoidasi tayyor bo'lgach quyidagi holatlarni birga sinaymiz. Qo'shadigan holatingiz bormi?
    - planshetda kirilgan, telefondan kirish;
    - A offline paytda B dan kirish;
    - co-driver o'z telefonidan kirishi.

---

## Manbalar

- [FMCSA ELD user guide — multiple devices, upload queue](https://eld.fmcsa.dot.gov/File/Index/6f476fb3-2058-7b4f-e053-0100007f6f01)
- [FMCSA ELD user guide 2](https://eld.fmcsa.dot.gov/File/Index/7e241def-e12e-1618-e053-0100007f0aca)
- [FMCSA ELD user guide 3](https://eld.fmcsa.dot.gov/File/Index/5f4f3a36-e2e8-545c-e063-0100007fbbe6)
- [J.J. Keller — Connecting to the ELD (Android)](https://support.jjkeller.com/Encompass_Suite/Encompass_ELD/Driver_Guides/Connecting_to_the_ELD_Android)
- [GPS Insight — BYOD device connection](https://help.gpsinsight.com/docs/byod-ios-device-connection/)
- [Powerfleet — ELD troubleshooting](https://kb.powerfleet.com/hc/en-us/articles/29266721524882)
- [EROAD — 5 common ELD issues](https://www.eroad.com/hubfs/eroad/documents/ERD_0319_5CommonELDIssues_0.7.pdf)
- [Samsara — How the ELD works](https://Samsara.com/guides/how-the-eld-works)
- [49 CFR §395.34 (Cornell LII)](https://www.law.cornell.edu/cfr/text/49/395.34)
- [J.J. Keller — §395.34 malfunctions and data diagnostic events](https://jjkellercompliancenetwork.com/regsense/39534-eld-malfunctions-and-data-diagnostic-events)
