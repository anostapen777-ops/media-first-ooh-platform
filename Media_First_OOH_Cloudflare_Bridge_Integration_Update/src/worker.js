import { isLargeDecrease, parseSpreadsheetSheets, stableKeyFromRecord } from "./sheets.js";

const SESSION_COOKIE = "mf_ooh_session";
const SESSION_DAYS = 7;
const PASSWORD_ITERATIONS = 600000;
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/drive.file"
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

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
async function getDriveAdminConnection(env, preferredUserId = null) {
  let connection = preferredUserId
    ? await env.DB.prepare("SELECT user_id,scopes FROM google_connections WHERE user_id=?").bind(preferredUserId).first()
    : null;
  if (!connection) connection = await env.DB.prepare(
    "SELECT gc.user_id,gc.scopes FROM google_connections gc JOIN users u ON u.id=gc.user_id WHERE u.role='admin' ORDER BY gc.connected_at LIMIT 1"
  ).first();
  if (!connection) throw new Error("Спочатку підключи Google-акаунт адміністратора.");
  if (!String(connection.scopes || "").split(/\s+/).includes(DRIVE_FILE_SCOPE)) {
    const error = new Error("Потрібно перепідключити Google й надати додатковий дозвіл Google Drive (drive.file). Це дозволить застосунку створювати та керувати лише файлами, які він сам додав у Drive.");
    error.code = "DRIVE_REAUTH_REQUIRED";
    throw error;
  }
  return connection;
}
async function driveApi(token, path, options = {}) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || `Google Drive API помилка ${response.status}`);
  return payload;
}
async function getOrCreateDriveFolder(env, token, settingKey, name, parentId = null) {
  const saved = await env.DB.prepare("SELECT setting_value FROM drive_library_settings WHERE setting_key=?").bind(settingKey).first();
  if (saved?.setting_value) return saved.setting_value;
  const metadata = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) metadata.parents = [parentId];
  const folder = await driveApi(token, "files?fields=id,name,mimeType", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(metadata) });
  if (!folder.id) throw new Error(`Google Drive не повернув ID папки «${name}».`);
  await env.DB.prepare(`INSERT INTO drive_library_settings(setting_key,setting_value,updated_at) VALUES(?,?,?)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at`)
    .bind(settingKey, folder.id, nowIso()).run();
  return folder.id;
}
async function ensureDriveLibraryFolders(env, userId, token) {
  const rootId = await getOrCreateDriveFolder(env, token, "root_folder_id", "Media First OOH Assets");
  const photosId = await getOrCreateDriveFolder(env, token, "photos_folder_id", "Photos", rootId);
  const schemesId = await getOrCreateDriveFolder(env, token, "schemes_folder_id", "Schemes", rootId);
  const unresolvedId = await getOrCreateDriveFolder(env, token, "unresolved_folder_id", "Unresolved", rootId);
  const users = await env.DB.prepare("SELECT email FROM users WHERE email<>''").all();
  const shareWarnings = [];
  for (const row of users.results || []) {
    try {
      await driveApi(token, `files/${encodeURIComponent(rootId)}/permissions?sendNotificationEmail=false&fields=id`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "user", role: "reader", emailAddress: row.email })
      });
    } catch (e) {
      // Existing permission or Workspace sharing policy may reject this. The app's own preview proxy still works.
      if (!/already|duplicate|permission.*exists/i.test(String(e.message || e))) shareWarnings.push(`${row.email}: ${e.message}`);
    }
  }
  return { rootId, photosId, schemesId, unresolvedId, shareWarnings };
}
function imageMimeFromBytes(bytes, contentType = "") {
  const type = String(contentType).split(";")[0].trim().toLowerCase();
  if (["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"].includes(type)) return type;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 6 && (dec(bytes.slice(0, 6)) === "GIF87a" || dec(bytes.slice(0, 6)) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && dec(bytes.slice(0, 4)) === "RIFF" && dec(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (type === "image/svg+xml") throw new Error("SVG не копіюємо автоматично з міркувань безпеки.");
  throw new Error(`Джерело повернуло не підтримуване зображення (${type || "невідомий MIME type"}).`);
}
async function downloadSourceImage(sourceUrl) {
  let fetched = await fetchAllowedAsset(sourceUrl, "image/avif,image/webp,image/apng,image/*,*/*;q=0.8");
  let response = fetched.response;
  if (!response.ok) throw new Error(`Джерело повернуло HTTP ${response.status}.`);
  let type = response.headers.get("content-type") || "";
  const directLength = Number(response.headers.get("content-length") || 0);
  if (type.toLowerCase().startsWith("image/") && directLength > 8_000_000) {
    try { await response.body?.cancel(); } catch {}
    throw new Error("Файл більший за 8 MB. Потрібна окрема обробка великого файлу.");
  }
  if (!type.toLowerCase().startsWith("image/")) {
    const length = Number(response.headers.get("content-length") || 0);
    if (length > 2_000_000) throw new Error("Сторінка партнера завелика для автоматичного аналізу.");
    const html = (await response.text()).slice(0, 2_000_000);
    const metaTags = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
    let imageUrl = null;
    for (const tag of metaTags) {
      const property = tag.match(/(?:property|name)=["'](?:og:image|twitter:image)["']/i);
      const content = tag.match(/content=["']([^"']+)["']/i);
      if (property && content) { imageUrl = decodeHtml(content[1]); break; }
    }
    if (!imageUrl) {
      const img = html.match(/<(?:img|source)\b[^>]*(?:data-src|data-original|src)=["']([^"']+)["']/i);
      if (img) imageUrl = decodeHtml(img[1]);
    }
    if (!imageUrl) throw new Error("На сторінці партнера не знайдено пряме посилання на фото (можливо, воно завантажується після авторизації або JavaScript).");
    const resolved = allowedAssetUrl(new URL(imageUrl, fetched.finalUrl).toString());
    if (!resolved) throw new Error("Фінальна адреса фото не входить до списку перевірених доменів.");
    fetched = await fetchAllowedAsset(resolved.toString(), "image/*");
    response = fetched.response;
    if (!response.ok) throw new Error(`Не вдалося завантажити фото: HTTP ${response.status}.`);
    type = response.headers.get("content-type") || "";
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error("Отримано порожній файл.");
  if (bytes.length > 8_000_000) throw new Error("Файл більший за 8 MB. Потрібна окрема обробка великого файлу.");
  const mimeType = imageMimeFromBytes(bytes, type);
  const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" })[mimeType];
  return { bytes, mimeType, extension };
}
function safeDriveName(value) {
  return String(value || "asset").normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 70) || "asset";
}
async function uploadDriveImage(token, folderId, fileName, mimeType, bytes, existingFileId = null) {
  const metadata = existingFileId ? { name: fileName, mimeType } : { name: fileName, mimeType, parents: [folderId] };
  const fields = "id,name,mimeType,webViewLink,thumbnailLink,size";
  if (bytes.byteLength <= 5_000_000) {
    const boundary = `mf_ooh_${randomToken(16)}`;
    const prefix = enc(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const suffix = enc(`\r\n--${boundary}--`);
    const body = new Blob([prefix, bytes, suffix]);
    const endpoint = existingFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingFileId)}?uploadType=multipart&fields=${encodeURIComponent(fields)}`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${encodeURIComponent(fields)}`;
    const response = await fetch(endpoint, {
      method: existingFileId ? "PATCH" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` }, body
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.id) {
      if (existingFileId && response.status === 404) return uploadDriveImage(token, folderId, fileName, mimeType, bytes, null);
      throw new Error(payload.error?.message || `Не вдалося завантажити файл у Google Drive (HTTP ${response.status}).`);
    }
    return payload;
  }
  // Resumable upload is used for files above the Drive multipart 5 MB guidance.
  const resumableUrl = existingFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingFileId)}?uploadType=resumable&fields=${encodeURIComponent(fields)}`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=${encodeURIComponent(fields)}`;
  const init = await fetch(resumableUrl, {
    method: existingFileId ? "PATCH" : "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": mimeType, "x-upload-content-length": String(bytes.byteLength)
    }, body: JSON.stringify(metadata)
  });
  if (!init.ok) { const e = await init.json().catch(() => ({})); throw new Error(e.error?.message || "Не вдалося розпочати resumable upload у Google Drive."); }
  const uploadUrl = init.headers.get("location");
  if (!uploadUrl) throw new Error("Google Drive не повернув URL для resumable upload.");
  const uploaded = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": mimeType, "content-length": String(bytes.byteLength) }, body: bytes });
  const payload = await uploaded.json().catch(() => ({}));
  if (!uploaded.ok || !payload.id) throw new Error(payload.error?.message || `Resumable upload завершився помилкою HTTP ${uploaded.status}.`);
  return payload;
}
async function enqueueCurrentInventoryAssets(env, googleUserId) {
  const stamp = nowIso();
  const queries = [
    env.DB.prepare(`UPDATE inventory_assets SET source_url=(SELECT i.photo_url FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key),
      source_sheet=COALESCE((SELECT i.source_sheet FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key),source_sheet),
      object_title=COALESCE((SELECT json_extract(i.data_json,'$._title') FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key),object_title),
      status='pending',mime_type=NULL,error_message=NULL,google_user_id=?,updated_at=?
      WHERE asset_type='photo' AND EXISTS(SELECT 1 FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key AND COALESCE(i.photo_url,'')<>'' AND i.photo_url<>inventory_assets.source_url)`)
      .bind(googleUserId, stamp),
    env.DB.prepare(`UPDATE inventory_assets SET source_url=(SELECT i.scheme_url FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key),
      source_sheet=COALESCE((SELECT i.source_sheet FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key),source_sheet),
      object_title=COALESCE((SELECT json_extract(i.data_json,'$._title') FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key),object_title),
      status='pending',mime_type=NULL,error_message=NULL,google_user_id=?,updated_at=?
      WHERE asset_type='scheme' AND EXISTS(SELECT 1 FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key AND COALESCE(i.scheme_url,'')<>'' AND i.scheme_url<>inventory_assets.source_url)`)
      .bind(googleUserId, stamp),
    env.DB.prepare(`INSERT INTO inventory_assets(id,stable_key,asset_type,source_url,source_sheet,object_title,status,google_user_id,created_at,updated_at)
      SELECT lower(hex(randomblob(16))),COALESCE(i.stable_key,i.id),'photo',i.photo_url,i.source_sheet,COALESCE(json_extract(i.data_json,'$._title'),i.title,''),'pending',?,?,?
      FROM inventory i WHERE COALESCE(i.photo_url,'')<>'' AND NOT EXISTS(SELECT 1 FROM inventory_assets a WHERE a.stable_key=COALESCE(i.stable_key,i.id) AND a.asset_type='photo')`)
      .bind(googleUserId, stamp, stamp),
    env.DB.prepare(`INSERT INTO inventory_assets(id,stable_key,asset_type,source_url,source_sheet,object_title,status,google_user_id,created_at,updated_at)
      SELECT lower(hex(randomblob(16))),COALESCE(i.stable_key,i.id),'scheme',i.scheme_url,i.source_sheet,COALESCE(json_extract(i.data_json,'$._title'),i.title,''),'pending',?,?,?
      FROM inventory i WHERE COALESCE(i.scheme_url,'')<>'' AND NOT EXISTS(SELECT 1 FROM inventory_assets a WHERE a.stable_key=COALESCE(i.stable_key,i.id) AND a.asset_type='scheme')`)
      .bind(googleUserId, stamp, stamp)
  ];
  await env.DB.batch(queries);
  const counts = await env.DB.prepare("SELECT status,COUNT(*) AS n FROM inventory_assets GROUP BY status").all();
  return Object.fromEntries((counts.results || []).map((r) => [r.status, Number(r.n || 0)]));
}
async function driveLibraryStatus(env) {
  const counts = await env.DB.prepare("SELECT status,COUNT(*) AS n FROM inventory_assets GROUP BY status").all();
  const failures = await env.DB.prepare("SELECT id,stable_key,asset_type,source_sheet,object_title,source_url,error_message,attempts FROM inventory_assets WHERE status='needs_attention' ORDER BY updated_at DESC LIMIT 30").all();
  const settings = await env.DB.prepare("SELECT setting_key,setting_value FROM drive_library_settings").all();
  const folderIds = Object.fromEntries((settings.results || []).map((r) => [r.setting_key, r.setting_value]));
  const summary = { pending: 0, processing: 0, copied: 0, needs_attention: 0 };
  for (const row of counts.results || []) if (row.status in summary) summary[row.status] = Number(row.n || 0);
  summary.total = summary.pending + summary.processing + summary.copied + summary.needs_attention;
  summary.failures = failures.results || [];
  summary.folderReady = Boolean(folderIds.root_folder_id && folderIds.photos_folder_id && folderIds.schemes_folder_id);
  return summary;
}
async function processOneDriveAsset(env) {
  const stamp = nowIso();
  const item = await env.DB.prepare(`UPDATE inventory_assets SET status='processing',attempts=attempts+1,last_attempt_at=?,updated_at=?
    WHERE id=(SELECT id FROM inventory_assets WHERE status='pending' ORDER BY updated_at,created_at LIMIT 1)
      AND status='pending' RETURNING *`).bind(stamp, stamp).first();
  if (!item) return { processed: false, done: true };
  try {
    const token = await googleAccessToken(env, item.google_user_id);
    let settings = await env.DB.prepare("SELECT setting_value FROM drive_library_settings WHERE setting_key=?").bind(item.asset_type === "photo" ? "photos_folder_id" : "schemes_folder_id").first();
    if (!settings?.setting_value) {
      await ensureDriveLibraryFolders(env, item.google_user_id, token);
      settings = await env.DB.prepare("SELECT setting_value FROM drive_library_settings WHERE setting_key=?").bind(item.asset_type === "photo" ? "photos_folder_id" : "schemes_folder_id").first();
    }
    if (!settings?.setting_value) throw new Error("Не вдалося створити папки бібліотеки Google Drive.");
    const media = await downloadSourceImage(item.source_url);
    const keyHash = (await digest(item.stable_key)).replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
    const fileName = `${safeDriveName(item.source_sheet)}_${safeDriveName(item.object_title || item.stable_key)}_${keyHash}_${item.asset_type}.${media.extension}`;
    const uploaded = await uploadDriveImage(token, settings.setting_value, fileName, media.mimeType, media.bytes, item.drive_file_id || null);
    await env.DB.prepare(`UPDATE inventory_assets SET status='copied',drive_file_id=?,drive_web_view_link=?,mime_type=?,file_name=?,error_message=NULL,updated_at=? WHERE id=?`)
      .bind(uploaded.id, uploaded.webViewLink || null, media.mimeType, uploaded.name || fileName, nowIso(), item.id).run();
    return { processed: true, id: item.id, status: "copied", name: uploaded.name || fileName };
  } catch (e) {
    await env.DB.prepare("UPDATE inventory_assets SET status='needs_attention',error_message=?,updated_at=? WHERE id=?")
      .bind(String(e?.message || e).slice(0, 1000), nowIso(), item.id).run();
    return { processed: true, id: item.id, status: "needs_attention", error: String(e?.message || e).slice(0, 500) };
  }
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
  if (parsed.records.length > 5000) throw new Error(`Знайдено ${parsed.records.length} об’єктів. Ліміт цієї версії Bridge — 5 000 об’єктів за одну синхронізацію. Для більшого інвентаря потрібен пакетний sync. Дані не змінено.`);
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


// -----------------------------------------------------------------------------
// Signed Google Apps Script bridge (no Google Cloud Billing / no direct OAuth
// client in Cloudflare). Apps Script executes as the owner's Google account.
// -----------------------------------------------------------------------------

async function signAppsScriptEnvelope(secret, timestamp, nonce, payloadText) {
  const key = await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, enc(`${timestamp}.${nonce}.${payloadText}`));
  return base64UrlBytes(signature);
}

async function callAppsScriptBridge(env, payload) {
  if (!env.APPS_SCRIPT_URL || !env.APPS_SCRIPT_BRIDGE_SECRET) {
    throw new Error("Apps Script Bridge ще не налаштований у Cloudflare Worker Secrets (APPS_SCRIPT_URL, APPS_SCRIPT_BRIDGE_SECRET).");
  }
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const payloadText = JSON.stringify(payload);
  const signature = await signAppsScriptEnvelope(env.APPS_SCRIPT_BRIDGE_SECRET, timestamp, nonce, payloadText);
  const response = await fetch(env.APPS_SCRIPT_URL, {
    method: "POST",
    redirect: "follow",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timestamp, nonce, payload: payloadText, signature })
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Apps Script повернув не JSON (HTTP ${response.status}). Перевір URL Web App та доступ Anyone.`); }
  if (!response.ok || data?.ok === false || data?.error) {
    throw new Error(data?.error || `Apps Script HTTP ${response.status}`);
  }
  return data?.result !== undefined ? data.result : data;
}

async function verifyAppsScriptEnvelope(request, env) {
  if (!env.APPS_SCRIPT_BRIDGE_SECRET) throw new Error("Не налаштовано APPS_SCRIPT_BRIDGE_SECRET у Worker.");
  const raw = await request.text();
  if (!raw || raw.length > 15_000_000) throw new Error("Підписаний запит порожній або завеликий.");
  let envelope;
  try { envelope = JSON.parse(raw); } catch { throw new Error("Некоректний JSON Bridge."); }
  const timestamp = String(envelope?.timestamp || "");
  const nonce = String(envelope?.nonce || "");
  const payloadText = String(envelope?.payload || "");
  const signature = String(envelope?.signature || "");
  if (!/^\d{13}$/.test(timestamp) || !/^[a-f0-9]{32}$/i.test(nonce) || !payloadText || !signature) {
    throw new Error("Некоректний підписаний запит Bridge.");
  }
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) throw new Error("Час підписаного запиту минув.");
  const expected = await signAppsScriptEnvelope(env.APPS_SCRIPT_BRIDGE_SECRET, timestamp, nonce, payloadText);
  if (!constantTimeEqual(expected, signature)) throw new Error("Невірний HMAC-підпис Apps Script.");
  // Persist nonce in D1 to reject replayed requests across Worker isolates.
  await env.DB.prepare("DELETE FROM bridge_nonces WHERE created_at < ?")
    .bind(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).run();
  try {
    await env.DB.prepare("INSERT INTO bridge_nonces(nonce,created_at) VALUES(?,?)").bind(nonce, nowIso()).run();
  } catch {
    throw new Error("Повторний підписаний запит відхилено.");
  }
  let payload;
  try { payload = JSON.parse(payloadText); } catch { throw new Error("Вміст Bridge payload не є JSON."); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Некоректний Bridge payload.");
  return payload;
}

async function enqueueAppsScriptInventoryAssets(env) {
  const stamp = nowIso();
  const queries = [
    env.DB.prepare(`UPDATE inventory_assets SET
      source_url=(SELECT i.photo_url FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key),
      source_sheet=COALESCE((SELECT i.source_sheet FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key),source_sheet),
      object_title=COALESCE((SELECT json_extract(i.data_json,'$._title') FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key),object_title),
      status='pending',google_user_id='apps-script',error_message=NULL,updated_at=?
      WHERE asset_type='photo' AND EXISTS(SELECT 1 FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key AND COALESCE(i.photo_url,'')<>'' AND i.photo_url<>inventory_assets.source_url)`)
      .bind(stamp),
    env.DB.prepare(`UPDATE inventory_assets SET
      source_url=(SELECT i.scheme_url FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key),
      source_sheet=COALESCE((SELECT i.source_sheet FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key),source_sheet),
      object_title=COALESCE((SELECT json_extract(i.data_json,'$._title') FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key),object_title),
      status='pending',google_user_id='apps-script',error_message=NULL,updated_at=?
      WHERE asset_type='scheme' AND EXISTS(SELECT 1 FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key AND COALESCE(i.scheme_url,'')<>'' AND i.scheme_url<>inventory_assets.source_url)`)
      .bind(stamp),
    env.DB.prepare(`UPDATE inventory_assets SET status='needs_attention',error_message='Посилання на фото прибране з Google Sheets.',updated_at=?
      WHERE asset_type='photo' AND status='copied' AND EXISTS(SELECT 1 FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key AND COALESCE(i.photo_url,'')='')`)
      .bind(stamp),
    env.DB.prepare(`UPDATE inventory_assets SET status='needs_attention',error_message='Посилання на схему прибране з Google Sheets.',updated_at=?
      WHERE asset_type='scheme' AND status='copied' AND EXISTS(SELECT 1 FROM inventory i WHERE COALESCE(i.stable_key,i.id)=inventory_assets.stable_key AND COALESCE(i.scheme_url,'')='')`)
      .bind(stamp),
    env.DB.prepare(`INSERT INTO inventory_assets(id,stable_key,asset_type,source_url,source_sheet,object_title,status,google_user_id,created_at,updated_at)
      SELECT lower(hex(randomblob(16))),COALESCE(i.stable_key,i.id),'photo',i.photo_url,i.source_sheet,COALESCE(json_extract(i.data_json,'$._title'),i.title,''),'pending','apps-script',?,?
      FROM inventory i WHERE COALESCE(i.photo_url,'')<>'' AND NOT EXISTS(SELECT 1 FROM inventory_assets a WHERE a.stable_key=COALESCE(i.stable_key,i.id) AND a.asset_type='photo')`)
      .bind(stamp, stamp),
    env.DB.prepare(`INSERT INTO inventory_assets(id,stable_key,asset_type,source_url,source_sheet,object_title,status,google_user_id,created_at,updated_at)
      SELECT lower(hex(randomblob(16))),COALESCE(i.stable_key,i.id),'scheme',i.scheme_url,i.source_sheet,COALESCE(json_extract(i.data_json,'$._title'),i.title,''),'pending','apps-script',?,?
      FROM inventory i WHERE COALESCE(i.scheme_url,'')<>'' AND NOT EXISTS(SELECT 1 FROM inventory_assets a WHERE a.stable_key=COALESCE(i.stable_key,i.id) AND a.asset_type='scheme')`)
      .bind(stamp, stamp)
  ];
  await env.DB.batch(queries);
  const status = await driveLibraryStatus(env);
  return { pending: status.pending, processing: status.processing, copied: status.copied, needs_attention: status.needs_attention, total: status.total };
}

async function dispatchAppsScriptPayload(env, payload) {
  const action = String(payload.action || "");
  if (action === "bridge.health") {
    return { ok: true, service: "media-first-ooh", bridge: "apps-script", time: nowIso() };
  }
  if (action === "inventory.preview") {
    if (!Array.isArray(payload.records) || !Array.isArray(payload.layers)) throw new Error("Preview не містить records/layers.");
    if (!payload.records.length || payload.records.length > 5000) throw new Error("Кількість записів має бути від 1 до 5000. Інвентар не змінено.");
    return await previewSync(env, { records: payload.records, layers: payload.layers, warnings: payload.warnings || [] });
  }
  if (action === "inventory.apply") {
    if (!Array.isArray(payload.records) || !Array.isArray(payload.layers)) throw new Error("Apply не містить records/layers.");
    const parsed = { records: payload.records, layers: payload.layers, warnings: payload.warnings || [] };
    if (!parsed.records.length || parsed.records.length > 5000) throw new Error("Кількість записів має бути від 1 до 5000. Інвентар не змінено.");
    const preview = await previewSync(env, parsed);
    if (preview.requiresConfirmation && payload.confirmLargeDecrease !== true) {
      const error = new Error(`Зменшення інвентаря з ${preview.previousCount} до ${preview.count} потребує підтвердження Admin.`);
      error.code = "LARGE_INVENTORY_DECREASE";
      throw error;
    }
    const runId = await addSyncRun(env, String(payload.source || "apps-script"));
    try {
      const result = await replaceInventory(env, parsed);
      const assetQueue = await enqueueAppsScriptInventoryAssets(env);
      await finishSyncRun(env, runId, { status: "success", records: result.count, layers: result.layers, message: null });
      return { ...result, assetQueue };
    } catch (error) {
      await finishSyncRun(env, runId, { status: "failed", records: 0, layers: 0, message: String(error?.message || error).slice(0, 1000) }).catch(() => {});
      throw error;
    }
  }
  if (action === "assets.next") {
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await env.DB.prepare("UPDATE inventory_assets SET status='pending',updated_at=? WHERE status='processing' AND updated_at<?")
      .bind(nowIso(), stale).run();
    const stamp = nowIso();
    const asset = await env.DB.prepare(`UPDATE inventory_assets SET status='processing',attempts=attempts+1,last_attempt_at=?,updated_at=?
      WHERE id=(SELECT id FROM inventory_assets WHERE status='pending' ORDER BY created_at,updated_at LIMIT 1)
        AND status='pending'
      RETURNING id,stable_key,asset_type,source_url,source_sheet,object_title,drive_file_id`).bind(stamp, stamp).first();
    return { asset: asset ? { id: asset.id, stableKey: asset.stable_key, assetType: asset.asset_type, sourceUrl: asset.source_url, sourceSheet: asset.source_sheet, objectTitle: asset.object_title, driveFileId: asset.drive_file_id || null } : null };
  }
  if (action === "assets.complete") {
    const id = String(payload.id || "");
    const status = payload.status === "copied" ? "copied" : "needs_attention";
    if (!id) throw new Error("Не передано ID завдання медіафайлу.");
    if (status === "copied" && !payload.driveFileId) throw new Error("Не передано Drive File ID для скопійованого матеріалу.");
    const result = await env.DB.prepare(`UPDATE inventory_assets SET status=?,drive_file_id=CASE WHEN ?='copied' THEN ? ELSE drive_file_id END,
      drive_web_view_link=CASE WHEN ?='copied' THEN ? ELSE drive_web_view_link END,
      mime_type=CASE WHEN ?='copied' THEN ? ELSE mime_type END,
      file_name=CASE WHEN ?='copied' THEN ? ELSE file_name END,
      error_message=?,updated_at=? WHERE id=?`)
      .bind(status, status, payload.driveFileId || null, status, payload.driveWebViewLink || null, status, payload.mimeType || null,
        status, payload.fileName || null, status === "copied" ? null : String(payload.errorMessage || "Не вдалося отримати файл.").slice(0, 1000), nowIso(), id).run();
    if (!result.meta?.changes) throw new Error("Завдання медіафайлу не знайдено.");
    return { ok: true, id, status };
  }
  if (action === "drive.setup") {
    const folders = payload.folders || payload;
    const mapping = {
      root_folder_id: folders.rootFolderId,
      photos_folder_id: folders.photosFolderId,
      schemes_folder_id: folders.schemesFolderId,
      unresolved_folder_id: folders.unresolvedFolderId,
      root_folder_url: folders.rootFolderUrl
    };
    const stamp = nowIso();
    const statements = Object.entries(mapping).filter(([, value]) => value).map(([key, value]) =>
      env.DB.prepare(`INSERT INTO drive_library_settings(setting_key,setting_value,updated_at) VALUES(?,?,?)
        ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at`).bind(key, String(value), stamp));
    if (statements.length) await env.DB.batch(statements);
    return { ok: true, foldersReady: Boolean(mapping.root_folder_id && mapping.photos_folder_id && mapping.schemes_folder_id), folders: mapping };
  }
  throw new Error("Невідома дія Apps Script → Worker: " + action);
}

async function handleAppsScriptBridgeRequest(request, env) {
  try {
    const payload = await verifyAppsScriptEnvelope(request, env);
    const result = await dispatchAppsScriptPayload(env, payload);
    return json({ ok: true, result });
  } catch (error) {
    console.error("Apps Script bridge request failed:", error?.stack || error);
    const message = String(error?.message || error);
    return json({ ok: false, error: message, code: error?.code || "BRIDGE_REQUEST_FAILED", preview: error?.preview || null }, 400);
  }
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method !== "GET" && !sameOrigin(request)) return fail("Cross-origin request blocked.", 403);

  if (path === "/api/bridge/apps-script" && request.method === "POST") return handleAppsScriptBridgeRequest(request, env);

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
    ).bind(stateRow.user_id, info.email || "Google account", encrypted, String(tokenData.scope || GOOGLE_SCOPES.join(" ")), nowIso(), nowIso()).run();
    return htmlRedirect(`${url.origin}/?google=connected`);
  }

  const user = await currentUser(request, env);
  if (path === "/api/inventory" && request.method === "GET") {
    const denied = requireRole(user); if (denied) return denied;
    const [inventoryResult, layerResult, revisionResult, assetRevision] = await Promise.all([
      env.DB.prepare("SELECT data_json FROM inventory ORDER BY source_sheet,source_row").all(),
      env.DB.prepare("SELECT layer_key AS key,source_sheet AS sourceSheet,display_name AS name,color,marker_shape AS shape,marker_label AS label,kind,sort_order AS sort FROM inventory_layers ORDER BY sort_order,display_name").all(),
      env.DB.prepare("SELECT COUNT(*) AS count,COALESCE(MAX(updated_at),'') AS revision FROM inventory").first(),
      env.DB.prepare("SELECT COALESCE(MAX(updated_at),'') AS revision FROM inventory_assets WHERE status='copied'").first()
    ]);
    const records = (inventoryResult.results || []).map((r) => { try { return JSON.parse(r.data_json); } catch { return null; } }).filter(Boolean);
    const storedAssets = await env.DB.prepare("SELECT id,stable_key,asset_type,drive_web_view_link FROM inventory_assets WHERE status='copied'").all().catch(() => ({ results: [] }));
    const assetMap = new Map((storedAssets.results || []).map((a) => [`${a.stable_key}|${a.asset_type}`, a]));
    for (const record of records) {
      const stableKey = record._stable_key || stableKeyFromRecord(record);
      const photo = assetMap.get(`${stableKey}|photo`);
      const scheme = assetMap.get(`${stableKey}|scheme`);
      if (photo) { record._photo_drive_url = `/api/assets/library-file?id=${encodeURIComponent(photo.id)}`; record._photo_drive_link = photo.drive_web_view_link || null; }
      if (scheme) { record._scheme_drive_url = `/api/assets/library-file?id=${encodeURIComponent(scheme.id)}`; record._scheme_drive_link = scheme.drive_web_view_link || null; }
    }
    let layers = layerResult.results || [];
    if (!layers.length && records.length) {
      const byKey = new Map();
      for (const r of records) if (!byKey.has(r._layer)) byKey.set(r._layer, { key: r._layer, sourceSheet: r._source_sheet, name: r._layer_name || r._layer, color: r._layer_color || (r._layer === "promo" ? "#005EFF" : r._layer === "local" ? "#25FF08" : "#B5232F"), shape: r._marker_shape || (r._layer === "local" ? "diamond" : "circle"), label: r._marker_label || (r._layer === "restaurant" ? "KFC" : ""), kind: r._layer_kind || (r._layer === "restaurant" ? "restaurant" : "media"), sort: 100 });
      layers = [...byKey.values()];
    }
    const revision = [revisionResult?.revision || "", assetRevision?.revision || ""].sort().at(-1) || "";
    return json({ records, layers, revision, count: Number(revisionResult?.count || 0) });
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
      const sent = await callAppsScriptBridge(env, { action: "mail.send", userId: user.id, to, subject, body, filename, fileBase64 });
      await env.DB.prepare("INSERT INTO email_log(id,user_id,recipient,subject,filename,sent_at,provider_message_id) VALUES(?,?,?,?,?,?,?)")
        .bind(uid(), user.id, to, subject, filename, nowIso(), null).run();
      return json({ ok: true, recipient: to, filename, remainingRecipientsToday: sent.remainingRecipientsToday ?? null });
    } catch (e) { return fail(`Не вдалося відправити лист через Apps Script MailApp: ${e.message}`, 502); }
  }
  if (path === "/api/admin/users") return adminUsers(request, env, user, url);
  if (path === "/api/google/connect" && request.method === "GET") {
    const denied = requireRole(user, "admin"); if (denied) return denied;
    return json({ ok: true, message: "Google підключається через Media First OOH Bridge у Google Apps Script. Не потрібен Google Cloud Billing." });
  }
  if (path === "/api/google/status" && request.method === "GET") {
    const denied = requireRole(user, "admin"); if (denied) return denied;
    const lastSync = await env.DB.prepare("SELECT status,completed_at,records_count,layers_count,message,source FROM sync_runs ORDER BY started_at DESC LIMIT 1").first();
    if (!env.APPS_SCRIPT_URL || !env.APPS_SCRIPT_BRIDGE_SECRET) {
      return json({ connected: false, connectedToCurrentUser: false, driveScopeEnabled: false, bridgeConfigured: false, email: null, sheetConfigured: false, lastSync: lastSync || null });
    }
    try {
      const diagnostics = await callAppsScriptBridge(env, { action: "bridge.diagnostics" });
      return json({ connected: Boolean(diagnostics?.ok), connectedToCurrentUser: Boolean(diagnostics?.ok), driveScopeEnabled: Boolean(diagnostics?.driveRootFolderConfigured), bridgeConfigured: true, email: diagnostics?.ownerEmail || null, connectedAt: diagnostics?.spreadsheet ? null : null, sheetConfigured: Boolean(diagnostics?.spreadsheet), lastSync: lastSync || null, diagnostics });
    } catch (error) {
      return json({ connected: false, connectedToCurrentUser: false, driveScopeEnabled: false, bridgeConfigured: true, email: null, sheetConfigured: false, bridgeError: error.message, lastSync: lastSync || null });
    }
  }
  if (path === "/api/google/test-email" && request.method === "POST") {
    const denied = requireRole(user, "admin"); if (denied) return denied;
    try {
      const sent = await callAppsScriptBridge(env, { action: "mail.test", userId: user.id });
      if (sent?.recipient) await env.DB.prepare("INSERT INTO email_log(id,user_id,recipient,subject,filename,sent_at,provider_message_id) VALUES(?,?,?,?,?,?,?)")
        .bind(uid(), user.id, sent.recipient, "Тест Media First OOH Platform", "TEST", nowIso(), null).run();
      return json({ ok: true, recipient: sent?.recipient || null, remainingRecipientsToday: sent?.remainingRecipientsToday ?? null });
    } catch (e) { return fail(`Не вдалося надіслати тестовий лист через MailApp: ${e.message}`, 502); }
  }
  if (path === "/api/google/sync" && request.method === "POST") {
    const denied = requireRole(user, "admin"); if (denied) return denied;
    try {
      const body = await bodyJson(request) || {};
      const result = await callAppsScriptBridge(env, { action: "sheets.sync", preview: body.preview === true, confirmLargeDecrease: body.confirmLargeDecrease === true });
      return json(result);
    } catch (e) {
      const status = String(e?.message || "").includes("потребує підтвердження") ? 409 : 502;
      return json({ error: `Помилка синхронізації Google Sheets через Apps Script: ${e.message}`, code: e?.code || "SYNC_FAILED", preview: e?.preview || null }, status);
    }
  }

  if (path === "/api/assets/library/status" && request.method === "GET") {
    const denied = requireRole(user, "admin"); if (denied) return denied;
    return json(await driveLibraryStatus(env));
  }
  if (path === "/api/assets/library/start" && request.method === "POST") {
    const denied = requireRole(user, "admin"); if (denied) return denied;
    try {
      const folders = await callAppsScriptBridge(env, { action: "drive.setup" });
      const counts = await enqueueAppsScriptInventoryAssets(env);
      await env.DB.prepare("UPDATE inventory_assets SET status='pending',error_message=NULL,updated_at=? WHERE status='needs_attention' AND source_url<>''").bind(nowIso()).run();
      const finalStatus = await driveLibraryStatus(env);
      return json({ ok: true, foldersReady: Boolean(folders?.foldersReady), counts: finalStatus, message: "Папки Google Drive перевірені. Фото та схеми поставлено в чергу." });
    } catch (e) { return fail(`Не вдалося підготувати бібліотеку Google Drive: ${e.message}`, 502); }
  }
  if (path === "/api/assets/library/process" && request.method === "POST") {
    const denied = requireRole(user, "admin"); if (denied) return denied;
    try {
      const result = await callAppsScriptBridge(env, { action: "assets.process" });
      const status = await driveLibraryStatus(env);
      return json({ ...result, counts: { pending: status.pending, processing: status.processing, copied: status.copied, needs_attention: status.needs_attention, total: status.total } });
    } catch (e) { return fail(`Не вдалося обробити чергу фото та схем через Apps Script: ${e.message}`, 502); }
  }
  if (path === "/api/assets/library-file" && request.method === "GET") {
    const denied = requireRole(user); if (denied) return denied;
    const assetId = url.searchParams.get("id");
    if (!assetId) return fail("Не вказано ID медіафайлу.");
    const asset = await env.DB.prepare("SELECT * FROM inventory_assets WHERE id=? AND status='copied' LIMIT 1").bind(assetId).first();
    if (!asset?.drive_file_id) return fail("Копію фото ще не створено.", 404);
    try {
      const file = await callAppsScriptBridge(env, { action: "assets.download", driveFileId: asset.drive_file_id });
      const bytes = fromB64(String(file?.fileBase64 || ""));
      if (!bytes.length || bytes.length > 8 * 1024 * 1024) return fail("Файл порожній або перевищує дозволений розмір.", 413);
      return new Response(bytes, { headers: {
        "content-type": file.mimeType || asset.mime_type || "application/octet-stream",
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
        "content-disposition": "inline"
      } });
    } catch (e) { return fail(`Помилка читання приватного файла Google Drive: ${e.message}`, 502); }
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

async function scheduledHandler() {
  // All Google operations are owned by Apps Script installable triggers.
  // Keep this handler inert so an old Cloudflare Cron cannot call the legacy
  // direct-Google OAuth queue path.
  console.log("No Cloudflare scheduled work. Apps Script owns Sheets sync and Drive asset queue.");
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
