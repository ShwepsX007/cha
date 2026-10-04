# E2EE and private group chat rollout

## Agreed product behavior

- The existing `Общий чат` remains a normal, unencrypted public room.
- New direct chats and private multi-person rooms use end-to-end encryption (E2EE).
- Only a room creator/admin may invite members.
- New devices are linked/verified from an already trusted device using a QR flow. A separate recovery key/passphrase is also provided for restoring encrypted key backup when no trusted device is available. The server stores only the encrypted backup and cannot read the key. A short numeric code is not the only recovery method; if used during device linking, it must be one-time, short-lived, and rate-limited.
- Existing history is retained as legacy plaintext. New private-room messages are encrypted; old messages must be clearly marked as not E2EE.
- Telegram remains the attachment store. The browser encrypts an attachment before upload; Telegram and the app server receive only ciphertext. Filenames, MIME type, and file decryption metadata must be sent inside the encrypted room message, not as plaintext database fields.

## Architecture decision

Use the Matrix client/server protocol and its maintained browser crypto stack rather than inventing a custom encryption protocol. Keep the current Next.js/PostgreSQL app for authentication, profiles, the public General Chat, and the Telegram attachment gateway. Add a self-hosted Matrix homeserver for private direct and group rooms. Prefer routing its client API through the existing HTTPS origin under `/_matrix` so the current domain and certificate can be reused; use a separate PostgreSQL database for the homeserver.

The Matrix client must initialize its persistent browser crypto store before syncing. Private rooms are created with room encryption enabled. Group power levels must restrict invitations to the creator/admin. A membership change must cause the Matrix crypto client to rotate its outbound group session; newly invited users must not receive old session keys.

## Rollout stages

1. Add and test the homeserver and HTTPS reverse-proxy route without changing the currently running chat.
2. Provision Matrix identities for existing app accounts and return short-lived Matrix sessions only to the matching authenticated user.
3. Add encrypted direct rooms and encrypted private groups to the UI; keep General Chat on the existing plaintext API. Keep existing direct-chat messages visible as legacy history, but stop writing new private message bodies to PostgreSQL.
4. Encrypt file bytes in the browser, upload only the ciphertext to Telegram as a document, and place the Telegram file reference plus decryption metadata inside the encrypted Matrix event.
5. Add QR device verification/linking and secure key backup/recovery UI.
6. Test with two accounts and two devices before enabling the feature for real users.

## Security acceptance checks

- New private text and file metadata in PostgreSQL are ciphertext or opaque identifiers, never plaintext.
- Telegram receives encrypted attachment bytes for private rooms; the intended recipient can decrypt after download.
- The public General Chat remains readable as plaintext by its members.
- A newly invited group member can read new messages but cannot decrypt earlier group history.
- A device that is not verified cannot silently replace a user's trusted encryption identity.
- Existing plaintext history is visibly identified as legacy and is not described as E2EE.

E2EE does not hide all metadata (such as room membership, timing, and traffic size). A browser-based client also relies on the JavaScript served by the web server; a compromised server could try to serve malicious client code. Do not label the feature secure until the acceptance checks pass.
