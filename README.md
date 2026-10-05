# Secret Chat (chata)

Веб-мессенджер на Next.js 16 + PostgreSQL: общий публичный чат, приватные чаты и
группы с Matrix E2EE, вложения через Telegram, push-уведомления, админ-панель.
Интерфейс на русском, хранилище — PostgreSQL (Drizzle ORM).

## Почему приложение «запускается, но не работает»

Самые частые причины — все три дают одинаковую картину: `pm2 logs` показывает
`✓ Ready`, а в браузере пустой экран / «Ошибка сервера».

1. **Не применена схема БД.** В репозитории не было базовой миграции: таблицы
   `users`, `chats`, `chat_members`, `messages` создавались только вручную через
   `drizzle-kit push`. Если этого не сделать, каждый API-запрос падает с 500, а
   сервер при этом пишет `Ready`. Лечится командой `npm run db:setup`
   (теперь в репозитории есть базовая миграция `drizzle/0000_init.sql`).
2. **Нет `.env`.** Без `DATABASE_URL` приложение падает при импорте, без
   `JWT_SECRET` в production — при первом запросе к API авторизации.
   Скопируйте `.env.example` в `.env` и заполните значения.
3. **Нет production-сборки.** `next start` работает только после `npm run build`
   в том же каталоге (папка `.next`).

Проверить состояние одной командой:

```bash
curl -s http://127.0.0.1:8010/api/health | python3 -m json.tool
```

`{"ok":true,...}` — приложение готово. `"schema":"missing"` с полем
`missingTables` — нужно выполнить `npm run db:setup`.

## Быстрый старт (локально)

```bash
npm ci
cp .env.example .env         # заполните DATABASE_URL и JWT_SECRET
npm run db:setup             # создаёт/обновляет схему, идемпотентно
npm run dev                  # http://localhost:3000
```

Минимальный `.env`:

```
DATABASE_URL=postgresql://chata_app:ПАРОЛЬ@127.0.0.1:5432/chata_db
JWT_SECRET=<openssl rand -hex 32>
```

Первый зарегистрированный пользователь становится администратором
(или используйте `INITIAL_ADMIN_IDENTIFIER`, чтобы закрепить админа за
конкретным логином, и `npm run admin-bot` для Telegram-бота).

## Production-деплой

```bash
git pull
npm ci --omit=dev             # или npm ci, если нужны dev-инструменты
cp .env.example .env          # один раз, затем правьте значения
npm run db:setup              # обязательно после каждого релиза миграций
npm run build                 # обязательно после каждого релиза кода
npx pm2 start ecosystem.config.cjs --update-env
npx pm2 save
curl -fsS http://127.0.0.1:8010/api/health
```

`ecosystem.config.cjs` запускает `next start --hostname 127.0.0.1 --port 8010`
(правильно для nginx-прокси). **Не передавайте адрес и порт позиционными
аргументами** (`next start 127.0.0.1 8010`): Next воспримет первый аргумент как
путь к каталогу проекта и завершится с `Invalid project directory`.
Параметры передаются только флагами `--hostname` и `--port`.

Чтобы слушать все интерфейсы напрямую (не рекомендуется без firewall/TLS):
`CHATA_HOSTNAME=0.0.0.0 PORT=8010 npx pm2 start ecosystem.config.cjs --update-env`.
Используется именно `CHATA_HOSTNAME`, а не системная переменная `HOSTNAME`.

Пример nginx-прокси (TLS завершается на nginx):

```nginx
location / {
    proxy_pass http://127.0.0.1:8010;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 600s;
    client_max_body_size 50m;
}

# только если настроен Matrix/Synapse
location ^~ /_matrix/ {
    proxy_pass http://127.0.0.1:8008;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 600s;
    client_max_body_size 50m;
}
```

## Переменные окружения

| Переменная | Обязательно | Назначение |
|---|---|---|
| `DATABASE_URL` | да | Строка подключения PostgreSQL |
| `JWT_SECRET` | да (production) | Подпись cookie-сессий, `openssl rand -hex 32` |
| `INITIAL_ADMIN_IDENTIFIER` | нет | Логин, который повышается до админа при входе (пока в БД нет админов) |
| `UPLOAD_DIR` | нет | Каталог для аватарок (по умолчанию `./.data`, **не** `public/`) |
| `DATABASE_POOL_MAX` | нет | Размер пула соединений на процесс (по умолчанию 10) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | нет | Хранилище вложений |
| `BOT_OWNER_TELEGRAM_ID` | нет | Владелец Telegram-бота администратора |
| `MATRIX_PUBLIC_URL`, `MATRIX_INTERNAL_URL`, `MATRIX_SERVER_NAME`, `MATRIX_ADMIN_ACCESS_TOKEN` | нет | Matrix E2EE; задаются **только все вместе** |
| `MATRIX_REFRESH_TOKENS` | нет | `1` — запрашивать refresh-токены Matrix (тогда в Synapse нужно выставить длинный `refreshable_access_token_lifetime`); по умолчанию выключено, токены не истекают |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_EMAIL` | нет | Web Push; `VAPID_EMAIL` обязателен (`mailto:` или `https:`) |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | нет | Запасной публичный ключ для браузера; обычно не нужен — клиент получает ключ из `/api/push/subscribe` |

Web Push настраивается тремя переменными `VAPID_*`: **`VAPID_EMAIL` обязателен**
(формат `mailto:admin@example.com`; без него `isPushConfigured()` возвращает
`false`, и сервер отвечает `503` на подписку). На каждом устройстве нужно отдельно
открыть настройки профиля → «Уведомления» → включить push и разрешить уведомления в
браузере. Страница должна открываться по HTTPS: вне secure context `serviceWorker`
недоступен, и приложение честно пишет «Push требует HTTPS».

Push отправляется в общий чат сервером при сохранении сообщения, а в приватные
Matrix-чаты — через ретрансляцию `/api/messages/matrix-push` из браузера
отправителя (содержимое E2EE-сообщений в уведомления не попадает). Уведомление
намеренно не показывается, если нужный чат открыт в фокусе, и не отправляется
отправителю и в заглушённый чат. На iOS доставка работает только для
установлённого PWA («Добавить на главный экран»).

Диагностика: `/api/push/status` отдаёт `configured`, `subscriptionCount` и
`missingEnv`; кнопка «Отправить тестовое» в ответах `401/403` подсказывает
про VAPID-ключи, `404/410` — про устаревшую подписку, пустой список кодов — про
недоступность `fcm.googleapis.com`/`updates.push.services.mozilla.com` с VPS.
Ошибки доставки пишутся в `pm2 logs chata`. Отправка сообщения больше не ждёт
push-провайдера дольше 10 секунд.

Без Matrix приложение работает в режиме «только общий чат»: приватные чаты не
создаются, старые приватные чаты помечены как `legacy`, новые сообщения в них
не отправляются и не сохраняются в открытом виде.

## Проверки

```bash
npm run typecheck   # TypeScript
npm run lint        # ESLint
npm run db:check    # схема БД на месте
npm run verify      # всё перечисленное
npm run build       # production-сборка
npm run smoke       # проверка запущенного сервера (read-only)
SMOKE_ALLOW_WRITES=1 npm run smoke   # + регистрация, сообщения, аватарка
```

Полный деплой одной командой: `npm run deploy` (зависимости → схема → сборка →
перезапуск pm2 → health check).

## Диагностика

| Сообщение в `pm2 logs` | Причина и исправление |
|---|---|
| `Invalid project directory provided, no such directory: .../127.0.0.1` и в `pm2-out.log` строка `next start 127.0.0.1 8010` | Неверные позиционные аргументы; остановите старый процесс (`pm2 delete chata`) и запустите `pm2 start ecosystem.config.cjs --update-env`. Без ecosystem-конфига: `npm run start -- --hostname 127.0.0.1 --port 8010`. |

| Симптом | Причина и решение |
|---|---|
| `pm2` пишет `Ready`, но в браузере ничего не работает | Не применена схема: `npm run db:setup`, проверить `/api/health` |
| `/api/health` → `"database":"unavailable"` | Неверный `DATABASE_URL` или PostgreSQL не запущен |
| `/api/health` → `"schema":"missing"` | `npm run db:setup` |
| Вход выдаёт «Ошибка сервера» | Не задан `JWT_SECRET` (production), смотреть `pm2 logs chata` |
| Аватарка загружается, но картинка не открывается (404) | Обновление до версии, где аватары отдаёт `/avatars/<file>` из `UPLOAD_DIR`; старые сборки хранили их в `public/`, который Next.js кэширует на старте процесса |
| «Matrix недоступен. Приватные сообщения не отправляются» | `MATRIX_*` не заданы или Synapse недоступен — общий чат продолжает работать |
| «Push-уведомления не настроены на сервере» | Не заданы VAPID-ключи (см. `.env.example`) |
| Чаты не создаются | Приватные чаты требуют Matrix-сессии; проверьте `matrix` в `/api/health` |
| Matrix «отваливается» при каждом обновлении страницы | Проверьте `select id, username, matrix_reset_required from users;` (флаг `true` = устройство отозвано, нужно один раз ввести пароль в «Восстановить Matrix-сессию») и `refreshable_access_token_lifetime` в `homeserver.yaml`; в консоли браузера признак — `Token no longer valid - assuming logout`. Приложение больше не запрашивает refresh-токены, поэтому токены Synapse не истекают, если `MATRIX_REFRESH_TOKENS` не включён |
| Уведомления не приходят, хотя подписка есть | `curl -s -X POST .../api/push/test`; `401/403` — VAPID-ключи не пара, `404/410` — пересоздать подписку, пустые коды — VPS не видит push-сервис; `missingEnv` в `/api/push/status` = не хватает переменных в `.env` |
| Список чатов пуст, хотя «Общий чат» был | Обновление восстановит членство автоматически при открытии чатов (`ensureGeneralChatMembership`) |

Полезные команды:

```bash
npx pm2 logs chata --lines 200 --nostream
curl -s http://127.0.0.1:8010/api/health
psql "$DATABASE_URL" -c '\dt'          # список таблиц
```

## Структура

```
src/app/api/**        HTTP API (auth, chats, messages, files, profile, admin, push)
src/app/avatars/**    отдача загруженных аватарок (runtime-файлы вне public/)
src/components/**     интерфейс мессенджера и админ-панели
src/lib/matrix/**     Matrix/Synapse: логин, E2EE, восстановление ключей
src/db/schema.ts      схема Drizzle (источник истины)
drizzle/*.sql         идемпотентные миграции; применяются npm run db:setup
scripts/db-setup.mjs  применение миграций без drizzle-kit (работает в prod)
scripts/admin-bot.ts  Telegram-бот для bootstrap/ротации админа
docs/                 отчёты аудита и описание E2EE
```
