const CONFIG_SHEET_NAMES = new Set(["налаштування шарів", "ooh layers", "_layers", "layers"]);
const HEADER_ALIASES = {
  city: ["місто", "населений пункт", "city", "location"],
  latitude: ["широта", "latitude", "lat"],
  longitude: ["довгота", "longitude", "lon", "lng"],
  address: ["адреса", "address", "локація", "location address"],
  name: ["назва ресторану", "назва", "name", "object name"],
  uniqueId: ["id площини", "унікальний id", "унікальний ідентифікатор", "id", "код площини", "новий код", "код", "артикул"],
};
const PALETTE = ["#7C3AED", "#F59E0B", "#06B6D4", "#E11D48", "#16A34A", "#9333EA", "#EA580C", "#0F766E"];
const normText = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
const normalize = (value) => {
  if (typeof value !== "string") return value;
  const s = value.trim();
  if (s === "Локальный" || s === "Локальний") return "Локальний";
  if (s === "DTS" || s === "DTS-Kharkiv") return "DTS-Kharkiv";
  return s;
};
function cellPrimitive(value, fallback) {
  if (!value) return fallback ?? null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.numberValue !== undefined) return value.numberValue;
  if (value.boolValue !== undefined) return value.boolValue;
  return fallback ?? null;
}
export function cellValue(cell) {
  if (!cell) return null;
  return cellPrimitive(cell.effectiveValue, cell.formattedValue)
    ?? cellPrimitive(cell.userEnteredValue, cell.formattedValue);
}
function parseHyperlink(value) {
  if (typeof value !== "string") return null;
  return value.match(/HYPERLINK\s*\(\s*["'](https?:\/\/[^"']+)["']/i)?.[1] || null;
}
export function cellLink(cell, value) {
  if (cell?.hyperlink) return cell.hyperlink;
  const run = cell?.textFormatRuns?.find((r) => r.format?.link?.uri);
  if (run?.format?.link?.uri) return run.format.link.uri;
  return parseHyperlink(cell?.userEnteredValue?.formulaValue || value);
}
function numberValue(value) {
  if (value === null || value === undefined || value === "" || value === "-") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function headerKey(value) {
  return normText(value).toLocaleLowerCase("uk-UA").replace(/[’'`]/g, "");
}
function headerIndex(headers, aliases) {
  const lookup = new Map(headers.map((h, i) => [headerKey(h), i]));
  for (const a of aliases) if (lookup.has(headerKey(a))) return lookup.get(headerKey(a));
  return -1;
}
function rowObject(headers, cells, photoIndex = -1, schemeIndex = -1) {
  const out = {};
  for (let i = 0; i < headers.length; i++) {
    const cell = cells?.[i];
    let value = cellValue(cell);
    if (i === photoIndex || i === schemeIndex) value = cellLink(cell, value) || value;
    out[headers[i]] = value;
  }
  return out;
}
function titleStyle(title) {
  const t = normText(title).toLocaleLowerCase("uk-UA");
  if (["національна оон", "национальная оон", "national ooh", "national promo"].includes(t)) return { key: "promo", name: "Національна · ПРОМО", color: "#005EFF", shape: "circle", label: "", kind: "media", sort: 10 };
  if (["локальна", "local"].includes(t)) return { key: "local", name: "Локальна", color: "#25FF08", shape: "diamond", label: "", kind: "media", sort: 20 };
  if (["адреси ресторанів", "ресторани kfc", "kfc restaurants"].includes(t)) return { key: "restaurant", name: "Ресторани KFC", color: "#B5232F", shape: "circle", label: "KFC", kind: "restaurant", sort: 30 };
  const slug = t.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 42) || "custom";
  let hash = 0; for (const c of title) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return { key: `custom-${slug}-${hash.toString(16).slice(0, 6)}`, name: title, color: PALETTE[hash % PALETTE.length], shape: "square", label: "", kind: "media", sort: 100 };
}
function findConfigRows(sheets) {
  const configSheet = sheets.find((s) => CONFIG_SHEET_NAMES.has(normText(s.properties?.title).toLocaleLowerCase("uk-UA")));
  if (!configSheet) return new Map();
  const rows = configSheet.data?.[0]?.rowData || [];
  const headers = (rows[0]?.values || []).map((c) => normText(cellValue(c)));
  const col = (names) => headerIndex(headers, names);
  const sourceCol = col(["Назва вкладки", "Вкладка", "Source sheet", "Sheet name"]);
  if (sourceCol < 0) return new Map();
  const nameCol = col(["Назва шару", "Назва на карті", "Display name", "Назва"]);
  const colorCol = col(["Колір", "Color"]);
  const shapeCol = col(["Форма", "Форма маркера", "Marker shape"]);
  const labelCol = col(["Маркер", "Підпис маркера", "Marker label", "Icon"]);
  const kindCol = col(["Тип шару", "Категорія", "Layer kind", "Kind"]);
  const sortCol = col(["Порядок", "Sort order"]);
  const enabledCol = col(["Активний", "Активна", "На карті", "Показувати", "Enabled", "Active"]);
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i]?.values || [];
    const source = normText(cellValue(cells[sourceCol]));
    if (!source) continue;
    map.set(source, {
      name: normText(cellValue(cells[nameCol])) || source,
      color: normText(cellValue(cells[colorCol])),
      shape: normText(cellValue(cells[shapeCol])).toLowerCase(),
      label: normText(cellValue(cells[labelCol])),
      kind: normText(cellValue(cells[kindCol])).toLowerCase(),
      sort: numberValue(cellValue(cells[sortCol])),
      enabled: enabledCol < 0 ? true : !["ні", "нет", "no", "false", "0", "off", "вимкнено"].includes(normText(cellValue(cells[enabledCol])).toLocaleLowerCase("uk-UA"))
    });
  }
  return map;
}
function applyLayerConfig(base, config) {
  const color = /^#[0-9a-f]{6}$/i.test(config?.color || "") ? config.color : base.color;
  const shapeAliases = { "коло": "circle", "ромб": "diamond", "квадрат": "square", "мітка": "pin" };
  const requestedShape = shapeAliases[config?.shape] || config?.shape;
  const allowedShapes = new Set(["circle", "diamond", "square", "pin"]);
  const shape = allowedShapes.has(requestedShape) ? requestedShape : base.shape;
  const requestedKind = ["ресторан", "ресторани", "restaurants"].includes(config?.kind) ? "restaurant" : config?.kind;
  const kind = ["media", "restaurant"].includes(requestedKind) ? requestedKind : base.kind;
  return {
    key: base.key,
    sourceSheet: base.sourceSheet,
    name: config?.name || base.name,
    color,
    shape,
    label: (config?.label || base.label || "").slice(0, 8),
    kind,
    sort: Number.isFinite(config?.sort) ? config.sort : base.sort,
    enabled: config?.enabled !== false,
  };
}
function stableIdentity(sourceSheet, raw, layerMeta) {
  const unique = ["ID площини", "Унікальний ID", "Унікальний ідентифікатор", "ID", "Код площини", "Новий Код", "Код", "Артикул"];
  let value = null;
  for (const key of unique) {
    const candidate = raw[key];
    if (candidate !== null && candidate !== undefined && normText(candidate) !== "") {
      value = normText(candidate);
      break;
    }
  }
  if (value) return `${sourceSheet}|id|${value}`;
  const city = normText(raw["Місто"] ?? raw["City"]);
  const address = normText(raw["Адреса"] ?? raw["Address"] ?? raw["Назва ресторану"] ?? raw["Назва"]);
  const partner = normText(raw["Партнер"] ?? raw["Компанія"] ?? raw["Partner"]);
  const kind = normText(raw["Тип"] ?? raw["Формат реклами"] ?? raw["Type"]);
  const side = normText(raw["Сторона"] ?? raw["Side"]);
  const format = normText(raw["Формат (ширина/висота)"] ?? raw["Формат"] ?? raw["Format"]);
  const identity = [city, address, partner, kind, side, format].map((x) => x.toLocaleLowerCase("uk-UA")).join("|");
  return `${sourceSheet}|composite|${identity}`;
}
export function isLargeDecrease(previousCount, nextCount) {
  const before = Number(previousCount) || 0;
  const after = Number(nextCount) || 0;
  return before > 0 && after <= before * 0.5;
}
export function stableKeyFromRecord(record) {
  if (record?._stable_key) return record._stable_key;
  const source = record?._source_sheet || record?.source_sheet || record?._layer || "unknown";
  return stableIdentity(source, record || {}, { key: record?._layer || "" });
}
function detectHeaderRow(rowData) {
  for (let i = 0; i < Math.min(rowData.length, 20); i++) {
    const headers = (rowData[i]?.values || []).map((c) => cellValue(c));
    if (headerIndex(headers, HEADER_ALIASES.city) >= 0 && headerIndex(headers, HEADER_ALIASES.latitude) >= 0 && headerIndex(headers, HEADER_ALIASES.longitude) >= 0) return i;
  }
  return -1;
}
function safePhoto(raw, headerNames) {
  for (const name of headerNames) {
    const value = raw[name];
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value.trim();
  }
  return null;
}
function mapHeaderValue(raw, aliases) {
  const keys = Object.keys(raw);
  for (const alias of aliases) {
    const found = keys.find((k) => headerKey(k) === headerKey(alias));
    if (found !== undefined) return raw[found];
  }
  return null;
}
export function parseSpreadsheetSheets(sheets) {
  const configMap = findConfigRows(sheets);
  const records = [];
  const layers = [];
  const warnings = [];
  for (const sheet of sheets || []) {
    const title = normText(sheet.properties?.title);
    if (!title || CONFIG_SHEET_NAMES.has(title.toLocaleLowerCase("uk-UA"))) continue;
    const rowData = sheet.data?.[0]?.rowData || [];
    const headerRowIndex = detectHeaderRow(rowData);
    if (headerRowIndex < 0) continue;
    const headers = (rowData[headerRowIndex]?.values || []).map((c) => normText(cellValue(c)));
    const index = {
      city: headerIndex(headers, HEADER_ALIASES.city),
      lat: headerIndex(headers, HEADER_ALIASES.latitude),
      lon: headerIndex(headers, HEADER_ALIASES.longitude),
      photo: headerIndex(headers, ["Фото", "Photo"]),
      scheme: headerIndex(headers, ["Схема", "Scheme"]),
      campaign: headerIndex(headers, ["Кампанія", "Маркетинг", "Campaign", "Marketing"]),
      partner: headerIndex(headers, ["Партнер", "Компанія", "Partner", "Company"]),
      adformat: headerIndex(headers, ["Формат реклами", "Ad format", "Формат"]),
      type: headerIndex(headers, ["Тип", "Type"]),
      title: headerIndex(headers, ["Адреса", "Address", "Назва ресторану", "Назва", "Name"]),
      restaurant: headerIndex(headers, ["Назва ресторану", "Назва", "Name"]),
      restaurantPartner: headerIndex(headers, ["Партнер", "Partner"]),
    };
    if (index.city < 0 || index.lat < 0 || index.lon < 0) continue;
    const style = applyLayerConfig({ ...titleStyle(title), sourceSheet: title }, configMap.get(title));
    if (!style.enabled) continue;
    const sheetRecords = [];
    const get = (raw, i) => i < 0 ? null : raw[headers[i]];
    for (let r = headerRowIndex + 1; r < rowData.length; r++) {
      const cells = rowData[r]?.values || [];
      if (!cells.length) continue;
      const raw = rowObject(headers, cells, index.photo, index.scheme);
      const city = get(raw, index.city);
      const lat = numberValue(get(raw, index.lat));
      const lon = numberValue(get(raw, index.lon));
      if (!city || lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
      const campaign = normalize(get(raw, index.campaign));
      const partner = normalize(get(raw, index.partner));
      const photoValue = get(raw, index.photo);
      const schemeValue = get(raw, index.scheme);
      const titleValue = get(raw, index.title) || "";
      const record = {
        _id: "",
        _layer: style.key,
        _layer_name: style.name,
        _layer_color: style.color,
        _marker_shape: style.shape,
        _marker_label: style.label,
        _layer_kind: style.kind,
        _campaign: campaign,
        _city: city,
        _partner: partner,
        _adformat: get(raw, index.adformat) || null,
        _type: get(raw, index.type) || null,
        _title: titleValue,
        _lat: lat,
        _lon: lon,
        _photo: typeof photoValue === "string" && /^https?:\/\//i.test(photoValue) ? photoValue.trim() : null,
        _scheme: typeof schemeValue === "string" && /^https?:\/\//i.test(schemeValue) ? schemeValue.trim() : null,
        _source_sheet: title,
        _row: r + 1,
        ...raw
      };
      if (style.kind === "restaurant") {
        record._title = get(raw, index.restaurant) || titleValue || "Ресторан KFC";
        record._partner = normalize(get(raw, index.restaurantPartner) || null);
        record._adformat = "KFC";
      }
      for (const k of ["Кампанія", "Маркетинг"]) if (record[k] !== undefined) record[k] = normalize(record[k]);
      for (const k of ["Партнер", "Компанія"]) if (record[k] !== undefined) record[k] = normalize(record[k]);
      record._stable_key = stableIdentity(title, raw, style);
      sheetRecords.push(record);
    }
    const keyCounts = new Map();
    for (const r of sheetRecords) keyCounts.set(r._stable_key, (keyCounts.get(r._stable_key) || 0) + 1);
    const collisions = [...keyCounts].filter(([, count]) => count > 1);
    if (collisions.length) {
      for (const r of sheetRecords) {
        if (keyCounts.get(r._stable_key) > 1) r._stable_key = `${r._stable_key}|duplicate-row-${r._row}`;
      }
      warnings.push(`На вкладці «${title}» є ${collisions.length} повторюваних ключів. Для них тимчасово використано номер рядка; додай унікальні ID для повністю стабільного відстеження.`);
    }
    records.push(...sheetRecords);
    if (sheetRecords.length) layers.push({ ...style, count: sheetRecords.length });
    if (!sheetRecords.length) warnings.push(`На вкладці «${title}» знайдені колонки координат, але не знайдено рядків із коректним містом і координатами.`);
  }
  const uniqueLayers = [...new Map(layers.map((l) => [l.key, l])).values()].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "uk"));
  return { records, layers: uniqueLayers, warnings };
}
