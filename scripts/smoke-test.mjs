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
 *
 * Registration is captcha-protected (the test "reads" the generated SVG) and
 * capped at 3 successful registrations per hour per IP — repeated runs against
 * the same server all come from 127.0.0.1. For a test environment the server
 * can run with REGISTER_MAX_PER_IP=0 in .env (or higher), otherwise the quota
 * 429s the third run of the hour.
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

/**
 * Solve the registration captcha like a sighted user would: request a
 * challenge, "read" the SVG. Decoding the glyph positions from the distorted
 * image via regex is only possible because we own the renderer — a real bot
 * facing the public site must do OCR, which the distortion is built for.
 */
async function solvedCaptcha() {
  const challenge = await json("/api/auth/captcha", { method: "POST" });
  if (!challenge.response.ok || !challenge.body?.token || !challenge.body?.image) {
    throw new Error(`captcha challenge failed: HTTP ${challenge.response.status}`);
  }
  const svg = Buffer.from(challenge.body.image.split(",")[1], "base64").toString("utf8");
  const code = [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]).join("");
  // The server rejects answers submitted <1s after issuing the challenge.
  await new Promise((resolve) => setTimeout(resolve, 1150));
  return { token: challenge.body.token, code };
}

async function register(username, password, displayName) {
  const captcha = await solvedCaptcha();
  return json("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      password,
      displayName,
      captchaToken: captcha.token,
      captchaAnswer: captcha.code,
    }),
  });
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

  const usersUnauthorized = await json("/api/users?q=an");
  check("GET /api/users without a session is 401", usersUnauthorized.response.status === 401);

  const captchaChallenge = await json("/api/auth/captcha", { method: "POST" });
  check("captcha challenge issues a token + SVG image",
    captchaChallenge.response.ok &&
      typeof captchaChallenge.body?.token === "string" &&
      String(captchaChallenge.body?.image || "").startsWith("data:image/svg+xml;base64,"),
    `HTTP ${captchaChallenge.response.status}`);

  const registerNoCaptcha = await json("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "smoke_nocapt", password: "whatever-1" }),
  });
  check("register without a captcha is refused",
    registerNoCaptcha.response.status === 400 && registerNoCaptcha.body?.captchaRequired === true,
    `HTTP ${registerNoCaptcha.response.status} ${JSON.stringify(registerNoCaptcha.body)}`);

  const passwordChangeUnauthorized = await json("/api/profile/password", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newPassword: "smoke-password-2", confirmPassword: "smoke-password-2" }),
  });
  check("password change without a session is 401", passwordChangeUnauthorized.response.status === 401);

  const pushStatusPublic = await json("/api/push/status");
  check("push status without a session is 401", pushStatusPublic.response.status === 401);

  if (!allowWrites) {
    console.log("\nSkipping write checks (set SMOKE_ALLOW_WRITES=1 to enable).");
  } else {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [a, b] = [`smoke_a_${suffix}`, `smoke_b_${suffix}`];

    console.log("\nRegistration and public chat");
    const regA = await register(a, "smoke-password-1", `Smoke A ${suffix}`);
    check("register user A (with captcha)", regA.response.ok, `HTTP ${regA.response.status} ${JSON.stringify(regA.body)}`);

    const newPassword = "smoke-password-2";
    const passwordChange = await json("/api/profile/password", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword, confirmPassword: newPassword }),
    }, regA.cookie);
    check("change password without entering the old password",
      passwordChange.response.ok && passwordChange.body?.success === true,
      `HTTP ${passwordChange.response.status} ${JSON.stringify(passwordChange.body)}`);

    const newPasswordLogin = await json("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: a, password: newPassword }),
    });
    check("new password works for login", newPasswordLogin.response.ok && newPasswordLogin.body?.user?.username === a,
      `HTTP ${newPasswordLogin.response.status}`);

    const oldPasswordLogin = await json("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: a, password: "smoke-password-1" }),
    });
    check("old password no longer works", oldPasswordLogin.response.status === 401,
      `HTTP ${oldPasswordLogin.response.status}`);

    const regB = await register(b, "smoke-password-1", `Smoke B ${suffix}`);
    check("register user B (with captcha)", regB.response.ok, `HTTP ${regB.response.status}`);
    const pushStatus = await json("/api/push/status", {}, regA.cookie);
    check("authenticated push status reports subscriptions", pushStatus.response.ok &&
      Number.isInteger(pushStatus.body?.subscriptionCount), `HTTP ${pushStatus.response.status}`);
    const pushTest = await json("/api/push/test", { method: "POST" }, regA.cookie);
    check("push test endpoint gives a clear unconfigured/unsubscribed result",
      pushTest.response.status === 409 || pushTest.response.status === 503,
      `HTTP ${pushTest.response.status} ${JSON.stringify(pushTest.body)}`);

    // A private chat is just a chat now: create a DM, post, read it back.
    const dmChat = await json("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUserId: regB.body?.user?.id }),
    }, regA.cookie);
    check("direct chat created", dmChat.response.ok && dmChat.body?.chat?.id > 0,
      `HTTP ${dmChat.response.status}`);
    if (dmChat.body?.chat?.id) {
      const dmId = dmChat.body.chat.id;
      const dmMessage = await json("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: dmId, content: "smoke dm ping" }),
      }, regA.cookie);
      check("message accepted into the direct chat", dmMessage.response.status === 200,
        `HTTP ${dmMessage.response.status} ${JSON.stringify(dmMessage.body)}`);
      const dmTimeline = await json(`/api/messages?chatId=${dmId}`, {}, regA.cookie);
      check("direct chat timeline contains the message",
        Array.isArray(dmTimeline.body?.messages) &&
        dmTimeline.body.messages.some((message) => message.content === "smoke dm ping"));

      console.log("\nSearch-only users, message and chat deletion");
      const usersListNoQuery = await json("/api/users", {}, regA.cookie);
      check("user directory is hidden without a search query",
        usersListNoQuery.response.ok && usersListNoQuery.body?.needsSearch === true &&
        Array.isArray(usersListNoQuery.body?.users) && usersListNoQuery.body.users.length === 0,
        JSON.stringify(usersListNoQuery.body));
      const usersSearch = await json(`/api/users?q=${encodeURIComponent(b)}`, {}, regA.cookie);
      check("user is findable by exact search",
        usersSearch.response.ok && (usersSearch.body?.users || []).some((u) => u.username === b),
        JSON.stringify(usersSearch.body));

      const messageId = dmMessage.body?.message?.id;
      const foreignDelete = await json(`/api/messages?messageId=${messageId}`, { method: "DELETE" }, regB.cookie);
      check("a non-author cannot delete a message", foreignDelete.response.status === 403,
        `HTTP ${foreignDelete.response.status}`);
      const ownDelete = await json(`/api/messages?messageId=${messageId}`, { method: "DELETE" }, regA.cookie);
      check("the author deletes their message", ownDelete.response.ok && ownDelete.body?.deleted === true,
        `HTTP ${ownDelete.response.status} ${JSON.stringify(ownDelete.body)}`);
      const afterDelete = await json(`/api/messages?chatId=${dmId}`, {}, regA.cookie);
      check("deleted message is gone from the timeline",
        (afterDelete.body?.messages || []).every((message) => message.id !== messageId));

      const nonCreatorDelete = await json(`/api/chats/${dmId}`, { method: "DELETE" }, regB.cookie);
      check("a non-creator cannot delete the chat", nonCreatorDelete.response.status === 403,
        `HTTP ${nonCreatorDelete.response.status}`);
      const chatDelete = await json(`/api/chats/${dmId}`, { method: "DELETE" }, regA.cookie);
      check("the creator deletes the direct chat", chatDelete.response.ok && chatDelete.body?.success === true,
        `HTTP ${chatDelete.response.status} ${JSON.stringify(chatDelete.body)}`);
      const bChats = await json("/api/chats", {}, regB.cookie);
      check("the deleted chat is gone for the other participant too",
        (bChats.body?.chats || []).every((chat) => chat.id !== dmId));
    }

    const chats = await json("/api/chats", {}, regA.cookie);
    const general = chats.body?.chats?.find((chat) => chat.isGeneralChat);
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
