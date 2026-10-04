# Matrix E2EE rollout

## Current status — code implemented, deployment still required

The app now has a Matrix client/authentication path, encrypted-room creation and verification, encrypted text messaging, encrypted attachment handling, device verification/recovery UI, and fail-closed behavior for private chats. The production homeserver is **not deployed or configured yet**, so E2EE is **not active on the live app** until Synapse and the required environment variables are set and end-to-end tests pass.

What is implemented in the code:

- `matrix-js-sdk@43.0.0` with its Rust/WASM crypto stack for Olm/Megolm.
- Dedicated Matrix IDs derived from existing app user IDs. Synapse identities are provisioned with its admin API; a user's Matrix password is synchronized only after the app has verified that user's existing password.
- Private Matrix rooms are created encrypted from their initial state, invite-only, and use `history_visibility: joined`. Room linking is rejected unless the server verifies the encryption event, room permissions, membership list, and the caller's Matrix identity.
- New private text messages are sent through Matrix and are not written to the PostgreSQL `messages` table. Private plaintext POSTs are rejected.
- `matrix-encrypt-attachment` (Matrix.org's attachment-format library) encrypts private file bytes in the browser. The Telegram gateway receives a random filename and `application/octet-stream` ciphertext; it does not store private attachment metadata in PostgreSQL. The filename, MIME type, original size, Telegram file reference, and Matrix decryption information are carried inside the encrypted Matrix event.
- Private group creation supports multiple invitees. Matrix power levels restrict invitations to users with admin-level power; the app's group-member endpoint verifies that permission before adding a database membership.
- Existing private history remains in PostgreSQL as plaintext and is visibly labeled `Legacy · не зашифровано`. New writes to a legacy private chat are blocked until it is linked to an encrypted Matrix room. The existing `Общий чат` remains plaintext/public.
- If Matrix or Telegram is unavailable, private text/file sending fails closed; the app does not silently fall back to storing private content in plaintext.
- The **Устройства и ключи Matrix** panel uses `matrix-js-sdk` QR verification plus `@zxing/browser` scanning: the new device requests verification, the already trusted device accepts and displays the SDK-generated QR, the new device scans it, and the trusted device explicitly confirms the scan. The Matrix Rust SDK performs the cross-signing/secret-sharing protocol; the app does not encode keys or invent its own crypto.
- The same panel can initialize Matrix cross-signing, secret storage and a room-key backup, then show the Matrix recovery key once for the user to save. A recovery-key form can restore stored cross-signing secrets and a trusted key backup; QR pairing can also request restoration of a backup shared from the trusted device. Recovery keys stay in memory only during use and are not put in PostgreSQL, localStorage or sessionStorage.

Still not deployed or verified against a live homeserver:

- Synapse deployment, reverse proxy, and production environment configuration.
- Two-account/two-device acceptance tests against a real homeserver, including QR verification and recovery, and verifying that a newly invited group member cannot decrypt pre-join history. The SDK QR/backup flow has only been wired into the app; Synapse behavior must be tested before production use.

## Agreed product behavior

- The existing `Общий чат` stays open and unencrypted.
- New direct chats and private groups use Matrix E2EE.
- Only a group creator/admin may invite members. Matrix power levels are the enforcement layer; the app API checks them before recording a new membership.
- Existing chat history is retained as plaintext legacy data. It is never represented as encrypted.
- Telegram is only the encrypted attachment byte store for private chats. Original names, MIME types, sizes, Telegram file IDs, and decryption information are kept inside the encrypted Matrix room event, not plaintext database fields.
- A new device is paired/verified from a trusted device with QR. A recovery key/phrase is provided as a separate fallback; a short numeric code is not the sole recovery mechanism.

## Deployment prerequisites

Do not set the `MATRIX_*` variables until all of the following are ready:

1. A self-hosted Synapse homeserver with a **stable** `server_name` (suggested: `chatan.fun`), using a separate PostgreSQL database/user from the chat app. Do not use SQLite for production.
2. Public HTTPS routing for the Matrix client API. The current plan is same-origin routing under `https://chatan.fun/_matrix` so browsers can use the existing certificate and same-origin Telegram download endpoint.
3. Synapse public registration disabled. Accounts are provisioned by the app's server-side Synapse admin API. Keep federation disabled/restricted if rooms are intended to stay inside this app.
4. A Synapse administrator access token stored only in the server-side `.env`; never use a `NEXT_PUBLIC_` variable or paste the token into chat.

Example Nginx location (merge into the existing HTTPS virtual host; retain the site's current Next.js proxy for all other paths):

```nginx
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

The exact listener, firewall, PostgreSQL, and Nginx configuration must match the actual server deployment. Do not expose Synapse's internal port or admin API directly to the public internet. The Next.js process uses `MATRIX_INTERNAL_URL` for admin/user provisioning; the browser uses `MATRIX_PUBLIC_URL`.

Set these server-only values after Synapse and Nginx have passed health checks:

```dotenv
MATRIX_PUBLIC_URL=https://chatan.fun
MATRIX_INTERNAL_URL=http://127.0.0.1:8008
MATRIX_SERVER_NAME=chatan.fun
MATRIX_ADMIN_ACCESS_TOKEN=<Synapse admin access token kept in server .env only>
```

Generate/create the Synapse admin account and obtain its access token on the server itself, then place it in the protected server `.env` (for example, owned by the app service account with mode `0600`). Do not commit `.env` or send the token in chat.

## Database migration

Back up the chat database first. The schema change is represented in `src/db/schema.ts` and the idempotent SQL in `drizzle/0001_e2ee_chats.sql`. Apply that SQL migration (it can also be run after `npx drizzle-kit push`, if you use push to add the columns). Do not rely on `drizzle-kit push` alone: it does not run the explicit General Chat classification. Existing private chats remain `legacy`; the original General Chat is assigned `public`. Do not bulk-rewrite old messages.

## Rollout and acceptance tests

1. Deploy Synapse, configure the reverse proxy and server-only variables, then confirm the Matrix client API and Synapse admin API are reachable from the app host.
2. Apply the chat-app database schema update and deploy the app. Until this step is complete, the app UI reports Matrix unavailable/not configured; private chat sending remains blocked rather than falling back to plaintext.
3. Test with two separate app accounts: create a direct chat and a private group, inspect the Matrix room's `m.room.encryption`, `m.room.join_rules`, `m.room.history_visibility`, and power levels, and confirm new text is readable by members but absent from PostgreSQL.
4. Upload a harmless test file in a private room. Verify Telegram receives only an opaque, randomly named binary document; verify original filename/MIME/size and decryption information are only present after decrypting the Matrix event; then download/decrypt on the other account.
5. In a group, invite a third account. Confirm a regular member cannot invite. Confirm the newly added member can read messages sent after joining but cannot decrypt earlier group messages.
6. Verify old PostgreSQL messages/files remain readable and visibly labeled legacy. Verify `Общий чат` continues to send/read plaintext messages and files.
7. Open **Устройства и ключи Matrix** on both devices. On the new device choose **Запросить QR**; on the trusted device accept the request, show the QR and confirm the scan; then restore Matrix room keys. Separately create and safely save the one-time recovery key, and test restore on a clean device. Do not describe the product as device-recoverable until these real-homeserver tests pass.

E2EE does not hide all metadata (membership, timing, traffic size). The browser must receive the Matrix decryption keys to display content. The current implementation uses the Matrix SDK's persistent browser IndexedDB store without a separate user-entered local storage passphrase; protect the browser profile/device, and treat XSS or a compromised web server as capable of accessing plaintext/keys. A compromised web server could also serve malicious JavaScript, so do not call the deployment fully secure until the real-service tests above pass.
