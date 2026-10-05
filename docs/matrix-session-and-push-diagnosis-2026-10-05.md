# Диагностика: Matrix-сессия «отваливается» при обновлении страницы и не работают push

**Дата:** 5 октября 2026 г.
**Ветка:** `arena/01a10be0-cha` (коммит `95e63d8`)
**Метод:** чтение кода (`src/lib/matrix/**`, `src/components/ChatApp.tsx`, `src/app/page.tsx`,
`src/lib/push*.ts`, `public/sw.js`, API-роуты) + сверка с `matrix-js-sdk@43.0.0` и
документацией Synapse. Логику никуда не переносил, это отчёт о причинах.

---

## TL;DR

| # | Симптом | Причина | Где |
|---|---|---|---|
| 1 | Matrix «ожидает пароль» почти при каждом F5 | Приложение логинится с `refresh_token: true`, а Synapse по умолчанию выдаёт такой access token **на 5 минут**. На перегрузке токен уже мёртв | `src/lib/matrix/server.ts:533` |
| 2 | Автовосстановление не срабатывает / гоняет клиент по кругу | `createClient()` вызывается **без** `refreshToken`/`onTokenRefresh`, поэтому SDK не обновляет токен сам, а при `M_UNKNOWN_TOKEN` делает `sync.stop()`; приложение обновляет токен вручную и из-за этого пересоздаёт клиент (в `sessionKey` входит `accessToken`) | `src/lib/matrix/client.ts:399-405`, `133-135`, `src/components/ChatApp.tsx:289-320` |
| 3 | Сессия живёт только в одной вкладке | Matrix-сессия хранится в `sessionStorage` (per-tab), а не в `localStorage`. Новая вкладка, PWA-окно, перезапуск браузера, `clients.openWindow()` из push → «В этой вкладке нет Matrix-сессии». Пароль для восстановления хранить негде | `src/app/page.tsx:44-64`, `src/components/AuthScreen.tsx:136`, `src/components/ChatApp.tsx:196` |
| 4 | После одного сбоя — разлогин **на каждом** обновлении навсегда | Липкий флаг `users.matrix_reset_required`: `page.tsx` при нём стирает сессию и показывает экран входа. Снимается только в ветке входа, а любая ошибка в этой ветке проглатывается | `src/app/page.tsx:36-39`, `src/components/AuthScreen.tsx:65-101` |
| 5 | Самоубийство E2EE-идентичности из-за безобидной ошибки | `handleFatalMatrixReset` срабатывает на широченную регулярку (в т.ч. `decryption`, `invalid session`), отзывает все устройства в Synapse и удаляет локальные ключи — и ставит флаг из п.4 | `src/components/ChatApp.tsx:347-356, 385-392` |
| 6 | Пуш нет вообще (и «не настраивается») | `isPushConfigured()` требует все три `VAPID_*` (включая `VAPID_EMAIL`), а `web-push` бросает исключение, если subject не `mailto:`/`https:` — отправка тогда тихо падает | `src/lib/push.ts:6-21` |
| 7 | Кнопка «Включить уведомления» жмётся без ответа | `Notification.requestPermission()` вызывается **после** `fetch` + ожидания Service Worker (до 10 с) — трансиентная user activation в Chrome к этому моменту истекла, промпт не показывается | `src/lib/push-client.ts:76-95` |
| 8 | Пуш не приходит в приватные чаты | Push для E2EE ретранслирует **браузер отправителя** через `/api/messages/matrix-push`, который требует живой Matrix access token (см. п.1) и точного совпадения `chats.matrix_room_id`; ошибка — только `console.warn` | `src/lib/matrix/client.ts:1258-1284`, `src/app/api/messages/matrix-push/route.ts:42` |
| 9 | Пуш «пропал» при тесте с открытым чатом | `sw.js` подавляет уведомление, если в любой видимой вкладке в URL есть этот `chatId` (а `handleSelectChat` пишет `?chatId=` через `replaceState` в каждой вкладке) | `public/sw.js:25-34`, `src/components/ChatApp.tsx:443-449` |

Пункты 1–2 и 8 связаны: **одна и та же короткая жизнь токена ломает и Matrix, и пуш в
приватных чатах.**

---

## 1. Matrix: почему сессия падает именно на обновлении страницы

### 1.1 Токен живёт 5 минут, а приложение этого не учитывает

`createMatrixSession()` (`src/lib/matrix/server.ts:508-536`) шлёт в Synapse:

```jsonc
{ "type": "m.login.password", ..., "refresh_token": true }
```

Согласно документации Synapse, `refreshable_access_token_lifetime` (время жизни access
токена для клиентов, которые поддерживают refresh tokens) **по умолчанию = 5m**;
`nonrefreshable_access_token_lifetime` — по умолчанию infinity
([synapse docs](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html)).
То есть, включая refresh tokens, приложение само выбрало 5-минутные токены.

Дальше:

* `expiresAt` вычисляется на сервере и кладётся в сессию (`server.ts:569-571`), но
  **нигде не проверяется**: `src/app/page.tsx:43-64` при загрузке валидирует только форму
  объекта (`typeof`), срок годности не смотрит.
* Единственный путь обновления токена — реакция на событие синхронизации
  `SyncState.Error` с `errcode === "M_UNKNOWN_TOKEN"`
  (`src/components/ChatApp.tsx:341-356`). При этом `matrix-js-sdk` в этом случае сначала
  делает `this.stop()` и переходит в `Error` (`node_modules/matrix-js-sdk/lib/sync.js:540-548`),
  т.е. синхронизация уже остановлена; `client.setAccessToken()` её не перезапускает.
* Обновление токена меняет `accessToken` → меняется `sessionKey()`
  (`src/lib/matrix/client.ts:133-135`) → `getMatrixClient()` считает это **другой сессией**:
  останавливает старый клиент, создаёт новый и заново открывает Rust-crypto store
  (`client.ts:352-368`). Это тяжёлая и гоночная операция (45-секундный гейт
  `waitForMatrixSync`, `client.ts:459`), и она же — лишний шанс получить ошибку хранилища.

**Как это выглядит для пользователя:** зашёл, поработал, переключил вкладку/постоял 5 минут,
нажал F5 → стартовый `/sync` приходит с мёртвым токеном → состояние `unavailable` →
«Matrix не синхронизируется · восстановить» → модалка, требующая **пароль аккаунта**
(`/api/auth/matrix-session` делает `bcrypt.compare`, `src/app/api/auth/matrix-session/route.ts:41-43`).
Тихой перезагрузки сессии не существует.

**Признак в консоли браузера:** `Token no longer valid - assuming logout` — это лог SDK
(`sync.js:542`). Если он есть — причина точно эта.

### 1.2 Refresh-токен вращается, а сохранён он в per-tab хранилище

Synapse при `POST /refresh` выдаёт новый refresh token и **отзывает использованный**.
Приложение пишет повёрнутые токены в `sessionStorage` текущей вкладки
(`src/components/ChatApp.tsx:306-316`) и обновляет React-состояние. Отсюда:

* две вкладки/PWA-окна одного пользователя — у каждой своя копия токена; первая,
  обновившая его, делает копию второй невалидной (и её refresh-токен тоже);
* перегрузка страницы в момент `handleUnknownToken` (пока не выполнен `sessionStorage.setItem`)
  теряет повёрнутый токен целиком: в `sessionStorage` остаётся старый refresh token,
  который сервер уже отозвал → восстановить сессию можно только паролем;
* `sessionStorage` в принципе не переживает «нов вкладку», перезапуск браузера, а в
  мобильном Safari/Chrome ещё и выгрузку вкладки из памяти.

### 1.3 Липкий флаг `matrix_reset_required` — разлогин на каждом обновлении

```js
// src/app/page.tsx:36-39
if (data.user.matrixResetRequired) {
  sessionStorage.removeItem("chata_matrix_session");
  sessionStorage.removeItem("chata_matrix_availability");
  setUser(null);          // ← экран входа, а не «переподключись к Matrix»
  return;
}
```

Флаг ставится из трёх мест: `POST /api/auth/matrix-reset`, админка по пользователю,
`POST /api/admin/system` с `action: "mass_matrix_reset"`. Снимается **только**
`POST /api/auth/matrix-reset-complete`.

Проблемы:

1. `/api/admin/system` (`src/app/api/admin/system/route.ts:44-46`) выполняет
   `db.update(users).set({ matrixResetRequired: true })` **без `where`** — один клик в
   админке помечает всех пользователей, и у всех Matrix отваливается на следующем F5,
   пока каждый не пройдёт полный вход с доступным Synapse.
2. В `AuthScreen` (`src/components/AuthScreen.tsx:65-101`) цепочка
   `clearLocalMatrixCryptoStores → /api/auth/matrix-session → /api/auth/matrix-reset-complete`
   обёрнута в `try/catch`, который **не отменяет вход**, а только пишет notice. Не удалось
   удалить IndexedDB (другая вкладка держит соединение → `onblocked` →
   «Закройте другие вкладки приложения…», `src/lib/matrix/client.ts:231`), Synapse ответил
   5xx, `whoami`/`devices` не сошлись — флаг остаётся `true`, и п.1 этого раздела
   превращается в «при каждом обновлении меня выкидывает».
3. Обработчик фатальных ошибок (`src/components/ChatApp.tsx:347-356, 385-392`) ловит
   `/unknown device|corrupted|indexeddb|crypto store|decryption|key error|invalid session/i`.
   Шаблон намеренно широкий, но `decryption`/`invalid session` легко возникают штатно —
   например, пока в фоне идёт восстановление ключей из backup после перезагрузки
   (`initializeMatrixCryptoAfterLogin`, `client.ts:975-990`). Один такой «ложный выстрел»
   = отзыв всех устройств в Synapse + удаление локальных ключей + флаг из п.1:
   история E2EE теряется, а сессия начинает отваливаться на каждом обновлении.

### 1.4 Мелкая, но злая деталь: `expiresAt` и `null`

`ChatApp.tsx:310` пишет `expiresAt: Date.now() + tokens.expires_in_ms`. Если хостинг не Synapse
или версия отдаёт `expires_ms` вместо `expires_in_ms`, получается `NaN`, а
`JSON.stringify(NaN)` → `null`. В `page.tsx:54` условие

```js
(candidate.expiresAt === undefined || (typeof candidate.expiresAt === "number" && Number.isFinite(candidate.expiresAt)))
```

на `null` не проходит → вся сессия считается мусором и удаляется. Итог — 100% потеря
Matrix-сессии на каждом обновлении, без единого сообщения об ошибке.

### 1.5 `cryptoDatabasePrefix` (справка)

`initRustCrypto({ useIndexedDB, cryptoDatabasePrefix })` в SDK 43 ещё принимается
(`client.d.ts:1172-1184` → `sync`: `storePrefix: args.cryptoDatabasePrefix ?? "matrix-js-sdk:crypto"`),
`npx tsc --noEmit` проходит. Это не причина падений, но опция устарела — при переходе на
следующий мажор SDK ключи начнут писаться в общее хранилище `matrix-js-sdk:crypto`,
и тогда несколько аккаунтов в одном браузере будут перетирать друг друга.

---

## 2. Push: почему не работает

### 2.1 Конфигурация (самое частое)

```js
// src/lib/push.ts:6-21
isPushConfigured = (VAPID_PUBLIC_KEY || NEXT_PUBLIC_VAPID_PUBLIC_KEY) && VAPID_PRIVATE_KEY && VAPID_EMAIL
```

* `VAPID_EMAIL` обязателен, хотя `npx web-push generate-vapid-keys` его не выдаёт.
  Не задан → `configured: false` → «Push-уведомления не настроены на сервере» и `503` на подписку.
* `web-push` валидирует subject (`node_modules/web-push/src/vapid-helper.js:68-88`):
  подходит только `mailto:...` или `https://...`. Обычный `admin@example.com` **бросает
  исключение** в `setVapidDetails`, оно всплывает из `sendPushToUser` до всякой отправки,
  а в `notifyChatMessage` проглатывается (`src/lib/notifications.ts:60-67`) — наружу
  выходит только `errorName` в логе.
* `/api/health` проверяет `config.push` по `VAPID_PUBLIC_KEY` без фallback'а на
  `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (`src/app/api/health/route.ts:37-38`) — может показать
  `push: false` при рабочей конфигурации (и наоборот).
* Нет `trim()`: `VAPID_PUBLIC_KEY="  BKabc…"` с пробелом/кавычкой ломает
  `urlBase64ToUint8Array` на клиенте → «Не удалось подписаться на уведомления».

### 2.2 Промпт на разрешение теряется

`subscribeToPush()` (`src/lib/push-client.ts:63-95`) сначала делает `fetch("/api/push/subscribe")`,
затем `waitForActiveServiceWorker()` (ожидание до **10 секунд**), и только потом
`Notification.requestPermission()`. Chrome (и Firefox по-своему) показывают промпт только
по «свежему» действию пользователя; после выхода за окно transient activation промпт
не появляется, а promise `requestPermission()` не резолвится — UI зависает на
`pushBusy` или получает «Разрешение на уведомления не выдано». Порядок надо обратный:
запрос разрешения синхронно в обработчике клика, остальное — после.

### 2.3 Service Worker регистрируется только после входа

`registerServiceWorker()` вызывается из `ChatApp` (`src/components/ChatApp.tsx:137`), т.е.
push физически невозможен для незалогиненной вкладки и для вкладки, открытой по ссылке из
уведомления (нужен `?chatId=`). Плюс `sw.js` живёт в `public/` — его обязан отдавать
тот же origin без кэша (`updateViaCache: "none"` задан — это правильно), иначе браузер
годами крутит старый SW.

### 2.4 Push для приватных E2EE-чатов зависит от Matrix-токена отправителя

Единственный способ уведомить о сообщении в `e2ee`-чате — вызов из браузера отправителя
(`src/lib/matrix/client.ts:1373, 1519` → `relayEncryptedMessagePush` → `/api/messages/matrix-push`).
Сервер проверяет событие **токеном отправителя**
(`verifyEncryptedMessageEvent`, `src/lib/matrix/server.ts:262-334`) и требует
`chats.security_mode = 'e2ee'` + `chats.matrix_room_id === roomId`
(`src/app/api/messages/matrix-push/route.ts:42`). Любое расхождение → `403`, а
`relayEncryptedMessagePush` пишет только `console.warn`. То есть **просроченный токен из
раздела 1.1 отключает и пуш в личке**. Отправка сообщения при этом успешно — проблема
не видна вовсе.

### 2.5 Подавление уведомления при открытом чате и отсутствие серверного флага

* `public/sw.js:25-34` не показывает уведомление, если в какой-либо видимой вкладке в URL
  есть `chatId` этого чата. `handleSelectChat` (`src/components/ChatApp.tsx:443-449`) пишет
  `?chatId=` через `history.replaceState` — достаточно один раз открыть чат, и все пуши в него
  «пропадают», пока вкладка видима.
* `user.pushEnabled` нигде не сохраняется: в `users` нет колонки
  (`src/db/schema.ts:13-34`), `ProfileSettingsModal` меняет только React-состояние
  (`onProfileUpdated({ pushEnabled: true })`), `/api/auth/me` его не отдаёт. Переключатель
  «включено» живёт до первой перезагрузки — ещё один источник ощущения «всё сбрасывается».
* Реального серверного состояния «пользователь отключил уведомления» нет: фильтрация только по
  `chat_members.notifications_muted`.

### 2.6 Блокирующая отправка

`POST /api/messages` (`src/app/api/messages/route.ts:181`) и
`/api/messages/matrix-push` **дожидаются** `notifyChatMessage` → `webpush.sendNotification` без
таймаута. Если VPS не может достучаться до `fcm.googleapis.com` /
`updates.push.services.mozilla.com`, отправка сообщения висит до сетевого таймаута. Это
выглядит одновременно и как «пуш не работает», и как «сообщения не уходят».

---

## 3. Как подтвердить за 5 минут

### На сервере

```bash
# 1. Matrix: health + жив ли homeserver изнутри
curl -s http://127.0.0.1:8010/api/health | python3 -m json.tool   # expect "matrix":"ok", config.push

# 2. Липкий флаг — причина разлогинов на F5?
psql "$DATABASE_URL" -c "select id, username, matrix_reset_required from users order by id;"

# 3. Кто и с каких устройств реально подписан на пуш
psql "$DATABASE_URL" -c "select user_id, count(*), max(created_at) from push_subscriptions group by 1;"
psql "$DATABASE_URL" -c "select id, security_mode, matrix_room_id is not null as has_room from chats order by id;"

# 4. Кто стоит на масс-сбросе в истории админа
psql "$DATABASE_URL" -c "select created_at, action, details from admin_audit_logs where action like '%matrix%' order by id desc limit 20;"

# 5. Ошибки доставки пуша (коды status без секретов)
npx pm2 logs chata --lines 300 --nostream | grep -Ei "web push|push|matrix"

# 6. Срок жизни токенов в Synapse (главный подозреваемый)
grep -RnE "refreshable_access_token_lifetime|nonrefreshable_access_token_lifetime|refresh_token_lifetime" /etc/matrix-synapse/ || \
  echo "не задано → refreshable=5m по умолчанию"
```

### В браузере

1. DevTools → Console: ищем `Token no longer valid - assuming logout`
   (токен протух) и `[Matrix E2EE] received to-device event` (клиент жив).
2. Application → Session Storage: есть ли `chata_matrix_session`, и что внутри `expiresAt`.
   Если после «восстановления» там `expiresAt: null` — это пункт 1.4.
3. Application → Service Workers: `active`/`error`; Network → `GET /sw.js` → 200,
   `Content-Type: text/javascript`, без `immutable`.
4. `chrome://settings/content/notifications` для домена: не в «Block» ли.
5. Настройки профиля → Уведомления → «Отправить тестовое»: ответ
   `503` = VAPID, `409` = нет подписки, `502` = пуш-сервис отверг (смотреть `pm2 logs`).
6. Сравнить: в приватном чате пуш не приходит **только** когда у отправителя просрочен
   Matrix-токен (в консоли отправителя — `Encrypted message push relay failed {statusCode: 403}`).

Быстрый эксперимент, который подтверждает п.1 за минуту: в `homeserver.yaml` поставить
`refreshable_access_token_lifetime: 30d`, `systemctl restart matrix-synapse`, перезайти в
приложение и погонять F5. Симптом исчезнет — причина в коротком токене.

---

## 4. Что чинить (по приоритету)

### P0 — не просить 5-минутный токен или научить SDK его обновлять

Вариант A (минимальный, 1 строка). В `src/lib/matrix/server.ts:508-536` убрать `refresh_token: true`
→ Synapse выдаёт токен без срока (`nonrefreshable_access_token_lifetime` по умолчанию infinity).
Цена: нет авто-истечения, отзыв только явный (`resetMatrixDevicesForAppUser` уже есть).

```diff
-      // Homeservers that support Matrix refresh tokens can keep a long-lived
-      // device session alive without making the user sign out and back in.
-      refresh_token: true,
+      // Refresh tokens make Synapse issue 5-minute access tokens by default
+      // (`refreshable_access_token_lifetime: 5m`), which is what drops the tab
+      // session on every reload. Revocation is explicit in this app.
```

Вариант B (правильный, если хочется короткоживущие токены): прокинуть ротацию в сам SDK,
чтобы он продлевал сессию *до* истечения (`client.d.ts:118-134` — `refreshToken` + `onTokenRefresh`):

```ts
const client = createClient({
  baseUrl: session.baseUrl,
  userId: session.userId,
  accessToken: session.accessToken,
  refreshToken: session.refreshToken,        // ← было не передано
  onTokenRefresh: (tokens) => persistRotatedTokens(tokens), // ← обязателен при refreshToken
  deviceId: session.deviceId,
  cryptoCallbacks,
});
```

`persistRotatedTokens` обязан записать **новый refresh token в хранилище до** того, как им
воспользуется другая вкладка (см. 1.2), и обновить токен в клиенте без пересоздания.

### P0 — не пересоздавать клиент из-за ротации токена

`src/lib/matrix/client.ts:133-135` — исключить `accessToken` из ключа и обновлять его на месте:

```diff
 function sessionKey(session: MatrixSession): string {
-  return `${session.baseUrl}|${session.userId}|${session.deviceId}|${session.accessToken}`;
+  // The access token rotates (refresh tokens); keying on it tears the client and
+  // the Rust crypto store down on every refresh. Identity = base URL + device.
+  return `${session.baseUrl}|${session.userId}|${session.deviceId}`;
 }
```

+ в месте смены токена: `client.getHttpClient().setAccessToken(next)` /
`client.setAccessToken(next)` вместо `getMatrixClient(newSession)`.

### P1 — хранить Matrix-сессию так, чтобы она переживала вкладку, и проверять срок

* `chata_matrix_session` → `localStorage` (ключ уже привязан к `@chata_u<id>`, а сам доступ
  защищён cookie `auth_token` с `httpOnly+sameSite=lax`), либо добавить серверный
  `POST /api/auth/matrix-refresh`, который по сохранённому refresh token
  перевыпускает сессию без пароля.
* В `src/app/page.tsx` перед использованием сравнивать `expiresAt` с `Date.now()` и, если
  осталось < 60 с, идти на `/api/auth/matrix-refresh`; `expiresAt` валидировать мягко
  (`null`/`NaN` → трактовать как «без срока», а не «мусор») — п.1.4.
* Синхронизировать повёрнутые токены между вкладками через `storage`-событие.

### P1 — убрать «ядерный» автосброс и разорвать петлю флага

* Сузить регулярку в `ChatApp.tsx:347-356, 385-392` до реально невосстановимых ошибок
  (`"Storage is not initialized"|CorruptStorage|database is unavailable`) и показывать
  кнопку «Сбросить Matrix» вместо автоматического `handleFatalMatrixReset()`.
* `src/app/page.tsx:36-39` при `matrixResetRequired` не выкидывать на экран входа, а
  открывать `MatrixSessionRecoveryModal` (сессия приложения валидна, нужен только новый Matrix device).
* `src/app/api/admin/system/route.ts:44-46`: добавить `where`, либо явно подтверждаемое
  действие + счётчик, иначе массовый сброс — это DoS всех E2EE-сессий.
* В `AuthScreen` не глотать ошибку ветки сброса: если `matrix-reset-complete` не прошёл,
  оставаться в модалке с понятной ошибкой, а не «входить с заведомо липким флагом».

### P1 — пуш: не терять промпт и не вешать отправку

* `src/lib/push-client.ts`: сначала `await Notification.requestPermission()` (в том же тике,
  что и клик), потом `registerServiceWorker()`/`subscribe()`; при `permission !== "granted"`
  не начинать сетевые вызовы.
* `src/lib/push.ts`: `?.trim()` для ключей, валидация формата subject
  (`VAPID_EMAIL` → нормализовать в `mailto:` если это просто e-mail), и `Promise.race` с
  таймаутом ~10 с вокруг `webpush.sendNotification`, чтобы зависший пуш-провайдер не
  блокировал `POST /api/messages`.
* `src/app/api/health/route.ts:37-38`: тот же фallback на `NEXT_PUBLIC_VAPID_PUBLIC_KEY`,
  что и в `isPushConfigured()`, иначе диагностика врёт.
* Завести `users.push_enabled` + `PATCH /api/profile/push`, чтобы состояние не терялось и
  сервер реально фильтровал отправку.

### P2 — пуш для приватных чатов без браузера отправителя

Сейчас это «лучше effort». Минимально полезные шаги: поднять `relayEncryptedMessagePush`
из `console.warn` в видимый UI-статус (иначе «не доставлено» не отличить от «доставлено»),
и/или поставить Synapse push gateway (`matrix-synapse` + `sygnal`) и подписывать `pusher`
через `POST /_matrix/client/v3/pushers/set` — тогда уведомления о E2EE-событиях приходят,
даже когда вкладка отправителя закрыта.

### P2 — убрать подавление «по открытому чату»

`public/sw.js`: подавлять только когда документ реально в фокусе **и** это уведомление о
том же чате было получено не ранее `document.visibilityState === "visible"`; либо показывать
всегда и ограничиваться `silent`-вариантом. Текущее поведение («у меня же открыт чат») легко
выглядит как «пуш не работает» при любой проверке.

---

## 5. Что исправлено в этой ветке

Реализовано (см. `git diff` в коммите этой ветки):

**Matrix**

| Файл | Изменение |
|---|---|
| `src/lib/matrix/server.ts` | `refresh_token: true` убран: refresh-токены теперь запрашиваются только при `MATRIX_REFRESH_TOKENS=1`. Добавлены `matrixRefreshTokensEnabled()` и `refreshMatrixSession()` (серверная ротация с проверкой `/whoami`: пользователь + device обязательны). |
| `src/app/api/auth/matrix-refresh/route.ts` | **новый** эндпоинт тихого обновления токена по refresh token — без пароля. `401` означает «нужен пароль», `503` — Matrix недоступен. |
| `src/lib/matrix/session-store.ts` | **новый** модуль хранения: `localStorage` + `sessionStorage`, ключ по id пользователя (`chata_matrix_session_v2_u<id>`), авто-миграция старой per-tab записи, защита от передачи сессии другому аккаунту, терпимый парсинг `expiresAt` (NaN/null больше не уничтожают сессию), событие `storage` для синхронизации вкладок. |
| `src/lib/matrix/client.ts` | `sessionKey()` больше не содержит `accessToken` → ротация токена не пересоздаёт клиент и не перезапускает Rust crypto; токен «принимается» на живом клиенте через `setAccessToken`. В `createClient` передаются `refreshToken` + `onTokenRefresh` (SDK продлевает токен **до** истечения и пишет повёрнутую пару в хранилище). `relayEncryptedMessagePush` получил 3 попытки и попытку ротации при `401/403`. Добавлен `isFatalMatrixCryptoError()` — узкий, только реально повреждённое хранилище. |
| `src/app/page.tsx` | Загрузка сессии через стор + `loadUsableMatrixSession()` (тихое обновление просроченного токена при загрузке). При `matrix_reset_required` пользователя **больше не выкидывает** на экран входа: чистится только Matrix-часть, открывается модалка восстановления. Стабильный `onLogout` (`useCallback`). |
| `src/components/AuthScreen.tsx`, `ChatApp.tsx`, `src/lib/matrix/recover-session.ts` | Единый восстановление-хелпер: сначала переиспользуется **тот же** device ID (ключи и история остаются), новое устройство создаётся только если homeserver ответил `409`. Ошибки больше не проглатываются молча. |
| `src/app/api/auth/matrix-session/route.ts` | Снимает `matrix_reset_required` на сервере сразу после успешного создания сессии — петля «разлогин на каждом F5» больше не может заклинить. |
| `src/components/ChatApp.tsx` | Авто-`handleFatalMatrixReset` удалён: вместо него баннер + кнопка «Сбросить Matrix-идентичность» в сайдбаре с подтверждением. Ротация токена ограничена 2 попытками, затем — модалка. Вкладки синхронизируют токены через `subscribeToMatrixSessionChanges`. |
| `src/app/api/admin/system/route.ts`, `AdminDashboard.tsx` | `mass_matrix_reset` требует фразу-подтверждение `МАССОВЫЙ СБРОС` (как nuclear wipe). |

**Push**

| Файл | Изменение |
|---|---|
| `src/lib/push-client.ts` | `Notification.requestPermission()` вызывается **первым**, до `fetch` и ожидания SW (иначе Chrome глотает промпт, а promise висит). Отдельное сообщение про небезопасный контекст (http), `missingEnv` в ошибке конфигурации. |
| `src/lib/push.ts` | `trim()` всех `VAPID_*`, нормализация `VAPID_EMAIL` → `mailto:` (было: `web-push` бросает исключение и вся отправка молча падает), `missingPushEnv()` для диагностики, таймаут 10 с на `sendNotification` (зависший провайдер больше не вешает `POST /api/messages`), текст ошибки в лог вместо голого `errorName`. |
| `src/app/api/health/route.ts` | `config.push` = тот же предикат, что у кода отправки; добавлены `pushMissingEnv` и `matrixRefreshTokens`. |
| `src/app/api/push/{status,subscribe}/route.ts` | Отдают `missingEnv`, `no-store` на GET. |
| `src/app/api/push/test/route.ts` | Понятные подсказки: `401/403` → VAPID-пара не та, `404/410` → пересоздать подписку, пустые коды → VPS не видит push-сервис. |
| `public/sw.js` | Подавление только когда вкладка с этим чатом в **фокусе** (ранее — просто `visible`, что выглядело как «уведомления не работают»). |
| `scripts/smoke-test.mjs` | Проверки: `/api/auth/matrix-refresh` недоступен анонимно (401) и с некорректным телом (400). |

Не делал осознанно: `users.push_enabled` в БД (текущий тумблер — только UI-статус, на доставку не влияет; если нужен серверный флаг — скажите), и собственный push-gateway к Synapse (`sygnal`), который убрал бы зависимость E2EE-уведомлений от вкладки отправителя.

Что нужно сделать на сервере после деплоя:

```bash
git pull && npm ci && npm run db:setup && npm run build && npx pm2 restart chata --update-env
# .env: VAPID_* без изменений; MATRIX_REFRESH_TOKENS можно не трогать (по умолчанию выкл)
# в homeserver.yaml ничего менять не обязательно; если refresh-токены включите —
# выставьте refreshable_access_token_lifetime: 30d
```

Пользователям с уже «залипшим» флагом: один раз войти (или нажать «Восстановить Matrix-сессию»
и ввести пароль) — флаг снимется сам.

## 6. Проверенные факты, на которые опирается отчёт

* `matrix-js-sdk@43.0.0`, `initRustCrypto` принимает `cryptoDatabasePrefix`
  (`node_modules/matrix-js-sdk/lib/client.d.ts:1172-1184`), `createClient` поддерживает
  `refreshToken` + обязательный `onTokenRefresh` (там же, `118-134`).
* При `M_UNKNOWN_TOKEN` синк-цикл SDK останавливается сам:
  `node_modules/matrix-js-sdk/lib/sync.js:540-548`.
* Synapse по умолчанию: `refreshable_access_token_lifetime` = 5m,
  `refresh_token_lifetime` = infinity, `nonrefreshable_access_token_lifetime` = infinity
  (docs/usage/configuration/config_documentation.md, element-hq/synapse).
* `web-push` требует subject `mailto:`/`https:`
  (`node_modules/web-push/src/vapid-helper.js:68-88`).
* `npx tsc --noEmit` в текущем состоянии проходит — то есть все перечисленные проблемы
  это логика/конфигурация, а не ошибки типов.
