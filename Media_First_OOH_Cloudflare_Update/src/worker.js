import { isLargeDecrease, parseSpreadsheetSheets, stableKeyFromRecord } from "./sheets.js";

const SESSION_COOKIE = "mf_ooh_session";
const SESSION_DAYS = 7;
const PASSWORD_ITERATIONS = 600000;
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/gmail.send"
];
const ASSET_HOSTS = new Set([
  "81.162.220.11", "mbuyer.posterscope.com.ua", "booking.outhub.online",
  "drive.google.com", "bma.bigmedia.ua", "hub.megapolis.com.ua",
  "megapolisplus-my.sharepoint.com", "adv-ooh.xyz", "www.google.com",
  "billboards.com.ua", "booking.megapolisplus.com.ua", "tristarplus.com.ua",
  "home.prime-group.com.ua", "i.sv-outdoor.com", "www.outdoorphoto.com.ua",
  "bio-fors.adv.vg", "postimg.cc", "megapolisplusua-my.sharepoint.com",
  "www.rtm.com.ua", "ibb.co"
]);

const enc = (v) => new TextEncoder().encode(String(v));
const dec = (v) => new TextDecoder().decode(v);
const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const toB64 = (bytes) => {
  let out = "";
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < a.length; i += 0x8000) out += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(out);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (s) => toB64(enc(s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const randomToken = (n = 32) => {
  const b = new Uint8Array(n); crypto.getRandomValues(b);
  return toB64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
});
const fail = (message, status = 400) => json({ error: message }, status);
const htmlRedirect = (url) => Response.redirect(url, 302);

async function digest(value) {
  return toB64(await crypto.subtle.digest("SHA-256", enc(value)));
}
function validPasswordMaterial(salt, hash) {
  try { return fromB64(salt).length === 16 && fromB64(hash).length === 32; }
  catch { return false; }
}
async function verifyLoginProof(derivedHash, nonce, email, proof) {
  const key = await crypto.subtle.importKey("raw", fromB64(derivedHash), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, fromB64(proof), enc(`${nonce}|${email}`));
}
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}
function cookieHeader(value, maxAge = SESSION_DAYS * 86400) {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
async function bodyJson(request) {
  try { return await request.json(); } catch { return null; }
}
function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}
async function currentUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await digest(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.role FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_at>? LIMIT 1`
  ).bind(tokenHash, nowIso()).first();
  return row || null;
}
function requireRole(user, role = "user") {
  if (!user) return fail("Потрібно увійти в систему.", 401);
  if (role === "admin" && user.role !== "admin") return fail("Недостатньо прав. Ця дія доступна адміністратору.", 403);
  return null;
}
async function createSession(env, userId) {
  const token = randomToken();
  const expiry = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)")
    .bind(await digest(token), userId, expiry, nowIso()).run();
  return token;
}
async function encryptSecret(secret, keyText) {
  const keyBytes = await crypto.subtle.digest("SHA-256", enc(keyText));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12); crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc(secret));
  return `${toB64(iv)}.${toB64(ciphertext)}`;
}
async function decryptSecret(value, keyText) {
  const [ivText, dataText] = value.split(".");
  const keyBytes = await crypto.subtle.digest("SHA-256", enc(keyText));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  return dec(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(ivText) }, key, fromB64(dataText)));
}
async function googleAccessToken(env, userId) {
  const connection = await env.DB.prepare("SELECT * FROM google_connections WHERE user_id=?").bind(userId).first();
  if (!connection) throw new Error("Не підключено Google-акаунт адміністратора.");
  const refreshToken = await decryptSecret(connection.refresh_token_enc, env.TOKEN_ENCRYPTION_KEY);
  const form = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description || payload.error || "Google access token refresh failed");
  return payload.access_token;
}
function quoteSheetTitle(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}
function columnName(number) {
  let n = Math.max(1, Number(number) || 1), out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
async function readSpreadsheet(env, userId) {
  if (!env.GOOGLE_SHEET_ID) throw new Error("Не задано GOOGLE_SHEET_ID.");
  const token = await googleAccessToken(env, userId);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEET_ID)}`;
  const headers = { authorization: `Bearer ${token}` };

  // First discover every tab, including hidden tabs. Hidden data tabs are still
  // legitimate inventory sources; the layer registry controls presentation.
  const metadataUrl = new URL(base);
  metadataUrl.searchParams.set("fields", "sheets(properties(sheetId,title,hidden))");
  const metaRes = await fetch(metadataUrl, { headers });
  const meta = await metaRes.json();
  if (!metaRes.ok) throw new Error(meta.error?.message || "Не вдалося отримати список вкладок Google Sheets.");
  const sheetDefs = (meta.sheets || []).filter((s) => s.properties?.title);
  if (!sheetDefs.length) throw new Error("У Google Sheets не знайдено вкладок.");

  // Values API returns only the populated matrix (rather than the full default
  // 1,000 x 26 grid). This keeps larger workbooks inside API/Worker limits.
  const valuesUrl = new URL(`${base}/values:batchGet`);
  valuesUrl.searchParams.set("valueRenderOption", "FORMULA");
  valuesUrl.searchParams.set("majorDimension", "ROWS");
  for (const sheet of sheetDefs) valuesUrl.searchParams.append("ranges", `${quoteSheetTitle(sheet.properties.title)}!A:ZZ`);
  const valuesRes = await fetch(valuesUrl, { headers });
  const valuesPayload = await valuesRes.json();
  if (!valuesRes.ok) throw new Error(valuesPayload.error?.message || "Не вдалося визначити фактично заповнені діапазони Google Sheets.");

  const populated = (valuesPayload.valueRanges || []).map((range, index) => {
    const rows = range.values || [];
    const columns = Math.max(0, ...rows.map((row) => row.length));
    return { sheet: sheetDefs[index], rows: rows.length, columns };
  }).filter((x) => x.rows && x.columns);
  if (!populated.length) throw new Error("У Google Sheets немає заповнених вкладок. Інвентар не змінено.");

  // Fetch rich cell metadata only for used ranges so HYPERLINK formulas and
  // rich-text links (photo/scheme) remain available to the parser.
  const gridUrl = new URL(base);
  gridUrl.searchParams.set("includeGridData", "true");
  for (const entry of populated) {
    const title = entry.sheet.properties.title;
    gridUrl.searchParams.append("ranges", `${quoteSheetTitle(title)}!A1:${columnName(entry.columns)}${entry.rows}`);
  }
  gridUrl.searchParams.set("fields", "sheets(properties(sheetId,title,hidden),data(rowData(values(userEnteredValue,effectiveValue,formattedValue,hyperlink,textFormatRuns(format(link(uri)))))))");
  const gridRes = await fetch(gridUrl, { headers });
  const gridPayload = await gridRes.json();
  if (!gridRes.ok) throw new Error(gridPayload.error?.message || "Не вдалося прочитати вміст Google Sheets.");
  const parsed = parseSpreadsheetSheets(gridPayload.sheets || []);
  if (!parsed.records.length) throw new Error("Не знайдено жодної вкладки з колонками Місто, Широта та Довгота і валідними об'єктами. Інвентар не змінено.");
  if (parsed.records.length > 1000) throw new Error(`Знайдено ${parsed.records.length} об’єктів. Для Cloudflare Workers Free наразі встановлено обережний ліміт 1 000 об’єктів на одну синхронізацію через 10 ms CPU на Cron/запит. Дані не змінено. Якщо інвентар зросте вище, потрібно буде перейти на пакетний механізм або Workers Paid.`);
  return parsed;
}
async function stableInventoryId(stableKey) {
  // The stable key is already namespaced by source sheet and identity value.
  // Keeping it directly avoids per-row hashing work during large sync runs.
  return `ooh:${stableKey}`;
}
async function addSyncRun(env, source) {
  const id = uid();
  await env.DB.prepare("INSERT INTO sync_runs(id,source,status,started_at) VALUES(?,?,?,?)")
    .bind(id, source, "running", nowIso()).run();
  return id;
}
async function finishSyncRun(env, id, { status, records = 0, layers = 0, message = null }) {
  await env.DB.prepare("UPDATE sync_runs SET status=?,completed_at=?,records_count=?,layers_count=?,message=? WHERE id=?")
    .bind(status, nowIso(), records, layers, message, id).run();
}
function inventoryValues(x, stamp) {
  return [x._id, x._stable_key, x._layer, x._city, x._campaign, x._partner, x._adformat, x._type,
    x._title, x._lat, x._lon, x._photo, x._scheme, x._source_sheet, x._row, JSON.stringify(x), stamp];
}

async function previewSync(env, parsed) {
  const [old, oldLayersResult] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM inventory").first(),
    env.DB.prepare("SELECT source_sheet,COUNT(*) AS n FROM inventory GROUP BY source_sheet").all()
  ]);
  const previousCount = Number(old?.n || 0);
  const nextCount = parsed.records.length;
  const newBySheet = new Map();
  for (const record of parsed.records) newBySheet.set(record._source_sheet, (newBySheet.get(record._source_sheet) || 0) + 1);
  const oldBySheet = new Map((oldLayersResult.results || []).map((r) => [r.source_sheet, Number(r.n || 0)]));
  const layerChanges = [...oldBySheet].map(([sourceSheet, before]) => {
    const after = newBySheet.get(sourceSheet) || 0;
    return { sourceSheet, previousCount: before, nextCount: after, removed: after === 0, requiresConfirmation: before > 0 && isLargeDecrease(before, after) };
  }).filter((x) => x.requiresConfirmation);
  const totalDrop = previousCount > 0 && isLargeDecrease(previousCount, nextCount);
  const requiresConfirmation = totalDrop || layerChanges.length > 0;
  return {
    preview: true,
    previousCount,
    count: nextCount,
    layers: parsed.layers.map((l) => ({ key: l.key, name: l.name, sourceSheet: l.sourceSheet, count: l.count })),
    warnings: parsed.warnings,
    layerChanges,
    requiresConfirmation,
    reductionPercent: previousCount ? Math.round((1 - nextCount / previousCount) * 100) : 0
  };
}
async function replaceInventory(env, parsed) {
  const { records, layers } = parsed;
  if (!records.length) throw new Error("Порожній інвентар не можна застосувати.");
  if (new Set(records.map((x) => x._stable_key)).size !== records.length) throw new Error("У новому інвентарі є повторювані стабільні ID. Дані не змінено.");
  if (new Set(layers.map((x) => x.key)).size !== layers.length || new Set(layers.map((x) => x.sourceSheet)).size !== layers.length) {
    throw new Error("Ключі шарів або назви вкладок дублюються. Дані не змінено.");
  }

  const existing = await env.DB.prepare("SELECT id,stable_key,data_json FROM inventory").all();
  const oldIdsByKey = new Map();
  for (const row of existing.results || []) {
    let oldRecord = {};
    try { oldRecord = JSON.parse(row.data_json || "{}"); } catch {}
    const key = row.stable_key || stableKeyFromRecord(oldRecord);
    if (key && !oldIdsByKey.has(key)) oldIdsByKey.set(key, row.id);
  }
  for (const item of records) item._id = oldIdsByKey.get(item._stable_key) || await stableInventoryId(item._stable_key);
  if (new Set(records.map((x) => x._id)).size !== records.length) throw new Error("Не вдалося сформувати унікальні ID об'єктів. Дані не змінено.");

  const stamp = nowIso();
  // Clear only staging tables. The active inventory and layers remain untouched.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM inventory_sync_stage"),
    env.DB.prepare("DELETE FROM inventory_layers_stage")
  ]);

  const stageInsert = `INSERT INTO inventory_sync_stage(id,stable_key,layer,city,campaign,partner,ad_format,media_type,title,latitude,longitude,photo_url,scheme_url,source_sheet,source_row,data_json,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  for (let i = 0; i < records.length; i += 50) {
    const batch = records.slice(i, i + 50).map((x) => env.DB.prepare(stageInsert).bind(...inventoryValues(x, stamp)));
    await env.DB.batch(batch);
  }
  const stageLayerInsert = `INSERT INTO inventory_layers_stage(layer_key,source_sheet,display_name,color,marker_shape,marker_label,kind,sort_order,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`;
  for (let i = 0; i < layers.length; i += 50) {
    const batch = layers.slice(i, i + 50).map((layer) => env.DB.prepare(stageLayerInsert).bind(
      layer.key, layer.sourceSheet, layer.name, layer.color, layer.shape, layer.label || "", layer.kind || "media", layer.sort || 100, stamp
    ));
    await env.DB.batch(batch);
  }

  const [stagedInventory, stagedLayers] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM inventory_sync_stage").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM inventory_layers_stage").first()
  ]);
  if (Number(stagedInventory?.n || 0) !== records.length || Number(stagedLayers?.n || 0) !== layers.length) {
    throw new Error("Не вдалося повністю підготувати новий інвентар і шари. Попередні дані збережено.");
  }

  // D1 batch is transactional: all active tables swap together or none do.
  // If any INSERT fails, D1 rolls back the preceding DELETE operations.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM inventory"),
    env.DB.prepare(`INSERT INTO inventory(id,stable_key,layer,city,campaign,partner,ad_format,media_type,title,latitude,longitude,photo_url,scheme_url,source_sheet,source_row,data_json,updated_at)
      SELECT id,stable_key,layer,city,campaign,partner,ad_format,media_type,title,latitude,longitude,photo_url,scheme_url,source_sheet,source_row,data_json,updated_at FROM inventory_sync_stage`),
    env.DB.prepare("DELETE FROM inventory_layers"),
    env.DB.prepare(`INSERT INTO inventory_layers(layer_key,source_sheet,display_name,color,marker_shape,marker_label,kind,sort_order,updated_at)
      SELECT layer_key,source_sheet,display_name,color,marker_shape,marker_label,kind,sort_order,updated_at FROM inventory_layers_stage`),
    env.DB.prepare("DELETE FROM inventory_sync_stage"),
    env.DB.prepare("DELETE FROM inventory_layers_stage")
  ]);

  const [activeInventory, activeLayers] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM inventory").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM inventory_layers").first()
  ]);
  if (Number(activeInventory?.n || 0) !== records.length || Number(activeLayers?.n || 0) !== layers.length) {
    throw new Error("Після атомарного оновлення кількість записів не збігається з підготовленою. Перевір D1 перед наступною синхронізацією.");
  }
  return { count: records.length, layers: layers.length, updatedAt: stamp, warnings: parsed.warnings };
}
async function syncGoogleSheet(env, userId, options = {}) {
  const parsed = await readSpreadsheet(env, userId);
  const preview = await previewSync(env, parsed);
  if (options.preview) return preview;
  if (preview.requiresConfirmation && !options.confirmLargeDecrease) {
    const error = new Error(`Увага: кількість об'єктів зменшилася з ${preview.previousCount} до ${preview.count} (${preview.reductionPercent}%). Підтверди ручну синхронізацію, щоб застосувати це скорочення. Автоматична синхронізація залишить попередні дані.`);
    error.code = "LARGE_INVENTORY_DECREASE";
    error.preview = preview;
    throw error;
  }
  const runId = await addSyncRun(env, options.source || "manual");
  try {
    const result = await replaceInventory(env, parsed);
    await finishSyncRun(env, runId, { status: "success", records: result.count, layers: result.layers, message: result.warnings.join(" | ") || null });
    return result;
  } catch (error) {
    await finishSyncRun(env, runId, { status: "failed", records: 0, layers: 0, message: String(error?.message || error).slice(0, 1000) });
    error.syncLogged = true;
    throw error;
  }
}
function emailSubject(subject) { return `=?UTF-8?B?${toB64(enc(subject))}?=`; }
function base64UrlBytes(bytes) { return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
async function sendGmail(env, userId, { to, subject, body, filename, fileBase64 }) {
  const token = await googleAccessToken(env, userId);
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "OOH_program.xlsx";
  const boundary = `mf_${randomToken(12)}`;
  const textBase64 = toB64(enc(body));
  const mime = [
    `To: ${to}`,
    `Subject: ${emailSubject(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    textBase64,
    `--${boundary}`,
    `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name=\"${safeName}\"`,
    `Content-Disposition: attachment; filename=\"${safeName}\"`,
    "Content-Transfer-Encoding: base64",
    "",
    fileBase64.match(/.{1,76}/g)?.join("\r\n") || fileBase64,
    `--${boundary}--`, ""
  ].join("\r\n");
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: base64UrlBytes(enc(mime)) })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "Gmail не прийняв лист.");
  return payload;
}

async function sendGmailText(env, userId, to, subject, body) {
  const token = await googleAccessToken(env, userId);
  const mime = [
    `To: ${to}`,
    `Subject: ${emailSubject(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    toB64(enc(body))
  ].join("\r\n");
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: base64UrlBytes(enc(mime)) })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "Gmail не прийняв тестовий лист.");
  return payload;
}

async function adminUsers(request, env, user, url) {
  const denied = requireRole(user, "admin"); if (denied) return denied;
  if (request.method === "GET") {
    const { results = [] } = await env.DB.prepare("SELECT id,email,role,created_at FROM users ORDER BY created_at").all();
    return json({ users: results });
  }
  if (request.method === "POST") {
    const b = await bodyJson(request);
    const email = String(b?.email || "").trim().toLowerCase();
    const salt = String(b?.passwordSalt || "");
    const hash = String(b?.passwordHash || "");
    const role = b?.role === "admin" ? "admin" : "user";
    if (!/^\S+@\S+\.\S+$/.test(email)) return fail("Вкажи коректний email.");
    if (!validPasswordMaterial(salt, hash)) return fail("Не вдалося сформувати безпечний пароль. Спробуй ще раз.");
    const existing = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    if (existing) return fail("Користувач із таким email уже існує.", 409);
    const id = uid();
    try {
      await env.DB.prepare("INSERT INTO users(id,email,password_salt,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .bind(id, email, salt, hash, role, nowIso(), nowIso()).run();
    } catch { return fail("Не вдалося створити користувача. Перевір, чи немає дубля email.", 409); }
    return json({ user: { id, email, role } }, 201);
  }
  if (request.method === "PUT") {
    const b = await bodyJson(request);
    const id = String(b?.id || "");
    const role = b?.role === "admin" ? "admin" : "user";
    if (!id || id === user.id) return fail("Не можна змінити власну роль із цієї форми.");
    const target = await env.DB.prepare("SELECT role FROM users WHERE id=?").bind(id).first();
    if (!target) return fail("Користувача не знайдено.", 404);
    if (target.role === "admin" && role !== "admin") {
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").first();
      if (Number(count?.n || 0) <= 1) return fail("У системі має залишитися хоча б один адміністратор.");
    }
    await env.DB.prepare("UPDATE users SET role=?,updated_at=? WHERE id=?").bind(role, nowIso(), id).run();
    return json({ ok: true });
  }
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id || id === user.id) return fail("Не можна видалити поточний акаунт.");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").first();
    const target = await env.DB.prepare("SELECT role FROM users WHERE id=?").bind(id).first();
    if (!target) return fail("Користувача не знайдено.", 404);
    if (target.role === "admin" && Number(count?.n || 0) <= 1) return fail("У системі має залишитися хоча б один адміністратор.");
    await env.DB.prepare("DELETE FROM users WHERE id=?").bind(id).run();
    return json({ ok: true });
  }
  return fail("Method not allowed", 405);
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method !== "GET" && !sameOrigin(request)) return fail("Cross-origin request blocked.", 403);

  if (path === "/api/health" && request.method === "GET") return json({ ok: true, service: "media-first-ooh", time: nowIso() });
  if (path === "/api/auth/status" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    return json({ hasUsers: Number(row?.n || 0) > 0, bootstrapEnabled: Boolean(env.BOOTSTRAP_TOKEN) });
  }
  if (path === "/api/auth/bootstrap" && request.method === "POST") {
    if (!env.BOOTSTRAP_TOKEN) return fail("Перший запуск не налаштовано: відсутній BOOTSTRAP_TOKEN.", 503);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    if (Number(count?.n || 0) > 0) return fail("Початкового адміністратора вже створено.", 409);
    const b = await bodyJson(request);
    if (!constantTimeEqual(String(b?.bootstrapToken || ""), env.BOOTSTRAP_TOKEN)) return fail("Неправильний код першого запуску.", 403);
    const email = String(b?.email || "").trim().toLowerCase();
    const salt = String(b?.passwordSalt || ""); const hash = String(b?.passwordHash || "");
    if (!/^\S+@\S+\.\S+$/.test(email)) return fail("Вкажи коректний email.");
    if (!validPasswordMaterial(salt, hash)) return fail("Не вдалося сформувати безпечний пароль. Спробуй ще раз.");
    const id = uid();
    await env.DB.prepare("INSERT INTO users(id,email,password_salt,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .bind(id, email, salt, hash, "admin", nowIso(), nowIso()).run();
    const session = await createSession(env, id);
    return json({ user: { id, email, role: "admin" } }, 201, { "set-cookie": cookieHeader(session) });
  }
  if (path === "/api/auth/challenge" && request.method === "POST") {
    const b = await bodyJson(request);
    const email = String(b?.email || "").trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return fail("Вкажи коректний email.");
    const account = await env.DB.prepare("SELECT id,password_salt FROM users WHERE email=?").bind(email).first();
    const saltBytes = new Uint8Array(16); crypto.getRandomValues(saltBytes);
    const salt = account?.password_salt || toB64(saltBytes);
    const nonce = randomToken(24);
    await env.DB.prepare("DELETE FROM login_challenges WHERE expires_at<=?").bind(nowIso()).run();
    await env.DB.prepare("INSERT INTO login_challenges(nonce,user_id,email,salt,expires_at) VALUES(?,?,?,?,?)")
      .bind(nonce, account?.id || null, email, salt, new Date(Date.now() + 5 * 60 * 1000).toISOString()).run();
    return json({ salt, nonce, iterations: PASSWORD_ITERATIONS });
  }
  if (path === "/api/auth/login" && request.method === "POST") {
    const b = await bodyJson(request);
    const email = String(b?.email || "").trim().toLowerCase();
    const nonce = String(b?.nonce || ""); const proof = String(b?.proof || "");
    const challenge = await env.DB.prepare("SELECT * FROM login_challenges WHERE nonce=? AND expires_at>? LIMIT 1").bind(nonce, nowIso()).first();
    if (challenge) await env.DB.prepare("DELETE FROM login_challenges WHERE nonce=?").bind(nonce).run();
    if (!challenge || challenge.email !== email || !challenge.user_id || !/^[A-Za-z0-9+/]+=*$/.test(proof)) return fail("Неправильний email або пароль.", 401);
    const user = await env.DB.prepare("SELECT * FROM users WHERE id=? AND email=?").bind(challenge.user_id, email).first();
    if (!user || !await verifyLoginProof(user.password_hash, nonce, email, proof)) return fail("Неправильний email або пароль.", 401);
    const session = await createSession(env, user.id);
    return json({ user: { id: user.id, email: user.email, role: user.role } }, 200, { "set-cookie": cookieHeader(session) });
  }
  if (path === "/api/auth/logout" && request.method === "POST") {
    const token = getCookie(request, SESSION_COOKIE);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await digest(token)).run();
    return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
  }
  if (path === "/api/me" && request.method === "GET") {
    const user = await currentUser(request, env); const denied = requireRole(user); if (denied) return denied;
    return json({ user });
  }

  if (path === "/api/google/callback" && request.method === "GET") {
    const state = url.searchParams.get("state"); const code = url.searchParams.get("code");
    if (url.searchParams.get("error")) return htmlRedirect(`${url.origin}/?google=error`);
    if (!state || !code || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.TOKEN_ENCRYPTION_KEY) return htmlRedirect(`${url.origin}/?google=setup-error`);
    const stateRow = await env.DB.prepare("SELECT * FROM oauth_states WHERE state=? AND expires_at>? LIMIT 1").bind(state, nowIso()).first();
    if (!stateRow) return htmlRedirect(`${url.origin}/?google=state-error`);
    await env.DB.prepare("DELETE FROM oauth_states WHERE state=?").bind(state).run();
    const redirectUri = `${url.origin}/api/google/callback`;
    const form = new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code" });
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) return htmlRedirect(`${url.origin}/?google=token-error`);
    const infoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { authorization: `Bearer ${tokenData.access_token}` } });
    const info = await infoRes.json();
    let refresh = tokenData.refresh_token;
    if (!refresh) {
      const existing = await env.DB.prepare("SELECT refresh_token_enc FROM google_connections WHERE user_id=?").bind(stateRow.user_id).first();
      if (existing) refresh = await decryptSecret(existing.refresh_token_enc, env.TOKEN_ENCRYPTION_KEY);
    }
    if (!refresh) return htmlRedirect(`${url.origin}/?google=missing-refresh-token`);
    const encrypted = await encryptSecret(refresh, env.TOKEN_ENCRYPTION_KEY);
    await env.DB.prepare(
      `INSERT INTO google_connections(user_id,google_email,refresh_token_enc,scopes,connected_at,updated_at)
       VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET google_email=excluded.google_email,refresh_token_enc=excluded.refresh_token_enc,scopes=excluded.scopes,updated_at=excluded.updated_at`
    ).bind(stateRow.user_id, info.email || "Google account", encrypted, GOOGLE_SCOPES.join(" "), nowIso(), nowIso()).run();
    return htmlRedirect(`${url.origin}/?google=connected`);
  }

  const user = await currentUser(request, env);
  if (path === "/api/inventory" && request.method === "GET") {
    const denied = requireRole(user); if (denied) return denied;
    const [inventoryResult, layerResult, revisionResult] = await Promise.all([
      env.DB.prepare("SELECT data_json FROM inventory ORDER BY source_sheet,source_row").all(),
      env.DB.prepare("SELECT layer_key AS key,source_sheet AS sourceSheet,display_name AS name,color,marker_shape AS shape,marker_label AS label,kind,sort_order AS sort FROM inventory_layers ORDER BY sort_order,display_name").all(),
      env.DB.prepare("SELECT COUNT(*) AS count,COALESCE(MAX(updated_at),'') AS revision FROM inventory").first()
    ]);
    const records = (inventoryResult.results || []).map((r) => { try { return JSON.parse(r.data_json); } catch { return null; } }).filter(Boolean);
    let layers = layerResult.results || [];
    if (!layers.length && records.length) {
      const byKey = new Map();
      for (const r of records) if (!byKey.has(r._layer)) byKey.set(r._layer, { key: r._layer, sourceSheet: r._source_sheet, name: r._layer_name || r._layer, color: r._layer_color || (r._layer === "promo" ? "#005EFF" : r._layer === "local" ? "#25FF08" : "#B5232F"), shape: r._marker_shape || (r._layer === "local" ? "diamond" : "circle"), label: r._marker_label || (r._layer === "restaurant" ? "KFC" : ""), kind: r._layer_kind || (r._layer === "restaurant" ? "restaurant" : "media"), sort: 100 });
      layers = [...byKey.values()];
    }
    return json({ records, layers, revision: revisionResult?.revision || "", count: Number(revisionResult?.count || 0) });
  }
  if (path === "/api/selection" && request.method === "GET") {
    const denied = requireRole(user); if (denied) return denied;
    const row = await env.DB.prepare("SELECT board_ids_json FROM user_selections WHERE user_id=?").bind(user.id).first();
    let ids = []; try { ids = JSON.parse(row?.board_ids_json || "[]"); } catch {}
    return json({ ids: Array.isArray(ids) ? ids : [] });
  }
  if (path === "/api/selection" && request.method === "PUT") {
    const denied = requireRole(user); if (denied) return denied;
    const b = await bodyJson(request); const ids = [...new Set((Array.isArray(b?.ids) ? b.ids : []).filter((x) => typeof x === "string" && x.length < 2000))].slice(0, 1000);
    await env.DB.prepare(
      `INSERT INTO user_selections(user_id,board_ids_json,updated_at) VALUES(?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET board_ids_json=excluded.board_ids_json,updated_at=excluded.updated_at`
    ).bind(user.id, JSON.stringify(ids), nowIso()).run();
    return json({ ok: true, count: ids.length });
  }
  if (path === "/api/programs" && request.method === "GET") {
    const denied = requireRole(user); if (denied) return denied;
    const { results = [] } = await env.DB.prepare("SELECT id,name,board_ids_json,created_at,updated_at FROM saved_programs WHERE user_id=? ORDER BY updated_at DESC LIMIT 100").bind(user.id).all();
    return json({ programs: results.map((p) => ({ id: p.id, name: p.name, ids: JSON.parse(p.board_ids_json || "[]"), createdAt: p.created_at, updatedAt: p.updated_at })) });
  }
  if (path === "/api/programs" && request.method === "POST") {
    const denied = requireRole(user); if (denied) return denied;
    const b = await bodyJson(request); const name = String(b?.name || "Адресна програма").trim().slice(0, 120);
    const ids = [...new Set((Array.isArray(b?.ids) ? b.ids : []).filter((x) => typeof x === "string" && x.length < 2000))].slice(0, 1000);
    if (!ids.length) return fail("Немає вибраних площин.");
    const id = uid(); const stamp = nowIso();
    await env.DB.prepare("INSERT INTO saved_programs(id,user_id,name,board_ids_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .bind(id, user.id, name, JSON.stringify(ids), stamp, stamp).run();
    return json({ program: { id, name, ids, createdAt: stamp, updatedAt: stamp } }, 201);
  }
  if (path === "/api/programs/send" && request.method === "POST") {
    const denied = requireRole(user); if (denied) return denied;
    const b = await bodyJson(request);
    const to = String(b?.to || "").trim(); const filename = String(b?.filename || "OOH_program.xlsx");
    const fileBase64 = String(b?.fileBase64 || "").replace(/\s/g, "");
    const count = Number(b?.count || 0); const budget = Number(b?.budget || 0);
    if (!/^\S+@\S+\.\S+$/.test(to)) return fail("Вкажи коректний email отримувача.");
    if (fileBase64.length < 100 || fileBase64.length > 8_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(fileBase64)) return fail("Excel-вкладення порожнє або завелике (максимум близько 6 MB).");
    const subject = String(b?.subject || "OOH адресна програма").slice(0, 180);
    const body = `Вітаю!\n\nНадсилаю адресну програму Media First OOH.\nПлощин: ${count}.\nБюджет: ${Math.round(budget).toLocaleString("uk-UA")} UAH Net.\n\nExcel-файл додається до листа.`;
    try {
      const sender = await env.DB.prepare("SELECT gc.user_id FROM google_connections gc JOIN users u ON u.id=gc.user_id WHERE u.role='admin' ORDER BY gc.connected_at LIMIT 1").first();
      if (!sender) return fail("Адміністратор має спочатку підключити Gmail у платформі.", 409);
      const sent = await sendGmail(env, sender.user_id, { to, subject, body, filename, fileBase64 });
      await env.DB.prepare("INSERT INTO email_log(id,user_id,recipient,subject,filename,sent_at,provider_message_id) VALUES(?,?,?,?,?,?,?)")
        .bind(uid(), user.id, to, subject, filename, nowIso(), sent.id || null).run();
      return json({ ok: true, messageId: sent.id || null });
    } catch (e) { return fail(`Не вдалося відправити лист: ${e.message}`, 502); }
  }
  if (path === "/api/admin/users") return adminUsers(request, env, user, url);
  if (path === "/api/google/connect" && request.method === "GET") {
    const denied = requireRole(user, "admin"); if (denied) return denied;
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.TOKEN_ENCRYPTION_KEY) return fail("Спочатку додай GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET і TOKEN_ENCRYPTION_KEY у Cloudflare Worker Secrets.", 503);
    const state = randomToken();
    await env.DB.prepare("INSERT INTO oauth_states(state,user_id,expires_at) VALUES(?,?,?)").bind(state, user.id, new Date(Date.now() + 10 * 60 * 1000).toISOString()).run();
    const redirectUri = `${url.origin}/api/google/callback`;
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: GOOGLE_SCOPES.join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true", state }).toString();
    return htmlRedirect(auth.toString());
  }
  if (path === "/api/google/status" && request.method === "GET") {
    const denied = requireRole(user, "admin"); if (denied) return denied;
    const own = await env.DB.prepare("SELECT google_email,connected_at FROM google_connections WHERE user_id=?").bind(user.id).first();
    const any = own || await env.DB.prepare("SELECT gc.google_email,gc.connected_at FROM google_connections gc JOIN users u ON u.id=gc.user_id WHERE u.role='admin' ORDER BY gc.connected_at LIMIT 1").first();
    const lastSync = await env.DB.prepare("SELECT status,completed_at,records_count,layers_count,message,source FROM sync_runs ORDER BY started_at DESC LIMIT 1").first();
    return json({ connected: Boolean(any), connectedToCurrentUser: Boolean(own), email: any?.google_email || null, connectedAt: any?.connected_at || null, sheetConfigured: Boolean(env.GOOGLE_SHEET_ID), lastSync: lastSync || null });
  }
  if (path === "/api/google/test-email" && request.method === "POST") {
    const denied = requireRole(user, "admin"); if (denied) return denied;
    const connection = await env.DB.prepare("SELECT google_email FROM google_connections WHERE user_id=?").bind(user.id).first();
    if (!connection) return fail("Спочатку підключи Google-акаунт цього адміністратора.", 409);
    try {
      const sent = await sendGmailText(env, user.id, connection.google_email, "Тест Media First OOH Platform", "Вітаємо!\n\nЦе тестове повідомлення перевірки Gmail API для Media First OOH Platform.\n\nЯкщо ти отримала цей лист, надсилання з платформи налаштовано.");
      await env.DB.prepare("INSERT INTO email_log(id,user_id,recipient,subject,filename,sent_at,provider_message_id) VALUES(?,?,?,?,?,?,?)")
        .bind(uid(), user.id, connection.google_email, "Тест Media First OOH Platform", "TEST", nowIso(), sent.id || null).run();
      return json({ ok: true, recipient: connection.google_email, messageId: sent.id || null });
    } catch (e) { return fail(`Не вдалося надіслати тестовий лист: ${e.message}`, 502); }
  }
  if (path === "/api/google/sync" && request.method === "POST") {
    const denied = requireRole(user, "admin"); if (denied) return denied;
    try {
      const connection = await env.DB.prepare("SELECT user_id FROM google_connections WHERE user_id=?").bind(user.id).first()
        || await env.DB.prepare("SELECT gc.user_id FROM google_connections gc JOIN users u ON u.id=gc.user_id WHERE u.role='admin' ORDER BY gc.connected_at LIMIT 1").first();
      if (!connection) return fail("Адміністратор має спочатку підключити Google.", 409);
      const body = await bodyJson(request) || {};
      const result = await syncGoogleSheet(env, connection.user_id, { preview: body.preview === true, confirmLargeDecrease: body.confirmLargeDecrease === true, source: "manual" });
      return json(result);
    } catch (e) {
      const status = e?.code === "LARGE_INVENTORY_DECREASE" ? 409 : 502;
      return json({ error: `Помилка синхронізації Google Sheets: ${e.message}`, code: e?.code || "SYNC_FAILED", preview: e?.preview || null }, status);
    }
  }
  if (path === "/api/assets/proxy" && request.method === "GET") {
    const denied = requireRole(user); if (denied) return denied;
    return proxyAsset(url, env);
  }
  if (path.startsWith("/api/")) return fail("API route not found", 404);
  return env.ASSETS.fetch(request);
}

function decodeHtml(s) {
  return String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function allowedAssetUrl(value) {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.toLowerCase();
    if (!ASSET_HOSTS.has(host) && !host.endsWith(".sharepoint.com") && !host.endsWith(".googleusercontent.com")) return null;
    return u;
  } catch { return null; }
}
async function fetchAllowedAsset(initialUrl, accept = "image/*,*/*;q=0.8") {
  let current = new URL(initialUrl);
  for (let attempt = 0; attempt < 6; attempt++) {
    if (!allowedAssetUrl(current.toString())) throw new Error("Redirect target is not allowlisted");
    const response = await fetch(current.toString(), { redirect: "manual", headers: {
      "user-agent": "Mozilla/5.0 MediaFirstOOHPreview/1.0", accept
    } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Partner redirect has no Location header");
      current = new URL(location, current);
      continue;
    }
    return { response, finalUrl: current.toString() };
  }
  throw new Error("Too many partner redirects");
}
async function proxyAsset(url, env) {
  const target = url.searchParams.get("url");
  let parsed = allowedAssetUrl(target || "");
  if (!parsed) return fail("Посилання відсутнє або домен не входить до дозволеного списку.", 400);
  if (parsed.hostname === "drive.google.com") {
    const id = parsed.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || parsed.searchParams.get("id");
    if (id) parsed = new URL(`https://drive.google.com/uc?export=view&id=${encodeURIComponent(id)}`);
  }
  const keyHash = await digest(parsed.toString());
  const cacheKey = `previews/${keyHash.replace(/[^A-Za-z0-9]/g, "").slice(0, 48)}`;
  if (env.ASSETS_BUCKET) {
    const cached = await env.ASSETS_BUCKET.get(cacheKey);
    if (cached) return new Response(cached.body, { headers: { "content-type": cached.httpMetadata?.contentType || "image/jpeg", "cache-control": "private, max-age=86400", "x-ooh-preview": "cache" } });
  }
  try {
    let fetched = await fetchAllowedAsset(parsed.toString(), "image/avif,image/webp,image/apng,image/*,*/*;q=0.8");
    let response = fetched.response;
    if (!response.ok) return new Response("Preview unavailable", { status: 404 });
    let type = response.headers.get("content-type") || "";
    if (!type.toLowerCase().startsWith("image/")) {
      const length = Number(response.headers.get("content-length") || 0);
      if (length > 2_000_000) return new Response("Preview page too large", { status: 413 });
      const html = (await response.text()).slice(0, 2_000_000);
      const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
      let imageUrl = null;
      for (const tag of metas) {
        const name = tag.match(/(?:property|name)=["'](?:og:image|twitter:image)["']/i);
        const content = tag.match(/content=["']([^"']+)["']/i);
        if (name && content) { imageUrl = decodeHtml(content[1]); break; }
      }
      if (!imageUrl) {
        const img = html.match(/<img\b[^>]*src=["']([^"']+)["']/i);
        if (img) imageUrl = decodeHtml(img[1]);
      }
      if (!imageUrl) return new Response("No preview image on partner page", { status: 404 });
      const resolved = allowedAssetUrl(new URL(imageUrl, fetched.finalUrl).toString());
      if (!resolved) return new Response("Preview image host is not allowed", { status: 403 });
      fetched = await fetchAllowedAsset(resolved.toString(), "image/*");
      response = fetched.response;
      if (!response.ok) return new Response("Image fetch failed", { status: 404 });
      type = response.headers.get("content-type") || "";
    }
    if (!type.toLowerCase().startsWith("image/")) return new Response("Source did not return an image", { status: 415 });
    const buf = await response.arrayBuffer();
    if (buf.byteLength > 8_000_000) return new Response("Image too large", { status: 413 });
    if (env.ASSETS_BUCKET) await env.ASSETS_BUCKET.put(cacheKey, buf, { httpMetadata: { contentType: type, cacheControl: "public, max-age=86400" } });
    return new Response(buf, { headers: { "content-type": type, "cache-control": "private, max-age=86400", "x-ooh-preview": "source" } });
  } catch { return new Response("Partner preview unavailable", { status: 502 }); }
}

async function scheduledHandler(env) {
  const admin = await env.DB.prepare("SELECT gc.user_id FROM google_connections gc JOIN users u ON u.id=gc.user_id WHERE u.role='admin' ORDER BY gc.connected_at LIMIT 1").first();
  if (!admin) return;
  try {
    const result = await syncGoogleSheet(env, admin.user_id, { source: "cron", confirmLargeDecrease: false });
    console.log("Scheduled Google Sheets sync completed:", result.count, result.layers);
  } catch (e) {
    if (!e?.syncLogged) {
      const runId = await addSyncRun(env, "cron").catch(() => null);
      if (runId) await finishSyncRun(env, runId, { status: "failed", message: String(e?.message || e).slice(0, 1000) }).catch(() => {});
    }
    console.error("Scheduled Google Sheets sync failed; previous inventory retained:", e?.message || e);
  }
}

export default {
  async fetch(request, env, ctx) {
    try { return await handleApi(request, env, ctx); }
    catch (error) {
      console.error("Worker error:", error?.stack || error);
      if (new URL(request.url).pathname.startsWith("/api/")) return fail("Внутрішня помилка сервера. Перевір Cloudflare Worker logs.", 500);
      return new Response("Internal server error", { status: 500 });
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(scheduledHandler(env));
  }
};
