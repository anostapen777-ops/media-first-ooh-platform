# Media First OOH — інтеграція Cloudflare ↔ Google Apps Script

Цей пакет додає захищений HMAC Bridge між Cloudflare Worker і Google Apps Script. Google Sheets, Drive та MailApp виконуються від імені власника Apps Script; Cloudflare Billing для цих стандартних Apps Script-сервісів не активується.

## Що змінюється

- `POST /api/bridge/apps-script` — єдина точка підписаного обміну.
- D1 `bridge_nonces` — захист від повторного відтворення підписаних запитів.
- Google Sheets sync: preview → staged import → atomic replace.
- Черга фото/схем: Apps Script бере завдання з D1, копіює в приватний Drive, повертає статус.
- Приватний перегляд копій Drive через авторизований Worker endpoint.
- Надсилання XLSX та тестового листа через Apps Script `MailApp`.
- Ліміт одного sync збільшено до 5 000 записів (поточна таблиця містить 996).
- Cloudflare Cron вимкнено: регулярні процеси запускають Apps Script triggers, щоб не використовувати паралельну Google OAuth-інтеграцію у Worker.

## Встановлення в локальний Cloudflare-проєкт

1. Розпакуй ZIP у Downloads.
2. У Terminal перейди в папку `Media_First_OOH_Cloudflare`.
3. Зупини `npm run dev` через `Control + C`, якщо він запущений.
4. Запусти скрипт оновлення, підставивши фактичну назву папки з Downloads:

```bash
bash "$HOME/Downloads/Media_First_OOH_Cloudflare_Bridge_Integration_Update/apply-update.sh"
```

Скрипт зберігає резервну копію, реальний D1 ID, `wrangler.jsonc` bindings і `.dev.vars`. Він не запускає seed і не змінює D1 дані.

5. Застосуй нову міграцію локально і віддалено:

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

Очікується застосування `0004_apps_script_bridge.sql`. Якщо Wrangler скаже `No migrations to apply`, це також нормально — означає, що міграція вже є.

6. Перевір пакет:

```bash
npm test
```

7. Лише після успішних тестів розгорни Worker:

```bash
npm run deploy
```

## Наступний порядок підключення секретів

Після першого успішного deploy ми окремо налаштуємо:

- Apps Script Script Property `WORKER_BASE_URL` — фактичний `https://<worker>.<subdomain>.workers.dev`.
- Apps Script Script Property `BRIDGE_SECRET` — секрет, який створює `generateBridgeSecret()` у Apps Script.
- Worker Secret `APPS_SCRIPT_BRIDGE_SECRET` — той самий секрет.
- Apps Script Web App URL — після створення deployment Web App.
- Worker Secret `APPS_SCRIPT_URL` — URL Apps Script Web App, що закінчується `/exec`.

Секрет не надсилати в чат, не вставляти в HTML і не зберігати в `wrangler.jsonc`. Значення вводити безпосередньо в Apps Script Script Properties та Wrangler prompts.

## Важливі параметри Apps Script Web App

- Execute as: **Me** (власник Bridge-проєкту).
- Who has access: **Anyone** (доступ до дій захищений HMAC; `doGet` показує лише health/version, `doPost` відхиляє запити без підпису).
- Не активувати Google Cloud Billing.
- Після зміни `Code.gs` створити нову версію deployment Web App; Apps Script тригери встановлюються окремо.

## Безпечний порядок живого тесту

1. Перевірити `testBridgeConnection()` з редактора Apps Script.
2. Перевірити Cloudflare Admin → Google Bridge status.
3. Запустити Google Sheets **preview**, звірити 996 записів / чотири шари, і тільки тоді застосувати inventory.
4. Запустити Drive library start, потім обробити невелику тестову чергу (кілька фото/схем) і перевірити картки.
5. Перевірити тестовий лист.
6. Лише після успіху встановити `installBridgeTriggers()` (Sheets кожні 15 хв; черга фото кожні 5 хв).

Не запускай `db:seed:remote` повторно. Google Sheet стає джерелом правди після підтвердженого першого sync.

## Примітки щодо квот та фото

- Apps Script безкоштовний у межах квот Google-акаунта; для звичайного Gmail типові ліміти тригерного часу та адресатів обмежені. Планувальник не гарантує точну секунду запуску.
- За запуск обробляються максимум 2 медіафайли; черга поступово опрацьовується тригером кожні 5 хвилин.
- Джерела із CAPTCHA, логіном, JS-only переглядом або недоступним файлом переходять у `needs_attention`; система не обходить захист партнерів.
- Максимальний розмір одного фото/схеми у поточній версії — 8 MB.
- Якщо інвентар зросте понад 5 000 записів або payload перевищить ліміт, sync зупиниться без заміни чинного інвентаря; тоді потрібно буде додати chunked sync.
