// OpenAI API の呼び出しと返事の取り出し（旅ルートくん OpenAI 版・2026-11-17）。
// Gemini 版（AppKeeper\projects\旅ルートくん）から、呼び出し先だけを OpenAI の Responses API に替えた。
// キーは Authorization ヘッダで送る（URL に付けない）。ログに出さない。
// 公式（2026-11-17 確認）：POST /v1/responses・答えの形は text.format（json_schema・strict）・考える量は reasoning.effort。
// ブラウザから直接呼べる（api.openai.com は Access-Control-Allow-Origin: * を返す＝実測）。

const BASE = 'https://api.openai.com/v1';

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

/**
 * Gemini 形式のスキーマ（type 'OBJECT' 等・nullable・propertyOrdering・maxItems が文字）を、
 * OpenAI の strict な JSON Schema に直す：型は小文字・全部の項目を required・additionalProperties:false、
 * 元で必須でない項目と nullable は「null も可」にする。maxItems は落とす（数は normalizePicks の後で切る）。
 */
export function toStrictSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const t = String(s.type || '').toLowerCase();
  if (t === 'object') {
    const props = s.properties || {};
    const req = new Set(s.required || []);
    const out = { type: 'object', properties: {}, required: Object.keys(props), additionalProperties: false };
    for (const [k, v] of Object.entries(props)) {
      const conv = toStrictSchema(v);
      out.properties[k] = (!req.has(k) || (v && v.nullable)) ? nullable(conv) : conv;
    }
    return out;
  }
  if (t === 'array') return { type: 'array', items: toStrictSchema(s.items || {}) };
  const out = { type: t };
  if (Array.isArray(s.enum)) out.enum = s.enum.slice();
  if (s.nullable) return nullable(out);
  return out;
}

function nullable(conv) {
  if (!conv || typeof conv !== 'object' || !conv.type) return conv;
  if (Array.isArray(conv.type)) return conv.type.includes('null') ? conv : { ...conv, type: [...conv.type, 'null'] };
  const out = { ...conv, type: [conv.type, 'null'] };
  if (Array.isArray(conv.enum) && !conv.enum.includes(null)) out.enum = [...conv.enum, null];
  return out;
}

/** モデルごとの考える量。速さ優先で一番少なく（gpt-6 系は none・gpt-5 系は minimal・それより前は指定なし）。 */
export function reasoningFor(model) {
  const m = String(model || '');
  if (/^gpt-6/.test(m)) return { effort: 'none' };
  if (/^gpt-5/.test(m)) return { effort: 'minimal' };
  return null;
}

/** Responses API の本文。schema があれば strict な JSON 出力。 */
export function buildRequestBody({ system, user, model, schema = null }) {
  const body = {
    model,
    input: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_output_tokens: 8000,
    store: false, // 会話を OpenAI 側に残さん
  };
  const r = reasoningFor(model);
  if (r) body.reasoning = r;
  if (schema) body.text = { format: { type: 'json_schema', name: 'picks', schema: toStrictSchema(schema), strict: true } };
  return body;
}

function headers(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

async function errorFrom(res, what) {
  let head = '';
  let code = null;
  try {
    head = (await res.text()).slice(0, 300);
    const j = JSON.parse(head);
    code = (j && j.error && (j.error.code || j.error.type)) || null;
  } catch { /* 本文なし・JSON やない */ }
  // 原因の切り分け用（キーは含まれん）。画面には出さん。
  console.error(`${what} failed`, res.status, code || '', head);
  const err = new AiError(`${what} failed: ${res.status}`, res.status, code);
  err.detail = head;
  return err;
}

export async function listModels({ apiKey, fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(`${BASE}/models`, { headers: headers(apiKey), signal });
  if (!res.ok) throw await errorFrom(res, 'models.list');
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}

/** 返事（Responses API）から本文を取り出す。output[].content[] の output_text をつなぐ。 */
export function responseText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  const out = Array.isArray(data.output) ? data.output : [];
  let text = '';
  for (const item of out) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content) if (c && c.type === 'output_text' && typeof c.text === 'string') text += c.text;
  }
  return text;
}

/**
 * 1 回の生成。返事の text。refs・searchHtml は Gemini 版との互換のため空で返す（OpenAI 版は検索根拠づけを使わん）。
 * useSearch は受け取っても使わん（呼び出し側を Gemini 版と揃えるため引数だけ残す）。
 */
export async function generate({ apiKey, model, system, user, schema = null, fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(`${BASE}/responses`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(buildRequestBody({ system, user, model, schema })),
    signal,
  });
  if (!res.ok) throw await errorFrom(res, 'responses');
  const data = await res.json();
  return { text: responseText(data), refs: [], searchHtml: null };
}
