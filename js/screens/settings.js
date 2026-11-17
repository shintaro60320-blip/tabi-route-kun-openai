// 設定（設計書 §3.6）
import { el, icon, downloadText } from '../ui.js';
import { checkRelay, isRelayUrl } from '../openai.js';
import { quotaDay } from '../store.js';
import { APP_VERSION } from '../app.js';

export function render(root, { nav, store }) {
  const s = store.getSettings();

  // 金庫番の住所と合言葉（キーはアプリに入れん＝金庫番の中だけ）
  const url = el('input', { id: 'relayurl', type: 'url', autocomplete: 'off', spellcheck: 'false', inputmode: 'url', placeholder: 'https://script.google.com/macros/s/…/exec', value: s.relayUrl });
  const pass = el('input', { id: 'passcode', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: '持ち主から聞いた合言葉', value: s.passcode });
  const toggle = el('button', { class: 'btn btn--small', type: 'button', ariaLabel: '合言葉を表示', on: { click() { pass.type = pass.type === 'password' ? 'text' : 'password'; } } }, [icon('eye')]);
  const status = el('div', { class: 'note' });
  if (s.model && s.relayUrl && s.passcode) { status.textContent = `つながります（モデル：${s.model}）`; status.className = 'status-ok'; }
  // 書き換えたら「つながります」は無効（確かめ直すまで）
  const dirty = () => { status.className = 'note'; status.textContent = '変えたら「つながるか確かめる」を押してください。'; };
  url.addEventListener('input', dirty);
  pass.addEventListener('input', dirty);
  const check = el('button', { class: 'btn', type: 'button' }, ['つながるか確かめる']);
  check.addEventListener('click', async () => {
    const relayUrl = url.value.trim();
    const passcode = pass.value.trim();
    const saved = store.saveSettings({ relayUrl, passcode, model: '', models: [], lastKeyCheckAt: null, useSearch: false });
    if (!saved) { status.className = 'status-ng'; status.textContent = 'この端末に保存できませんでした（容量不足かプライベートモード）。'; return; }
    if (!isRelayUrl(relayUrl)) { status.className = 'status-ng'; status.textContent = '金庫番の住所の形が違います。https://script.google.com/macros/s/ で始まり /exec で終わる住所を入れてください。'; return; }
    if (!passcode) { status.className = 'status-ng'; status.textContent = '合言葉が入っていません。'; return; }
    check.disabled = true; status.className = 'note'; status.textContent = '確かめています…';
    try {
      const r = await checkRelay({ relayUrl, passcode });
      if (!r.model) { status.className = 'status-ng'; status.textContent = '使えるモデルが見つかりませんでした。'; return; }
      store.saveSettings({ model: r.model, models: r.models, lastKeyCheckAt: new Date().toISOString() });
      status.className = 'status-ok'; status.textContent = `つながります（モデル：${r.model}）`;
    } catch (e) {
      status.className = 'status-ng';
      status.textContent = relayMessage(e);
      console.error('relay check failed', e && e.status, e && e.code);
    } finally {
      check.disabled = false;
    }
  });

  // 今日の残り
  const used = store.getUsage(new Date());
  const usage = el('div', { class: 'note', text: `今日 ${used} 回使いました。` });

  // 文字の大きさ
  const seg = el('div', { class: 'seg', role: 'group', ariaLabel: '文字の大きさ' });
  const mk = (label, scale) => el('button', { type: 'button', ariaPressed: s.fontScale === scale, on: { click() { store.saveSettings({ fontScale: scale }); window.dispatchEvent(new Event('trko:settings')); render(root, { nav, store }); } } }, [label]);
  seg.append(mk('ふつう', 1), mk('大きい', 1.15));

  const exportBtn = el('button', { class: 'btn', type: 'button', on: { click() { downloadText(`tabi-route-${quotaDay(new Date())}.json`, store.exportTripsJson()); } } }, ['保存した旅を書き出す']);
  const clearBtn = el('button', { class: 'btn', type: 'button', on: { click() { if (confirm('保存した旅をすべて消します。よろしいですか？')) { store.clearTrips(); render(root, { nav, store }); } } } }, ['保存した旅を消す']);

  // この版のしくみ（キーはアプリに入れん）
  const about = el('div', { class: 'setting', style: 'border-top:0;padding-top:0;gap:12px' }, [
    el('div', { class: 'setting__label', text: 'この版のしくみ' }),
    el('div', { class: 'note', text: 'この版は、持ち主の OpenAI を使ってルートを作ります。キーはこのアプリに入れず、持ち主の「金庫番」（Google Apps Script）の中にだけ置いてあります。' }),
    el('div', { class: 'note', text: '金庫番の住所と合言葉は、持ち主から聞いてください。合言葉は人に教えないでください。' }),
  ]);

  const howto = el('details', {}, [
    el('summary', { style: 'font-weight:700;min-height:44px;display:flex;align-items:center;cursor:pointer', text: '使い方' }),
    el('ol', { class: 'note', style: 'padding-left:20px' }, [
      el('li', { text: '金庫番の住所と合言葉を入れて「つながるか確かめる」を押します。' }),
      el('li', { text: 'Chrome の右上「⋮」→「ホーム画面に追加」で、アプリとして置けます。' }),
      el('li', { text: '行き先を1つ入れて「おすすめを出す」。料金と時間は目安です。' }),
      el('li', { text: '「上限に当たりました」と出たら、明日また使うか、持ち主に知らせてください。' }),
    ]),
  ]);

  root.replaceChildren();
  root.append(el('section', { class: 'screen', dataset: { screen: 'settings' } }, [
    el('button', { class: 'back', type: 'button', on: { click: () => nav('/home') } }, [icon('back'), 'もどる']),
    el('h1', { class: 'h1 h1--s', text: '設定' }),
    el('div', { class: 'setting' }, [
      el('label', { class: 'setting__label', for: 'relayurl', text: '金庫番の住所' }),
      el('div', { class: 'field field--pw' }, [url]),
      el('label', { class: 'setting__label', for: 'passcode', text: '合言葉' }),
      el('div', { class: 'setting__row' }, [el('div', { class: 'field field--pw' }, [pass]), toggle]),
      check, status,
      el('div', { class: 'note', text: '住所と合言葉は、このスマホの中にだけ保存されます。' }),
    ]),
    about,
    el('div', { class: 'setting' }, [el('div', { class: 'setting__label', text: '今日の残り' }), usage]),
    el('div', { class: 'setting' }, [el('div', { class: 'setting__label', text: '文字の大きさ' }), seg]),
    el('div', { class: 'setting' }, [el('div', { class: 'setting__label', text: '保存した旅' }), exportBtn, clearBtn]),
    el('div', { class: 'setting' }, [howto]),
    el('div', { class: 'note', text: `版：${APP_VERSION}` }),
  ]));
}

function extIcon() {
  const i = icon('external', 20); i.classList.add('ext'); return i;
}

/** 金庫番の失敗を、利用者に分かる言葉にする。 */
function relayMessage(e) {
  const code = e && e.code;
  const status = e && e.status;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'インターネットにつながっていません。';
  if (code === 'bad_pass') return '合言葉が違うようです。持ち主に確かめてください。';
  if (code === 'relay_not_json' || code === 'relay_http' || code === 'relay_unreachable') return '金庫番につながりませんでした。住所が合っているか、金庫番の公開の設定（アクセスできるユーザー：全員）を確かめてください。';
  if (code === 'no_key_on_relay') return '金庫番に OpenAI のキーが入っていません（持ち主の作業です）。';
  if (code === 'invalid_api_key' || status === 401 || status === 403) return '金庫番の OpenAI のキーが使えないようです（持ち主の作業です）。';
  if (code === 'insufficient_quota') return 'OpenAI の残高（利用枠）が足りないようです（持ち主の作業です）。';
  if (code === 'daily_limit') return '今日使える回数の上限に当たりました。明日また使えます。';
  if (code === 'no_model') return '使えるモデルが見つかりませんでした（持ち主の作業です）。';
  return '確かめられませんでした。しばらくしてからもう一度お試しください。';
}

