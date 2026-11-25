/**
 * Media First OOH Bridge
 * Google Apps Script integration layer for the Cloudflare OOH platform.
 *
 * Responsibilities:
 * - Read every eligible inventory tab from one Google Spreadsheet.
 * - Extract HYPERLINK() and rich-text photo/scheme URLs.
 * - Push inventory to the Cloudflare Worker using signed HMAC requests.
 * - Copy eligible partner images into a private Google Drive library.
 * - Serve private Drive assets to the authenticated Cloudflare Worker.
 * - Send XLSX program attachments through MailApp.
 *
 * Configure Script Properties before deploying:
 *   SPREADSHEET_ID       Google spreadsheet ID
 *   WORKER_BASE_URL      e.g. https://your-worker.example.workers.dev
 *   BRIDGE_SECRET        Generated with generateBridgeSecret()
 * Optional:
 *   DRIVE_ROOT_FOLDER_ID Existing Drive folder ID; blank = create a folder
 *   DRIVE_SHARE_EMAILS   Comma-separated platform users to add as Drive viewers
 *   MAX_ASSET_BYTES      Defaults to 8388608 (8 MB)
 */

const MF = Object.freeze({
  VERSION: '1.0.0',
  SERVICE: 'media-first-ooh-apps-script-bridge',
  WORKER_PATH: '/api/bridge/apps-script',
  SIGNATURE_WINDOW_MS: 5 * 60 * 1000,
  NONCE_TTL_SECONDS: 600,
  MAX_ASSET_BYTES_DEFAULT: 8 * 1024 * 1024,
  MAX_SYNC_RECORDS: 5000,
  MAX_ASSETS_PER_RUN: 2,
  ASSET_HOSTS: [
    '81.162.220.11', 'mbuyer.posterscope.com.ua', 'booking.outhub.online',
    'drive.google.com', 'bma.bigmedia.ua', 'hub.megapolis.com.ua',
    'megapolisplus-my.sharepoint.com', 'adv-ooh.xyz', 'www.google.com',
    'billboards.com.ua', 'booking.megapolisplus.com.ua', 'tristarplus.com.ua',
    'home.prime-group.com.ua', 'i.sv-outdoor.com', 'www.outdoorphoto.com.ua',
    'bio-fors.adv.vg', 'postimg.cc', 'megapolisplusua-my.sharepoint.com',
    'www.rtm.com.ua', 'ibb.co'
  ],
  CONFIG_SHEET_NAMES: ['налаштування шарів', 'настройки слоев', 'ooh layers', '_layers', 'layers'],
  PALETTE: ['#7C3AED', '#F59E0B', '#06B6D4', '#E11D48', '#16A34A', '#9333EA', '#EA580C', '#0F766E']
});

// -----------------------------------------------------------------------------
// Web app entry points
// -----------------------------------------------------------------------------

function doGet() {
  return jsonOutput_({ ok: true, service: MF.SERVICE, version: MF.VERSION, message: 'Bridge is online. Signed POST required for all actions.' });
}

function doPost(e) {
  try {
    const envelope = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const payload = verifyEnvelope_(envelope);
    const action = String(payload.action || '');
    let result;

    switch (action) {
      case 'bridge.health':
        result = { ok: true, service: MF.SERVICE, version: MF.VERSION, time: new Date().toISOString() };
        break;
      case 'sheets.sync':
        result = handleSyncRequest_(payload);
        break;
      case 'assets.process':
        result = processAssetBatch_();
        break;
      case 'assets.download':
        result = downloadDriveAsset_(payload);
        break;
      case 'mail.send':
        result = sendMail_(payload);
        break;
      case 'mail.test':
        result = sendTestMail_();
        break;
      case 'drive.setup':
        result = setupDriveLibrary_();
        break;
      case 'bridge.diagnostics':
        result = diagnostics_();
        break;
      default:
        throw new Error('Невідома дія Bridge: ' + action);
    }
    return jsonOutput_({ ok: true, result: result });
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return jsonOutput_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

// -----------------------------------------------------------------------------
// First-time setup and diagnostics
// -----------------------------------------------------------------------------

/** Run once from the Apps Script editor. The generated secret is stored in
 * Script Properties and printed to the execution log so it can be copied into
 * the local .dev.vars and later into Cloudflare Worker Secrets. Do not share it. */
function generateBridgeSecret() {
  const secret = [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid()].join('');
  PropertiesService.getScriptProperties().setProperty('BRIDGE_SECRET', secret);
  Logger.log('BRIDGE_SECRET (copy locally; do not send in chat): ' + secret);
  return 'Секрет створено та збережено в Script Properties. Скопіюй його з Execution log у локальну конфігурацію Cloudflare.';
}

/** Checks configuration without printing secret values. */
function checkBridgeSetup() {
  const p = PropertiesService.getScriptProperties();
  const required = ['SPREADSHEET_ID', 'WORKER_BASE_URL', 'BRIDGE_SECRET'];
  const missing = required.filter(k => !p.getProperty(k));
  const result = {
    ok: missing.length === 0,
    missingProperties: missing,
    workerBaseUrlConfigured: !!p.getProperty('WORKER_BASE_URL'),
    spreadsheetIdConfigured: !!p.getProperty('SPREADSHEET_ID'),
    bridgeSecretConfigured: !!p.getProperty('BRIDGE_SECRET'),
    driveRootFolderConfigured: !!p.getProperty('DRIVE_ROOT_FOLDER_ID')
  };
  Logger.log(JSON.stringify(result, null, 2));
  if (missing.length) throw new Error('Заповни Script Properties: ' + missing.join(', '));
  return result;
}

/** Run once after Script Properties are set to grant required permissions and
 * validate that the spreadsheet and Drive can be accessed by this account. */
function authorizeAndCheckGoogleServices() {
  checkBridgeSetup();
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID'));
  const drive = setupDriveLibrary_();
  const remainingRecipients = MailApp.getRemainingDailyQuota();
  const result = {
    spreadsheetName: ss.getName(),
    sheetCount: ss.getSheets().length,
    driveFolders: drive,
    remainingEmailRecipientsToday: remainingRecipients
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Create or repair the dedicated private asset folders. */
function setupDriveLibrary() {
  const result = setupDriveLibrary_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function setupDriveLibrary_() {
  const props = PropertiesService.getScriptProperties();
  let rootId = props.getProperty('DRIVE_ROOT_FOLDER_ID');
  let root = null;
  if (rootId) {
    try { root = Drive.Files.get(rootId, { fields: 'id,name,mimeType,webViewLink,trashed' }); if (root.trashed) root = null; }
    catch (e) { root = null; }
  }
  if (!root) {
    root = Drive.Files.create(
      { name: 'Media First OOH Assets', mimeType: 'application/vnd.google-apps.folder' },
      null,
      { fields: 'id,name,mimeType,webViewLink' }
    );
    if (!root || !root.id) throw new Error('Не вдалося створити кореневу папку Google Drive.');
    rootId = root.id;
    props.setProperty('DRIVE_ROOT_FOLDER_ID', rootId);
  }
  const photos = getOrCreateChildFolder_(rootId, 'Photos');
  const schemes = getOrCreateChildFolder_(rootId, 'Schemes');
  const unresolved = getOrCreateChildFolder_(rootId, 'Unresolved');
  shareDriveRootWithConfiguredUsers_(rootId);
  const rootUrl = root.webViewLink || Drive.Files.get(rootId, { fields: 'webViewLink' }).webViewLink || '';
  return {
    rootFolderId: rootId,
    rootFolderUrl: rootUrl,
    photosFolderId: photos.id,
    schemesFolderId: schemes.id,
    unresolvedFolderId: unresolved.id
  };
}

function getOrCreateChildFolder_(parentId, name) {
  const safeName = name.replace(/'/g, "\\'");
  const q = "'" + parentId + "' in parents and name='" + safeName + "' and mimeType='application/vnd.google-apps.folder' and trashed=false";
  const listed = Drive.Files.list({ q: q, pageSize: 20, fields: 'files(id,name,mimeType,webViewLink)' });
  const files = listed.files || [];
  if (files.length) return files[0];
  const created = Drive.Files.create(
    { name: name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    null,
    { fields: 'id,name,mimeType,webViewLink' }
  );
  if (!created || !created.id) throw new Error('Не вдалося створити папку: ' + name);
  return created;
}

function shareDriveRootWithConfiguredUsers_(rootId) {
  const raw = PropertiesService.getScriptProperties().getProperty('DRIVE_SHARE_EMAILS') || '';
  const emails = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const warnings = [];
  emails.forEach(email => {
    try { Drive.Permissions.create({ type: 'user', role: 'reader', emailAddress: email }, rootId, { sendNotificationEmail: false }); }
    catch (e) {
      if (!/already|duplicate|permission.*exists/i.test(String(e.message || e))) warnings.push(email + ': ' + String(e.message || e));
    }
  });
  if (warnings.length) console.warn('Drive sharing warnings: ' + warnings.join(' | '));
}

function diagnostics_() {
  const setup = checkBridgeSetup();
  const props = PropertiesService.getScriptProperties();
  let spreadsheet = null;
  if (!setup.missingProperties.includes('SPREADSHEET_ID')) {
    const ss = SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID'));
    spreadsheet = { name: ss.getName(), tabs: ss.getSheets().length };
  }
  return {
    ok: true,
    version: MF.VERSION,
    spreadsheet: spreadsheet,
    driveRootFolderConfigured: !!props.getProperty('DRIVE_ROOT_FOLDER_ID'),
    ownerEmail: Session.getEffectiveUser().getEmail() || Session.getActiveUser().getEmail() || null,
    remainingEmailRecipientsToday: MailApp.getRemainingDailyQuota(),
    timezone: Session.getScriptTimeZone()
  };
}

// -----------------------------------------------------------------------------
// HMAC bridge protocol. The Apps Script web app cannot rely on arbitrary HTTP
// request headers in doPost(e), so the signed envelope is carried in JSON.
// Canonical string: timestamp + '.' + nonce + '.' + exact payload JSON string.
// -----------------------------------------------------------------------------

function signEnvelope_(payload) {
  const secret = requiredProperty_('BRIDGE_SECRET');
  const timestamp = String(Date.now());
  const nonce = Utilities.getUuid().replace(/-/g, '');
  const payloadText = JSON.stringify(payload);
  const signature = base64Url_(Utilities.computeHmacSha256Signature(timestamp + '.' + nonce + '.' + payloadText, secret));
  return { timestamp: timestamp, nonce: nonce, payload: payloadText, signature: signature };
}

function verifyEnvelope_(envelope) {
  const secret = requiredProperty_('BRIDGE_SECRET');
  const timestamp = String(envelope.timestamp || '');
  const nonce = String(envelope.nonce || '');
  const payloadText = String(envelope.payload || '');
  const signature = String(envelope.signature || '');
  if (!/^\d{13}$/.test(timestamp) || !/^[a-f0-9]{32}$/i.test(nonce) || !payloadText || !signature) throw new Error('Некоректний підписаний запит.');
  if (Math.abs(Date.now() - Number(timestamp)) > MF.SIGNATURE_WINDOW_MS) throw new Error('Час підписаного запиту минув.');
  const expected = base64Url_(Utilities.computeHmacSha256Signature(timestamp + '.' + nonce + '.' + payloadText, secret));
  if (!constantTimeEqual_(expected, signature)) throw new Error('Невірний підпис Bridge.');
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const cache = CacheService.getScriptCache();
    const key = 'mf_nonce_' + nonce;
    if (cache.get(key)) throw new Error('Повторний запит відхилено.');
    cache.put(key, '1', MF.NONCE_TTL_SECONDS);
  } finally { lock.releaseLock(); }
  return JSON.parse(payloadText);
}

function base64Url_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
}

function constantTimeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function callWorker_(payload) {
  const base = requiredProperty_('WORKER_BASE_URL').replace(/\/+$/, '');
  const response = UrlFetchApp.fetch(base + MF.WORKER_PATH, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(signEnvelope_(payload)),
    muteHttpExceptions: true,
    followRedirects: true
  });
  const code = response.getResponseCode();
  const text = response.getContentText();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('Cloudflare повернув не JSON (HTTP ' + code + ').'); }
  if (code < 200 || code >= 300 || data.error || data.ok === false) {
    throw new Error(data.error || ('Помилка Cloudflare Worker: HTTP ' + code));
  }
  return data.result !== undefined ? data.result : data;
}

function requiredProperty_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error('Не задано Script Property: ' + name);
  return value;
}

// -----------------------------------------------------------------------------
// Google Sheets inventory reader
// -----------------------------------------------------------------------------

function runScheduledSync() {
  const result = syncSpreadsheetToWorker_({ source: 'apps-script-trigger', confirmLargeDecrease: false });
  console.log('Scheduled sync:', JSON.stringify(result));
  return result;
}

function syncNowFromEditor() {
  const result = syncSpreadsheetToWorker_({ source: 'apps-script-manual', confirmLargeDecrease: false });
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function handleSyncRequest_(payload) {
  return syncSpreadsheetToWorker_({
    source: 'cloudflare-manual',
    preview: payload.preview === true,
    confirmLargeDecrease: payload.confirmLargeDecrease === true
  });
}

function syncSpreadsheetToWorker_(options) {
  const parsed = readInventorySpreadsheet_();
  if (!parsed.records.length) throw new Error('Не знайдено жодного валідного об’єкта. Інвентар у Cloudflare не змінено.');
  if (parsed.records.length > MF.MAX_SYNC_RECORDS) throw new Error('Знайдено ' + parsed.records.length + ' об’єктів. Поточна версія bridge обмежена ' + MF.MAX_SYNC_RECORDS + ' об’єктами за один цикл. Старі дані не змінено.');
  const preview = callWorker_({
    action: 'inventory.preview',
    source: options.source || 'apps-script',
    records: parsed.records,
    layers: parsed.layers,
    warnings: parsed.warnings
  });
  if (options.preview) return preview;
  if (preview && preview.requiresConfirmation && !options.confirmLargeDecrease) {
    return { ok: false, requiresConfirmation: true, preview: preview, message: 'Кількість об’єктів скоротилася на 50% або більше. Потрібне ручне підтвердження Admin.' };
  }
  const applied = callWorker_({
    action: 'inventory.apply',
    source: options.source || 'apps-script',
    confirmLargeDecrease: options.confirmLargeDecrease === true,
    records: parsed.records,
    layers: parsed.layers,
    warnings: parsed.warnings
  });
  return { ...applied, warnings: parsed.warnings };
}

function readInventorySpreadsheet_() {
  const spreadsheetId = requiredProperty_('SPREADSHEET_ID');
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheets = ss.getSheets(); // Includes hidden tabs by design.
  const config = readLayerRegistry_(sheets);
  const records = [];
  const layers = [];
  const warnings = [];

  sheets.forEach(sheet => {
    const title = cleanText_(sheet.getName());
    if (!title || MF.CONFIG_SHEET_NAMES.indexOf(title.toLocaleLowerCase('uk-UA')) >= 0) return;
    const range = sheet.getDataRange();
    if (!range || range.getNumRows() < 2 || range.getNumColumns() < 3) return;
    const values = range.getValues();
    const formulas = range.getFormulas();
    const rich = range.getRichTextValues();
    const headerRow = detectHeaderRow_(values);
    if (headerRow < 0) return;
    const headers = values[headerRow].map(v => cleanText_(v));
    const idx = {
      city: headerIndex_(headers, ['місто', 'населений пункт', 'city', 'location']),
      lat: headerIndex_(headers, ['широта', 'latitude', 'lat']),
      lon: headerIndex_(headers, ['довгота', 'longitude', 'lon', 'lng']),
      photo: headerIndex_(headers, ['фото', 'photo']),
      scheme: headerIndex_(headers, ['схема', 'scheme']),
      campaign: headerIndex_(headers, ['кампанія', 'маркетинг', 'campaign', 'marketing']),
      partner: headerIndex_(headers, ['партнер', 'компанія', 'partner', 'company']),
      adformat: headerIndex_(headers, ['формат реклами', 'ad format', 'формат']),
      type: headerIndex_(headers, ['тип', 'type']),
      title: headerIndex_(headers, ['адреса', 'address', 'назва ресторану', 'назва', 'name']),
      restaurant: headerIndex_(headers, ['назва ресторану', 'назва', 'name']),
      restaurantPartner: headerIndex_(headers, ['партнер', 'partner'])
    };
    if (idx.city < 0 || idx.lat < 0 || idx.lon < 0) return;

    const style = applyLayerConfig_(defaultLayerStyle_(title), config[title] || null);
    if (!style.enabled) return;
    const sheetRecords = [];

    for (let r = headerRow + 1; r < values.length; r++) {
      const row = values[r];
      if (!row || row.every(v => v === '' || v === null)) continue;
      const raw = {};
      headers.forEach((h, c) => {
        if (!h) return;
        let value = jsonSafe_(row[c]);
        if (c === idx.photo || c === idx.scheme) {
          value = extractCellUrl_(row[c], formulas[r] ? formulas[r][c] : '', rich[r] ? rich[r][c] : null) || value;
        }
        raw[h] = value;
      });
      const city = raw[headers[idx.city]];
      const lat = numberValue_(raw[headers[idx.lat]]);
      const lon = numberValue_(raw[headers[idx.lon]]);
      if (!city || lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

      const photo = idx.photo >= 0 ? raw[headers[idx.photo]] : null;
      const scheme = idx.scheme >= 0 ? raw[headers[idx.scheme]] : null;
      const titleValue = idx.title >= 0 ? raw[headers[idx.title]] : '';
      const record = Object.assign({}, raw, {
        _id: '',
        _layer: style.key,
        _layer_name: style.name,
        _layer_color: style.color,
        _marker_shape: style.shape,
        _marker_label: style.label,
        _layer_kind: style.kind,
        _campaign: idx.campaign >= 0 ? normalizeValue_(raw[headers[idx.campaign]]) : null,
        _city: String(city),
        _partner: idx.partner >= 0 ? normalizeValue_(raw[headers[idx.partner]]) : null,
        _adformat: idx.adformat >= 0 ? raw[headers[idx.adformat]] : null,
        _type: idx.type >= 0 ? raw[headers[idx.type]] : null,
        _title: titleValue || '',
        _lat: lat,
        _lon: lon,
        _photo: isHttpUrl_(photo) ? String(photo).trim() : null,
        _scheme: isHttpUrl_(scheme) ? String(scheme).trim() : null,
        _source_sheet: title,
        _row: r + 1
      });
      if (style.kind === 'restaurant') {
        record._title = (idx.restaurant >= 0 ? raw[headers[idx.restaurant]] : null) || titleValue || 'Ресторан KFC';
        record._partner = idx.restaurantPartner >= 0 ? normalizeValue_(raw[headers[idx.restaurantPartner]]) : null;
        record._adformat = 'KFC';
      }
      ['Кампанія', 'Маркетинг'].forEach(k => { if (record[k] !== undefined) record[k] = normalizeValue_(record[k]); });
      ['Партнер', 'Компанія'].forEach(k => { if (record[k] !== undefined) record[k] = normalizeValue_(record[k]); });
      record._stable_key = stableIdentity_(title, raw);
      sheetRecords.push(record);
    }

    const counts = {};
    sheetRecords.forEach(x => counts[x._stable_key] = (counts[x._stable_key] || 0) + 1);
    const duplicateKeys = Object.keys(counts).filter(k => counts[k] > 1);
    if (duplicateKeys.length) {
      sheetRecords.forEach(x => {
        if (counts[x._stable_key] > 1) x._stable_key += '|duplicate-row-' + x._row;
      });
      warnings.push('На вкладці «' + title + '» є повторювані ID/ключі. Для дублів використано номер рядка; додай унікальну колонку ID площини.');
    }
    Array.prototype.push.apply(records, sheetRecords);
    if (sheetRecords.length) layers.push(Object.assign({}, style, { count: sheetRecords.length }));
    if (!sheetRecords.length) warnings.push('На вкладці «' + title + '» є колонки координат, але немає валідних записів.');
  });

  const unique = {};
  layers.forEach(l => { unique[l.key] = l; });
  const uniqueLayers = Object.keys(unique).map(k => unique[k]).sort((a,b) => a.sort - b.sort || a.name.localeCompare(b.name, 'uk'));
  const ids = records.map(r => r._stable_key);
  if (new Set(ids).size !== ids.length) throw new Error('Після нормалізації знайдено дублікати стабільних ID. Інвентар не передано.');
  return { records: records, layers: uniqueLayers, warnings: warnings, spreadsheetName: ss.getName() };
}

function readLayerRegistry_(sheets) {
  const found = sheets.find(s => MF.CONFIG_SHEET_NAMES.indexOf(s.getName().toLocaleLowerCase('uk-UA')) >= 0);
  if (!found) return {};
  const values = found.getDataRange().getValues();
  if (values.length < 2) return {};
  const headers = values[0].map(cleanText_);
  const source = headerIndex_(headers, ['назва вкладки', 'вкладка', 'source sheet', 'sheet name']);
  if (source < 0) return {};
  const idx = {
    name: headerIndex_(headers, ['назва шару', 'назва на карті', 'display name', 'назва']),
    color: headerIndex_(headers, ['колір', 'color']),
    shape: headerIndex_(headers, ['форма', 'форма маркера', 'marker shape']),
    label: headerIndex_(headers, ['маркер', 'підпис маркера', 'marker label', 'icon']),
    kind: headerIndex_(headers, ['тип шару', 'категорія', 'layer kind', 'kind']),
    sort: headerIndex_(headers, ['порядок', 'sort order']),
    enabled: headerIndex_(headers, ['активний', 'активна', 'на карті', 'показувати', 'enabled', 'active'])
  };
  const out = {};
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const key = cleanText_(row[source]);
    if (!key) continue;
    const enabledText = idx.enabled < 0 ? 'так' : cleanText_(row[idx.enabled]).toLocaleLowerCase('uk-UA');
    out[key] = {
      name: idx.name < 0 ? key : cleanText_(row[idx.name]),
      color: idx.color < 0 ? '' : cleanText_(row[idx.color]),
      shape: idx.shape < 0 ? '' : cleanText_(row[idx.shape]).toLowerCase(),
      label: idx.label < 0 ? '' : cleanText_(row[idx.label]),
      kind: idx.kind < 0 ? '' : cleanText_(row[idx.kind]).toLowerCase(),
      sort: idx.sort < 0 ? null : numberValue_(row[idx.sort]),
      enabled: ['ні','нет','no','false','0','off','вимкнено'].indexOf(enabledText) < 0
    };
  }
  return out;
}

function defaultLayerStyle_(title) {
  const t = cleanText_(title).toLocaleLowerCase('uk-UA');
  if (['національна оон', 'национальная оон', 'national ooh', 'national promo'].indexOf(t) >= 0) return { key: 'promo', sourceSheet: title, name: 'Національна · ПРОМО', color: '#005EFF', shape: 'circle', label: '', kind: 'media', sort: 10, enabled: true };
  if (['локальна', 'local'].indexOf(t) >= 0) return { key: 'local', sourceSheet: title, name: 'Локальна', color: '#25FF08', shape: 'diamond', label: '', kind: 'media', sort: 20, enabled: true };
  if (['адреси ресторанів', 'ресторани kfc', 'kfc restaurants'].indexOf(t) >= 0) return { key: 'restaurant', sourceSheet: title, name: 'Ресторани KFC', color: '#B5232F', shape: 'circle', label: 'KFC', kind: 'restaurant', sort: 30, enabled: true };
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
  const slug = t.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 42) || 'custom';
  return { key: 'custom-' + slug + '-' + hash.toString(16).slice(0, 6), sourceSheet: title, name: title, color: MF.PALETTE[hash % MF.PALETTE.length], shape: 'square', label: '', kind: 'media', sort: 100, enabled: true };
}

function applyLayerConfig_(base, config) {
  if (!config) return base;
  const color = /^#[0-9a-f]{6}$/i.test(config.color || '') ? config.color : base.color;
  const shapes = { 'коло':'circle', 'ромб':'diamond', 'квадрат':'square', 'мітка':'pin' };
  const requested = shapes[config.shape] || config.shape;
  const shape = ['circle','diamond','square','pin'].indexOf(requested) >= 0 ? requested : base.shape;
  let kind = config.kind;
  if (['ресторан','ресторани','restaurants'].indexOf(kind) >= 0) kind = 'restaurant';
  if (['media','restaurant'].indexOf(kind) < 0) kind = base.kind;
  return Object.assign({}, base, {
    name: config.name || base.name,
    color: color,
    shape: shape,
    label: String(config.label || base.label || '').slice(0, 8),
    kind: kind,
    sort: config.sort === null ? base.sort : Number(config.sort),
    enabled: config.enabled !== false
  });
}

function detectHeaderRow_(values) {
  for (let r = 0; r < Math.min(values.length, 20); r++) {
    const h = values[r].map(cleanText_);
    if (headerIndex_(h, ['місто','населений пункт','city','location']) >= 0 &&
        headerIndex_(h, ['широта','latitude','lat']) >= 0 &&
        headerIndex_(h, ['довгота','longitude','lon','lng']) >= 0) return r;
  }
  return -1;
}

function headerIndex_(headers, aliases) {
  const normalized = headers.map(h => cleanText_(h).toLocaleLowerCase('uk-UA').replace(/[’'`]/g, ''));
  for (let a = 0; a < aliases.length; a++) {
    const key = cleanText_(aliases[a]).toLocaleLowerCase('uk-UA').replace(/[’'`]/g, '');
    const idx = normalized.indexOf(key);
    if (idx >= 0) return idx;
  }
  return -1;
}

function extractCellUrl_(value, formula, richText) {
  if (richText) {
    try {
      const direct = richText.getLinkUrl();
      if (direct) return direct;
      const runs = richText.getRuns();
      for (let i = 0; i < runs.length; i++) {
        const link = runs[i].getLinkUrl();
        if (link) return link;
      }
    } catch (e) {}
  }
  const f = String(formula || '');
  const fm = f.match(/HYPERLINK\s*\(\s*["'](https?:\/\/[^"']+)/i);
  if (fm) return fm[1];
  const s = String(value || '').trim();
  return isHttpUrl_(s) ? s : null;
}

function stableIdentity_(sourceSheet, raw) {
  const ids = ['ID площини', 'Унікальний ID', 'Унікальний ідентифікатор', 'ID', 'Код площини', 'Новий Код', 'Код', 'Артикул'];
  for (let i = 0; i < ids.length; i++) {
    const value = raw[ids[i]];
    if (value !== null && value !== undefined && cleanText_(value) !== '') return sourceSheet + '|id|' + cleanText_(value);
  }
  const city = cleanText_(raw['Місто'] || raw['City']);
  const address = cleanText_(raw['Адреса'] || raw['Address'] || raw['Назва ресторану'] || raw['Назва']);
  const partner = cleanText_(raw['Партнер'] || raw['Компанія'] || raw['Partner']);
  const kind = cleanText_(raw['Тип'] || raw['Формат реклами'] || raw['Type']);
  const side = cleanText_(raw['Сторона'] || raw['Side']);
  const format = cleanText_(raw['Формат (ширина/висота)'] || raw['Формат'] || raw['Format']);
  return sourceSheet + '|composite|' + [city, address, partner, kind, side, format].map(s => s.toLocaleLowerCase('uk-UA')).join('|');
}

function normalizeValue_(value) {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (s === 'Локальный' || s === 'Локальний') return 'Локальний';
  if (s === 'DTS' || s === 'DTS-Kharkiv') return 'DTS-Kharkiv';
  return s;
}

function numberValue_(value) {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  if (typeof value === 'number') return isFinite(value) ? value : null;
  const n = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) ? n : null;
}

function cleanText_(value) {
  return String(value === null || value === undefined ? '' : value).trim().replace(/\s+/g, ' ');
}

function jsonSafe_(value) {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined || value === null) return value === undefined ? null : null;
  if (typeof value === 'number' && !isFinite(value)) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

function isHttpUrl_(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

// -----------------------------------------------------------------------------
// Google Drive private library and queue processor
// -----------------------------------------------------------------------------

function processAssetQueue() {
  const result = processAssetBatch_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function processAssetBatch_() {
  const completed = [];
  const max = MF.MAX_ASSETS_PER_RUN;
  for (let i = 0; i < max; i++) {
    let job;
    try { job = callWorker_({ action: 'assets.next' }); }
    catch (e) { throw new Error('Не вдалося отримати завдання з Cloudflare: ' + e.message); }
    const asset = job && (job.asset || job.result && job.result.asset);
    if (!asset) break;
    completed.push(processOneAsset_(asset));
  }
  return { processed: completed.length, results: completed };
}

function processOneAsset_(asset) {
  let createdFile = null;
  try {
    if (!asset.id || !asset.sourceUrl || !asset.stableKey) throw new Error('Неповні дані завдання з Cloudflare.');
    const media = downloadPartnerImage_(asset.sourceUrl);
    const folders = getDriveFolderSet_();
    const name = buildAssetName_(asset, media.extension);
    const blob = Utilities.newBlob(media.bytes, media.mimeType, name);
    createdFile = Drive.Files.create({
      name: name,
      mimeType: media.mimeType,
      parents: [asset.assetType === 'scheme' ? folders.schemesFolderId : folders.photosFolderId],
      description: 'Media First OOH | ' + asset.assetType + ' | ' + asset.stableKey + ' | source: ' + asset.sourceUrl
    }, blob, { fields: 'id,name,mimeType,webViewLink,size' });
    if (!createdFile || !createdFile.id) throw new Error('Google Drive не повернув ID створеного файла.');
    if (!createdFile.webViewLink) createdFile = Drive.Files.get(createdFile.id, { fields: 'id,name,mimeType,webViewLink,size' });

    const result = callWorker_({
      action: 'assets.complete',
      id: asset.id,
      status: 'copied',
      driveFileId: createdFile.id,
      driveWebViewLink: createdFile.webViewLink || '',
      mimeType: media.mimeType,
      fileName: name,
      fileSize: media.bytes.length
    });
    if (asset.driveFileId && asset.driveFileId !== createdFile.id) {
      try { Drive.Files.update({ trashed: true }, asset.driveFileId, null, { fields: 'id,trashed' }); } catch (e) { console.warn('Old asset copy could not be trashed: ' + e.message); }
    }
    return { id: asset.id, status: 'copied', driveFileId: createdFile.id, worker: result };
  } catch (e) {
    if (createdFile) {
      // Keep an orphaned file rather than deleting a potentially successful upload
      // if the Cloudflare callback was interrupted; it can be reconciled later.
      console.warn('Drive file may need reconciliation: ' + (createdFile.id || 'unknown'));
    }
    const message = String(e && e.message ? e.message : e).slice(0, 1000);
    try {
      callWorker_({ action: 'assets.complete', id: asset.id, status: 'needs_attention', errorMessage: message });
    } catch (callbackError) { console.error('Could not report asset failure: ' + callbackError.message); }
    return { id: asset.id, status: 'needs_attention', error: message };
  }
}

function getDriveFolderSet_() {
  const folders = setupDriveLibrary_();
  return folders;
}

function buildAssetName_(asset, extension) {
  const sheet = safeFilePart_(asset.sourceSheet || 'Sheet');
  const title = safeFilePart_(asset.objectTitle || asset.stableKey || 'OOH');
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(asset.stableKey)).slice(0, 6).map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
  return (sheet + '_' + title + '_' + hash + '_' + asset.assetType + '.' + extension).slice(0, 180);
}

function safeFilePart_(value) {
  return String(value || 'asset').normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 55) || 'asset';
}

function downloadPartnerImage_(sourceUrl) {
  let fetched = fetchAllowlisted_(sourceUrl, 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8');
  let response = fetched.response;
  let type = String(response.getHeaders()['Content-Type'] || response.getHeaders()['content-type'] || '').split(';')[0].toLowerCase();
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) throw new Error('Джерело повернуло HTTP ' + response.getResponseCode() + '.');

  if (type.indexOf('image/') !== 0) {
    const html = response.getContentText().slice(0, 2 * 1024 * 1024);
    const imageUrl = extractImageFromHtml_(html, fetched.url);
    if (!imageUrl) throw new Error('На сторінці партнера не знайдено прямого фото. Може знадобитися доступ або JavaScript-обробник.');
    fetched = fetchAllowlisted_(imageUrl, 'image/*');
    response = fetched.response;
    type = String(response.getHeaders()['Content-Type'] || response.getHeaders()['content-type'] || '').split(';')[0].toLowerCase();
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) throw new Error('Не вдалося завантажити зображення: HTTP ' + response.getResponseCode());
  }

  const bytes = response.getContent();
  const maxBytes = Number(PropertiesService.getScriptProperties().getProperty('MAX_ASSET_BYTES') || MF.MAX_ASSET_BYTES_DEFAULT);
  if (!bytes || !bytes.length) throw new Error('Отримано порожній файл.');
  if (bytes.length > maxBytes) throw new Error('Файл перевищує ліміт ' + Math.round(maxBytes / 1024 / 1024) + ' MB.');
  const mime = detectImageMime_(bytes, type);
  const extension = ({ 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp', 'image/gif':'gif', 'image/avif':'avif' })[mime];
  return { bytes: bytes, mimeType: mime, extension: extension };
}

function fetchAllowlisted_(initialUrl, accept) {
  let current = String(initialUrl);
  for (let i = 0; i < 6; i++) {
    const parsed = parseUrl_(current);
    if (!parsed || !isAllowedHost_(parsed.hostname)) throw new Error('Домен джерела або редиректу не входить до списку дозволених.');
    const response = UrlFetchApp.fetch(current, {
      method: 'get',
      followRedirects: false,
      muteHttpExceptions: true,
      validateHttpsCertificates: true,
      headers: { 'Accept': accept, 'User-Agent': 'MediaFirstOOH-AssetLibrary/1.0' }
    });
    const code = response.getResponseCode();
    if ([301,302,303,307,308].indexOf(code) >= 0) {
      const h = response.getHeaders();
      const location = h.Location || h.location;
      if (!location) throw new Error('Редирект не містить адреси Location.');
      current = resolveUrl_(String(location), current);
      continue;
    }
    return { response: response, url: current };
  }
  throw new Error('Занадто багато перенаправлень.');
}

function parseUrl_(value) {
  const match = String(value || '').match(/^https?:\/\/([^\/?#]+)(?:[\/?#]|$)/i);
  return match ? { hostname: match[1].split(':')[0].toLowerCase() } : null;
}

function isAllowedHost_(host) {
  if (MF.ASSET_HOSTS.indexOf(host) >= 0) return true;
  return host.endsWith('.sharepoint.com') || host.endsWith('.googleusercontent.com');
}

function resolveUrl_(child, base) {
  if (/^https?:\/\//i.test(child)) return child;
  const m = String(base).match(/^(https?:\/\/[^/]+)/i);
  if (!m) throw new Error('Не вдалося обчислити адресу зображення.');
  if (child.indexOf('//') === 0) return m[1].split(':')[0] + ':' + child;
  if (child.charAt(0) === '/') return m[1] + child;
  const path = String(base).replace(/[?#].*$/, '').replace(/[^/]*$/, '');
  return path + child;
}

function extractImageFromHtml_(html, pageUrl) {
  const meta = html.match(/<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
               html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/i);
  if (meta) return resolveUrl_(decodeHtml_(meta[1]), pageUrl);
  const img = html.match(/<(?:img|source)\b[^>]*(?:data-src|data-original|src)=["']([^"']+)["']/i);
  return img ? resolveUrl_(decodeHtml_(img[1]), pageUrl) : null;
}

function decodeHtml_(value) {
  return String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function detectImageMime_(bytes, contentType) {
  const type = String(contentType || '').toLowerCase();
  if (['image/jpeg','image/png','image/webp','image/gif','image/avif'].indexOf(type) >= 0) return type;
  const u = bytes.map(b => (b + 256) % 256);
  if (u[0] === 255 && u[1] === 216 && u[2] === 255) return 'image/jpeg';
  if (u[0] === 137 && u[1] === 80 && u[2] === 78 && u[3] === 71) return 'image/png';
  const first6 = String.fromCharCode.apply(null, u.slice(0, 6));
  if (first6 === 'GIF87a' || first6 === 'GIF89a') return 'image/gif';
  if (String.fromCharCode.apply(null, u.slice(0, 4)) === 'RIFF' && String.fromCharCode.apply(null, u.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (type === 'image/svg+xml') throw new Error('SVG автоматично не копіюється з міркувань безпеки.');
  throw new Error('Джерело повернуло не підтримуване зображення (' + (type || 'невідомий MIME') + ').');
}

function downloadDriveAsset_(payload) {
  const id = String(payload.driveFileId || '');
  if (!id) throw new Error('Не вказано Drive File ID.');
  const meta = Drive.Files.get(id, { fields: 'id,name,mimeType,size,trashed' });
  if (meta.trashed) throw new Error('Файл у Google Drive переміщено до кошика.');
  const response = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media', {
    method: 'get',
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) throw new Error('Google Drive не дозволив прочитати файл (HTTP ' + response.getResponseCode() + ').');
  const bytes = response.getContent();
  const maxBytes = Number(PropertiesService.getScriptProperties().getProperty('MAX_ASSET_BYTES') || MF.MAX_ASSET_BYTES_DEFAULT);
  if (bytes.length > maxBytes) throw new Error('Файл перевищує ліміт перегляду.');
  return {
    fileBase64: Utilities.base64Encode(bytes),
    mimeType: meta.mimeType || response.getHeaders()['Content-Type'] || 'application/octet-stream',
    fileName: meta.name || 'asset',
    size: bytes.length
  };
}

// -----------------------------------------------------------------------------
// Mail delivery via the owner's Google account (MailApp)
// -----------------------------------------------------------------------------

function sendTestMail_() {
  const recipient = Session.getEffectiveUser().getEmail() || Session.getActiveUser().getEmail();
  if (!recipient) throw new Error('Google не повернув email власника Apps Script. Перевір акаунт, від імені якого виконується Web App.');
  const subject = 'Тест Media First OOH Platform';
  const body = 'Вітаємо!\n\nЦе тестове повідомлення перевірки Google Apps Script MailApp для Media First OOH Platform.\n\nЯкщо ти отримала цей лист, надсилання налаштовано.';
  const remaining = MailApp.getRemainingDailyQuota();
  if (remaining < 1) throw new Error('Вичерпано денну квоту одержувачів MailApp.');
  MailApp.sendEmail({ to: recipient, subject: subject, body: body, name: 'Media First OOH' });
  return { ok: true, recipient: recipient, remainingRecipientsToday: MailApp.getRemainingDailyQuota() };
}

function sendMail_(payload) {
  const to = String(payload.to || '').trim();
  const subject = String(payload.subject || 'Media First OOH').slice(0, 250);
  const body = String(payload.body || 'Надсилаємо адресну програму Media First OOH.').slice(0, 10000);
  if (!/^\S+@\S+\.\S+$/.test(to)) throw new Error('Некоректна адреса одержувача.');
  if (!payload.fileBase64) throw new Error('Не передано Excel-вкладення.');
  const bytes = Utilities.base64Decode(String(payload.fileBase64));
  if (bytes.length > 25 * 1024 * 1024) throw new Error('Excel-вкладення перевищує 25 MB.');
  const filename = safeFilePart_(payload.filename || 'OOH_program.xlsx');
  const blob = Utilities.newBlob(bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename);
  const remaining = MailApp.getRemainingDailyQuota();
  if (remaining < 1) throw new Error('Вичерпано денну квоту одержувачів MailApp.');
  MailApp.sendEmail({
    to: to,
    subject: subject,
    body: body,
    attachments: [blob],
    name: 'Media First OOH'
  });
  return { ok: true, recipient: to, subject: subject, filename: filename, remainingRecipientsToday: MailApp.getRemainingDailyQuota() };
}

// -----------------------------------------------------------------------------
// Installable triggers. These run under the Google account that installs them.
// -----------------------------------------------------------------------------

function installBridgeTriggers() {
  checkBridgeSetup();
  removeBridgeTriggers();
  ScriptApp.newTrigger('runScheduledSync').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('processAssetQueue').timeBased().everyMinutes(5).create();
  Logger.log('✅ Встановлено: синхронізація Sheets кожні 15 хвилин; черга фото кожні 5 хвилин.');
  return { ok: true, triggers: ['runScheduledSync: every 15 minutes', 'processAssetQueue: every 5 minutes'] };
}

function removeBridgeTriggers() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    const fn = trigger.getHandlerFunction();
    if (fn === 'runScheduledSync' || fn === 'processAssetQueue') ScriptApp.deleteTrigger(trigger);
  });
}

// -----------------------------------------------------------------------------
// Small manual tests
// -----------------------------------------------------------------------------

function testSpreadsheetRead() {
  const result = readInventorySpreadsheet_();
  const counts = {};
  result.records.forEach(r => counts[r._layer] = (counts[r._layer] || 0) + 1);
  const summary = { spreadsheetName: result.spreadsheetName, records: result.records.length, layers: result.layers, counts: counts, warnings: result.warnings };
  Logger.log(JSON.stringify(summary, null, 2));
  return summary;
}

function testBridgeConnection() {
  const result = callWorker_({ action: 'bridge.health' });
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function testDriveLibrarySetup() {
  const result = setupDriveLibrary_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function testMailQuota() {
  const result = { remainingRecipientsToday: MailApp.getRemainingDailyQuota() };
  Logger.log(JSON.stringify(result));
  return result;
}
