# Як встановити оновлення на ваш Mac

Цей update patch додає універсальні шари, стабільні ID, безпечну транзакційну заміну інвентаря, новий reader Google Sheets, preview зменшення, Gmail test, auto-refresh карти й migration 0002.

**Він навмисно не змінює** ваш `wrangler.jsonc` з реальним D1 ID, `.dev.vars` із локальними секретами, початкові дані у `data/` або вже створену D1-базу.

## 1. Розпакувати ZIP

Завантаж ZIP, двічі натисни на нього в Downloads. Усередині буде папка `Media_First_OOH_Cloudflare_Update`.

## 2. Зупинити локальний сервер

У Terminal, де зараз запущено `npm run dev`, натисни `Control + C`.

## 3. Застосувати оновлення

Повернись у Terminal до кореневої папки `Media_First_OOH_Cloudflare` — тієї, де лежать `package.json` і `wrangler.jsonc`.

Найпростіше: введи `bash ` (з пробілом після bash), перетягни файл `apply-update.sh` з розпакованої папки в Terminal і натисни Enter.

Скрипт зробить резервну копію старих `src/worker.js` та `public/index.html`, потім скопіює оновлені файли. `wrangler.jsonc` і `.dev.vars` залишаться без змін.

## 4. Застосувати нову міграцію до обох баз

В тій самій папці виконай по черзі:

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

Якщо Wrangler попросить підтвердження для remote migration, погодься. Міграція 0002 додає колонку stable_key та staging/sync таблиці. Вона **не видаляє 336 поточних записів**. Не запускай `db:seed:remote` повторно.

## 5. Перевірити пакет

```bash
npm run test
```

Очікувано: усі повідомлення `PASS` і `All offline checks passed`.

## 6. Знову відкрити локальний застосунок

```bash
npm run dev
```

Відкрий `http://localhost:8787` і увійди своїм локальним Admin. Переконайся, що карта показує 336 об'єктів. Збережи скриншот, якщо побачиш помилку.

## 7. Далі — Google OAuth

Після застосування patch відкрий `GOOGLE_SHEETS_SETUP_UA.md`. Для справжнього тесту Google потрібні Google OAuth Client ID/Secret і ID основної Google-таблиці. Вводити секрети потрібно локально у `.dev.vars` або через Cloudflare Worker Secrets, не у чат.
