// AI に頼む部品（旅ルートくん OpenAI 版・1.1.0＝金庫番の形・2026-11-17 とと）。
// アプリは OpenAI に直接頼まん。とと の Apps Script（金庫番・relay/Code.gs）に頼み、金庫番が とと の OpenAI キーで OpenAI に頼む。
// キーはアプリにもスマホにも入らん。アプリが持つのは「金庫番の住所」と「合言葉」だけ。
// 指示の文・答えの形・モデルの決め打ち・1 日の回数の上限は金庫番の側（アプリから変えられん）。
// 送り方：POST・本文は JSON を text/plain で（Apps Script は事前確認（preflight）に答えられんので、単純な頼み方にする）。
// Apps Script は失敗でも HTTP 200 で返すので、本文の ok／status／code で見分ける。

// 好みの順。gpt-6-luna＝一番安くて速い（入力 0.1 ドル／出力 0.5 ドル・100 万語あたり）。
// キー確認（models の一覧）で使えると分かったものの中から、この順で選ぶ。
export const MODEL_PREFERENCE = [
  'gpt-6-luna',
  'gpt-6.1-terra',
  'gpt-5-mini',
  'gpt-4.1-mini',
  'gpt-4o-mini',
];

export class AiError extends Error {
  constructor(message, status, code = null) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.code = code; // OpenAI の error.code（insufficient_quota・rate_limit_exceeded など）
    this.kind = classifyError(status);
  }
}

/** 401/403＝キー・429＝利用の上限（残高不足または混雑）・それ以外＝その他（400 はキーやない＝頼み方の問題）。 */
export function classifyError(status) {
  if (status === 401 || status === 403) return 'key';
  if (status === 429) return 'quota';
  return 'other';
}

/** models の一覧（id）から、好みの順で最初に見つかったものを返す。 */
export function pickModel(modelNames) {
  const names = new Set((modelNames || []).map((n) => String(n).replace(/^models\//, '')));
  return MODEL_PREFERENCE.find((m) => names.has(m)) ?? null;
}

/** 返事の文から JSON オブジェクトを取り出す。``` や前置きを落とし、最初の { から最後の } まで。 */
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function httpsOrNull(v) {
  const s = strOrNull(v);
  return s && /^https:\/\//i.test(s) ? s : null;
}

/** AI の JSON を決まった形に揃える。spots が無い／name のある場所が 1 つも無ければ null。 */
export function normalizeTripJson(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (!Array.isArray(obj.spots)) return null;
  const spots = obj.spots
    .filter((s) => s && typeof s === 'object' && typeof s.name === 'string' && s.name.trim())
    .map((s) => {
      const m = s.move_to_next;
      const move = m && typeof m === 'object'
        ? { mode: strOrNull(m.mode), minutes: numOrNull(m.minutes), note: strOrNull(m.note) }
        : null;
      return {
        name: s.name.trim(),
        kind: strOrNull(s.kind),
        summary: strOrNull(s.summary),
        stay_minutes: numOrNull(s.stay_minutes),
        cost_yen: numOrNull(s.cost_yen),
        cost_note: strOrNull(s.cost_note),
        hours: strOrNull(s.hours),
        official_url: httpsOrNull(s.official_url),
        move_to_next: move,
      };
    });
  if (spots.length === 0) return null;
  return { destination: strOrNull(obj.destination), area: strOrNull(obj.area), spots };
}

// ---- v1.2（設計書 §17.4）：AI は候補の id を選ぶだけ
export const KIND_LIST = ['観光', '自然', '買い物', '体験', '温泉'];
export const DEFAULT_STAY = { 観光: 60, 自然: 60, 買い物: 45, 体験: 90, 温泉: 90 };
const STAY_MIN = 15;
const STAY_MAX = 240;

/**
 * {picks:[{id,kind,reason,stay_minutes,cost_yen,cost_note}]} → [{candidate, kind, reason, stay_minutes, cost_yen, cost_note, priority}]。
 * 候補に無い id と重複は捨てる。知らん種別は「観光」。滞在が無ければ種別の既定、15〜240 分に収める。
 * picks が配列でなければ null。空なら []。
 */
export function normalizePicks(obj, candidates) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !Array.isArray(obj.picks)) return null;
  const byId = new Map((candidates || []).map((c) => [String(c.id), c]));
  const used = new Set();
  const out = [];
  for (const p of obj.picks) {
    if (!p || typeof p !== 'object') continue;
    let id = p.id === null || p.id === undefined ? '' : String(p.id).trim();
    if (/^\d+$/.test(id)) id = `c${id}`;
    const cand = byId.get(id);
    if (!cand || used.has(id)) continue;
    used.add(id);
    const kind = KIND_LIST.includes(p.kind) ? p.kind : '観光';
    const stayRaw = numOrNull(p.stay_minutes);
    const stay = Math.min(STAY_MAX, Math.max(STAY_MIN, Math.round(stayRaw === null || stayRaw <= 0 ? DEFAULT_STAY[kind] : stayRaw)));
    out.push({
      candidate: cand,
      kind,
      reason: strOrNull(p.reason),
      stay_minutes: stay,
      cost_yen: numOrNull(p.cost_yen),
      cost_note: strOrNull(p.cost_note),
      priority: out.length,
    });
  }
  return out;
}

/** 金庫番の住所の形（Apps Script のウェブアプリ）。 */
export function isRelayUrl(u) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(String(u || '').trim());
}

/** 金庫番に 1 回頼む。ok:true の本文を返す。失敗は AiError（status・code）。 */
export async function callRelay({ relayUrl, payload, fetchImpl = fetch, signal } = {}) {
  let res;
  try {
    res = await fetchImpl(String(relayUrl).trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal,
    });
  } catch (e) {
    // 中断と圏外はそのまま（流れの側が「時間切れ」「圏外」と出す）。
    // それ以外は、住所違い・公開の設定違いでブラウザが通信を止めた形＝金庫番につながらん
    if ((e && e.name === 'AbortError') || (typeof navigator !== 'undefined' && navigator.onLine === false)) throw e;
    throw new AiError('relay unreachable', 502, 'relay_unreachable');
  }
  if (!res.ok) throw new AiError(`relay http ${res.status}`, res.status === 429 ? 429 : 502, 'relay_http');
  let data;
  try {
    data = await res.json();
  } catch {
    // 住所違い・公開の設定が「全員」になっとらん時は、JSON やなく Google のページが返る
    throw new AiError('relay not json', 502, 'relay_not_json');
  }
  if (!data || data.ok !== true) {
    const status = Number(data && data.status) || 502;
    console.error('relay failed', status, (data && data.code) || '');
    throw new AiError(`relay ${(data && data.code) || 'failed'}`, status, (data && data.code) || null);
  }
  return data;
}

/** つながるか（合言葉・金庫番のキー・使うモデル）を確かめる。料金はかからん・回数にも数えん。 */
export async function checkRelay({ relayUrl, passcode, fetchImpl = fetch, signal } = {}) {
  const d = await callRelay({ relayUrl, payload: { action: 'ping', pass: passcode }, fetchImpl, signal });
  return { model: d.model || null, models: Array.isArray(d.models) ? d.models : [] };
}

/** pickSchema（Gemini 形式）から、金庫番に渡す候補の番号と数を取り出す。 */
export function schemaArgs(schema) {
  const picks = schema && schema.properties && schema.properties.picks;
  const ids = (picks && picks.items && picks.items.properties && picks.items.properties.id && picks.items.properties.id.enum) || [];
  const max = Math.max(1, Math.min(10, Number(picks && picks.maxItems) || 1));
  return { ids: ids.map(String), max };
}

/**
 * 1 回の生成。返事の text。refs・searchHtml は Gemini 版との互換のため空で返す。
 * 指示の文（system）は金庫番が持っとるので送らん。schema が無い時（400 の立て直し）は答えの形なしで頼む。
 */
export async function generate({ relayUrl, passcode, model, user, schema = null, fetchImpl = fetch, signal } = {}) {
  const payload = { action: 'pick', pass: passcode, user, model, schema: Boolean(schema) };
  if (schema) Object.assign(payload, schemaArgs(schema));
  const d = await callRelay({ relayUrl, payload, fetchImpl, signal });
  return { text: typeof d.text === 'string' ? d.text : '', refs: [], searchHtml: null };
}
