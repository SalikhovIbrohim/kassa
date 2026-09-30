# Касса

Учёт наличных (кассовая книга) для небольшой грузоперевозочной фирмы: кассиры по сменам записывают приход и расход, владелец только смотрит. Сайт (PWA) для iPhone и ноутбука, позже Telegram. Подробности в спеке: issue #1.

## Состав

- `server/`: сервер на Node.js и TypeScript (Fastify), база PostgreSQL. Отдаёт API (`/api/...`) и собранное веб-приложение.
- `web/`: PWA-оболочка на React и TypeScript (Vite).

## Что нужно

- Node.js 22 и npm.
- PostgreSQL 16 (локально или в контейнере).

## Запуск для разработки

```sh
npm install
cp .env.example .env        # затем поправьте DATABASE_URL под свою базу
```

Сервер читает настройки из переменных окружения (см. `.env.example`). Например:

```sh
DATABASE_URL=postgres://kassa:kassa@localhost:5432/kassa npm run dev:server   # API на :3000
npm run dev:web                                                               # веб на :5173, /api идёт на :3000
```

Проверка работоспособности: `GET /api/health` отвечает `200` и `{"status":"ok","database":"up"}`, а если база недоступна, `503`.

## Пользователи и вход

Входят логином и паролем. Пользователей заводит разработчик вручную, интерфейса для этого нет. Роли: `cashier` (кассир) и `viewer` (смотрящий, только читает).

```sh
npm run build                                   # один раз, команды берутся из server/dist
export DATABASE_URL=postgres://...              # в PowerShell: $env:DATABASE_URL = "postgres://..."

npm run admin -w server -- create-user --login ivan --role cashier --name "Иван Петров"
npm run admin -w server -- create-user --login owner --role viewer
npm run admin -w server -- list-users
npm run admin -w server -- revoke-user --login ivan      # закрывает доступ и все сессии
npm run admin -w server -- restore-user --login ivan     # возвращает доступ, входить нужно заново
npm run admin -w server -- reset-password --login ivan   # новый пароль, все сессии закрываются
npm run admin -w server -- set-opening-balance --currency RUB --amount 12345.67   # начальный остаток
npm run admin -w server -- balances                      # остатки по валютам: начальный + приходы
```

Пароль не передаётся в командной строке: его спросят в терминале (символы не показываются) или возьмут из переменной `KASSA_PASSWORD`. Минимум 8 символов. Логин не зависит от регистра букв. На разработке без сборки можно `npm run admin:dev -w server -- ...`.

Как это устроено:

- `POST /api/login` (`login`, `password`) выдаёт сессию в cookie `kassa_session` (HttpOnly, SameSite=Lax, `Secure` на HTTPS). `GET /api/me` говорит, кто вошёл, или отвечает `401`. `POST /api/logout` закрывает сессию этого устройства.
- Сессия живёт 90 дней без использования и продлевается, пока человек пользуется приложением (`SESSION_DAYS`). Пароль нужен при первом входе и по истечении срока.
- Пароли хранятся только хешем (scrypt), в базе лежит хеш токена сессии, а не сам токен.
- Миграции базы (`server/migrations/*.sql`) применяются при старте сервера и перед командами администратора.
- Для кода следующих тикетов: хуки `app.authenticate` (только вошедшие, кладёт пользователя в `request.user`) и `app.requireRole("cashier")` ставятся в `onRequest` маршрута: права проверяются раньше, чем тело запроса.

## Приход и остатки

Деньги хранятся целым числом минимальных единиц (копейки, центы), валюты RUB и USD ведутся отдельно, без пересчёта.

- `POST /api/operations` (только кассир): `{ id, type: "income", amountMinor, currency, clientCode, comment? }`. `id` (uuid) создаёт клиент: повторная отправка той же операции отвечает `200` и не создаёт дубль, тот же `id` с другим содержимым или от другого кассира даёт `409`. Ответ: сама операция и текущие остатки.
- `GET /api/balances`: остаток по каждой валюте (начальный остаток + приходы), доступен любому вошедшему.
- `GET /api/client-codes?prefix=`: ранее вводившиеся коды клиентов, последние первыми, без учёта регистра, не больше восьми.
- `GET /api/operations/defaults`: валюта, которой этот кассир пользовался последней (по умолчанию RUB).

## Сборка и запуск как в проде

```sh
npm run build
DATABASE_URL=... npm start   # сервер отдаёт и API, и web/dist на одном адресе
```

На HTTPS задайте `NODE_ENV=production` (или `COOKIE_SECURE=true`), иначе cookie сессии не получит флаг `Secure`. По умолчанию сервер слушает только `127.0.0.1` (порт `3000`). Внутри контейнера или за прокси на другой машине задайте `HOST=0.0.0.0`, порт меняется через `PORT`. Маршруты приложения не должны содержать точку: запрос пути с расширением считается запросом файла и при его отсутствии получает честный `404`, а не оболочку.

## Тесты

Тесты ходят только в публичный HTTP API сервера и работают с настоящей PostgreSQL: подмен базы нет. Для каждого теста создаётся и потом удаляется отдельная база.

1. Нужна роль PostgreSQL с правом `CREATEDB`. Адрес сервера задаётся переменной `TEST_DATABASE_URL`, по умолчанию `postgres://kassa_test:kassa_test@localhost:5432/postgres`. Создать такую роль можно так:

   ```sh
   psql -U postgres -c "CREATE ROLE kassa_test LOGIN CREATEDB PASSWORD 'kassa_test'"
   ```

2. Запуск:

   ```sh
   npm test               # все тесты
   npm run typecheck      # проверка типов сервера и веба
   ```

Если прогон оборвался посередине, могли остаться базы `kassa_test_...`: их можно удалить командой `DROP DATABASE`.

## CI

GitHub Actions (`.github/workflows/ci.yml`) на каждый push в любую ветку: проверка типов, тесты на PostgreSQL 16, сборка.
