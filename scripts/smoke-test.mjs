/**
 * End-to-end smoke test against a running server.
 *
 *   node scripts/smoke-test.mjs                       # read-only checks
 *   BASE_URL=https://example.com node scripts/smoke-test.mjs
 *   SMOKE_ALLOW_WRITES=1 node scripts/smoke-test.mjs  # also registers two
 *                                                     # throwaway accounts
 *
 * The write mode creates users named smoke_<random> and leaves them in the
 * database on purpose: delete them from the admin panel afterwards.
 */
const baseUrl = (process.env.BASE_URL || "http://127.0.0.1:8010").replace(/\/+$/, "");
const allowWrites = process.env.SMOKE_ALLOW_WRITES === "1";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function json(path, options = {}, cookie) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: "manual" });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const setCookie = response.headers.getSetCookie?.() || [];
  return { response, body, cookie: setCookie.map((c) => c.split(";")[0]).join("; ") };
}

async function main() {
  console.log(`Smoke test against ${baseUrl}\n`);

  console.log("Public endpoints");
  const health = await json("/api/health");
  check("GET /api/health answers", health.response.ok, `HTTP ${health.response.status}`);
  check("database is ok", health.body?.database === "ok", JSON.stringify(health.body));
  check("schema is provisioned", health.body?.schema === "ok", JSON.stringify(health.body?.missingTables));
  check("configuration is valid", health.body?.config?.jwtSecret === true, JSON.stringify(health.body?.config));

  const home = await fetch(`${baseUrl}/`);
  check("GET / returns HTML", home.status === 200 && (await home.text()).includes("Secret Chat"), `HTTP ${home.status}`);

  const unauthorized = await json("/api/auth/me");
  check("GET /api/auth/me without a session is 401", unauthorized.response.status === 401);

  const chatsUnauthorized = await json("/api/chats");
  check("GET /api/chats without a session is 401", chatsUnauthorized.response.status === 401);

  if (!allowWrites) {
    console.log("\nSkipping write checks (set SMOKE_ALLOW_WRITES=1 to enable).");
  } else {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [a, b] = [`smoke_a_${suffix}`, `smoke_b_${suffix}`];

    console.log("\nRegistration and public chat");
    const regA = await json("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: a, password: "smoke-password-1", displayName: `Smoke A ${suffix}` }),
    });
    check("register user A", regA.response.ok, `HTTP ${regA.response.status} ${JSON.stringify(regA.body)}`);
    const regB = await json("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: b, password: "smoke-password-1", displayName: `Smoke B ${suffix}` }),
    });
    check("register user B", regB.response.ok, `HTTP ${regB.response.status}`);
    const pushStatus = await json("/api/push/status", {}, regA.cookie);
    check("authenticated push status reports subscriptions", pushStatus.response.ok &&
      Number.isInteger(pushStatus.body?.subscriptionCount), `HTTP ${pushStatus.response.status}`);
    const pushTest = await json("/api/push/test", { method: "POST" }, regA.cookie);
    check("push test endpoint gives a clear unconfigured/unsubscribed result",
      pushTest.response.status === 409 || pushTest.response.status === 503,
      `HTTP ${pushTest.response.status} ${JSON.stringify(pushTest.body)}`);

    const chats = await json("/api/chats", {}, regA.cookie);
    const general = chats.body?.chats?.find((chat) => chat.isGroup && chat.securityMode === "public");
    check("user A is a member of the public chat", Boolean(general), JSON.stringify(chats.body).slice(0, 200));

    if (general) {
      console.log("\nMessages, receipts, avatars");
      const sent = await json("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: general.id, content: `smoke ${suffix}` }),
      }, regA.cookie);
      check("send a public message", sent.response.ok && sent.body?.message?.id, `HTTP ${sent.response.status}`);

      const messageId = sent.body?.message?.id;
      const seenByB = await json(`/api/messages?chatId=${general.id}`, {}, regB.cookie);
      check("user B reads the message", Array.isArray(seenByB.body?.messages) && seenByB.body.messages.some((m) => m.id === messageId));

      const receiptUrl = `/api/messages/${general.id}/receipts`;
      const [delivered, marked] = await Promise.all([
        json(receiptUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageIds: [messageId], status: "delivered" }),
        }, regB.cookie),
        json(receiptUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageIds: [messageId], status: "read" }),
        }, regB.cookie),
      ]);
      check("concurrent delivered/read receipts succeed", delivered.response.ok && marked.response.ok,
        `delivered HTTP ${delivered.response.status}, read HTTP ${marked.response.status}`);

      const receipts = await json(receiptUrl, {}, regA.cookie);
      check("sender sees the read receipt", receipts.body?.receipts?.[messageId]?.status === "read", JSON.stringify(receipts.body));

      const zlib = await import("node:zlib");
      const chunk = (type, data) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const typeBuffer = Buffer.from(type);
        const crcInput = Buffer.concat([typeBuffer, data]);
        let crc = ~0;
        for (const byte of crcInput) {
          crc ^= byte;
          for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
        const crcBuffer = Buffer.alloc(4);
        crcBuffer.writeUInt32BE((~crc) >>> 0);
        return Buffer.concat([length, typeBuffer, data, crcBuffer]);
      };
      const header = Buffer.alloc(13);
      header.writeUInt32BE(1, 0);
      header.writeUInt32BE(1, 4);
      header[8] = 8;
      header[9] = 2;
      const png = Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", header),
        chunk("IDAT", zlib.deflateSync(Buffer.from([0, 255, 0, 0]))),
        chunk("IEND", Buffer.alloc(0)),
      ]);

      const form = new FormData();
      form.append("avatar", new Blob([png], { type: "image/png" }), "smoke.png");
      const uploaded = await fetch(`${baseUrl}/api/profile/avatar`, {
        method: "POST",
        headers: { cookie: regA.cookie },
        body: form,
      });
      const uploadedBody = await uploaded.json().catch(() => ({}));
      check("avatar upload succeeds", uploaded.ok && uploadedBody.avatarUrl, `HTTP ${uploaded.status}`);

      if (uploadedBody.avatarUrl) {
        const fetched = await fetch(`${baseUrl}${uploadedBody.avatarUrl}`);
        check(
          "uploaded avatar is served immediately (no server restart)",
          fetched.ok && (fetched.headers.get("content-type") || "").includes("image/"),
          `HTTP ${fetched.status} after ${uploadedBody.avatarUrl}`,
        );
      }
    }
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
