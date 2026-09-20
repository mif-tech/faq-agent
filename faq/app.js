/**
 * 公開FAQチャット UI
 *
 * - API契約: POST {apiBaseUrl}/faq-chat  { messages: [{role:'user', content}...] }
 *   → { answer, answerable, sources: [{entryId, topic, url?}] } / 503 { error }
 *   サーバーは user role の質問だけを採用する（assistant は送らない）
 * - 履歴は localStorage のみ（7日で自動破棄・「履歴を消去」ボタンあり）
 * - 表示は必ず textContent（innerHTML 不使用 = 応答由来のXSSを構造的に防ぐ）
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'faq_chat_history_v1';
  var HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  var MAX_STORED_MESSAGES = 30;
  var MAX_CONTEXT_QUESTIONS = 6; // サーバーの maxHistoryMessages と同じ既定

  var apiBaseUrl = (window.FAQ_CONFIG && window.FAQ_CONFIG.apiBaseUrl) || '';
  var configuredRequestTimeoutMs = window.FAQ_CONFIG && window.FAQ_CONFIG.requestTimeoutMs;
  // setTimeout の符号付き32bit上限を超える値は即時実行になるため、既定値へ戻す。
  var requestTimeoutMs =
    Number.isInteger(configuredRequestTimeoutMs) &&
    configuredRequestTimeoutMs > 0 &&
    configuredRequestTimeoutMs <= 2147483647
      ? configuredRequestTimeoutMs
      : 40000;

  // テナント固有のブランド名は config.js に閉じ込め、ここで反映する
  // （framework正本の index.html は汎用名のまま。未設定時も汎用名で動作）
  var brandTitle = (window.FAQ_CONFIG && window.FAQ_CONFIG.title) || '';
  if (brandTitle) {
    document.title = brandTitle;
    var titleEl = document.getElementById('chat-title');
    if (titleEl) titleEl.textContent = brandTitle;
  }

  // 初回表示のウェルカム文と候補質問チップも config.js 駆動（テナント・言語差分を1ファイルに集約）
  var welcomeMessage =
    (window.FAQ_CONFIG &&
      typeof window.FAQ_CONFIG.welcomeMessage === 'string' &&
      window.FAQ_CONFIG.welcomeMessage.trim()) ||
    'こんにちは！ご質問にAIがお答えします。';
  var suggestions = (window.FAQ_CONFIG && Array.isArray(window.FAQ_CONFIG.suggestions)
    ? window.FAQ_CONFIG.suggestions
    : []
  )
    .filter(function (s) {
      return typeof s === 'string' && s.trim().length > 0;
    })
    .slice(0, 6);
  var messagesEl = document.getElementById('messages');
  var formEl = document.getElementById('chat-form');
  var inputEl = document.getElementById('input');
  var sendBtn = document.getElementById('send-btn');
  var clearBtn = document.getElementById('clear-btn');

  /** @type {{role:string, content:string, sources?:{topic:string,url?:string}[]}[]} */
  var history = loadHistory();

  function loadHistory() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.messages)) return [];
      if (typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > HISTORY_TTL_MS) {
        localStorage.removeItem(STORAGE_KEY);
        return [];
      }
      return parsed.messages.filter(function (m) {
        return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string';
      });
    } catch (e) {
      return [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ savedAt: Date.now(), messages: history.slice(-MAX_STORED_MESSAGES) })
      );
    } catch (e) {
      /* 容量超過等は無視（履歴が残らないだけ） */
    }
  }

  function makeAvatar() {
    var av = document.createElement('span');
    av.className = 'avatar';
    av.setAttribute('aria-hidden', 'true');
    return av;
  }

  // assistant 側の行（アバター + 本文列）。ウェルカム・履歴・「回答中です…」で共通。
  // 出典等の追記先を暗黙の DOM 順序に依存させないよう body も明示的に返す
  function assistantRow(bubbleEl) {
    var row = document.createElement('div');
    row.className = 'msg msg-assistant';
    row.appendChild(makeAvatar());
    var body = document.createElement('div');
    body.className = 'msg-body';
    body.appendChild(bubbleEl);
    row.appendChild(body);
    return { row: row, body: body };
  }

  function submitForm() {
    if (typeof formEl.requestSubmit === 'function') {
      formEl.requestSubmit();
      return;
    }
    var evt;
    try {
      evt = new Event('submit', { cancelable: true });
    } catch (e) {
      // Event コンストラクタ非対応の旧WebView向け
      evt = document.createEvent('Event');
      evt.initEvent('submit', true, true);
    }
    formEl.dispatchEvent(evt);
  }

  function render() {
    messagesEl.textContent = '';
    if (history.length === 0) {
      // 初回はウェルカム吹き出し（固定文・API消費なし）+ 候補質問チップ
      var welcome = document.createElement('div');
      welcome.className = 'bubble';
      welcome.textContent = welcomeMessage;
      messagesEl.appendChild(assistantRow(welcome).row);
      if (suggestions.length > 0) {
        var chips = document.createElement('div');
        chips.className = 'chips';
        suggestions.forEach(function (text) {
          var chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'chip';
          chip.textContent = text;
          chip.addEventListener('click', function () {
            if (sendBtn.disabled) return;
            inputEl.value = text;
            submitForm();
          });
          chips.appendChild(chip);
        });
        messagesEl.appendChild(chips);
      }
      return;
    }
    history.forEach(function (m) {
      var bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = m.content; // XSS対策: 常に textContent
      var row;
      if (m.role === 'user') {
        row = document.createElement('div');
        row.className = 'msg msg-user';
        row.appendChild(bubble);
      } else {
        var ar = assistantRow(bubble);
        row = ar.row;
        if (m.sources && m.sources.length > 0) {
          var srcWrap = document.createElement('div');
          srcWrap.className = 'sources';
          var label = document.createElement('span');
          label.textContent = '参考: ';
          srcWrap.appendChild(label);
          m.sources.forEach(function (s, i) {
            if (i > 0) srcWrap.appendChild(document.createTextNode(' / '));
            if (s.url && /^https:\/\//.test(s.url)) {
              var a = document.createElement('a');
              a.href = s.url;
              a.target = '_blank';
              a.rel = 'noopener noreferrer';
              a.textContent = s.topic || s.url;
              srcWrap.appendChild(a);
            } else {
              srcWrap.appendChild(document.createTextNode(s.topic || ''));
            }
          });
          ar.body.appendChild(srcWrap); // msg-body 内に出典を並べる
        }
      }
      messagesEl.appendChild(row);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setBusy(busy) {
    sendBtn.disabled = busy;
    inputEl.disabled = busy;
    // 送信中の履歴消去は「仮吹き出しが消えた後にAI回答だけが描画される」不整合を生むため封じる
    clearBtn.disabled = busy;
    sendBtn.textContent = busy ? '送信中…' : '送信';
  }

  // 「回答中です…」のAI側仮吹き出し。render() は messagesEl を作り直すため、
  // 成功時は render() で自然に消えるが、エラー経路では removeTyping() で明示的に外す
  var typingRow = null;
  function showTyping() {
    removeTyping();
    var bubble = document.createElement('div');
    bubble.className = 'bubble typing';
    var label = document.createElement('span');
    label.textContent = '回答中です';
    bubble.appendChild(label);
    var dots = document.createElement('span');
    dots.className = 'typing-dots';
    dots.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 3; i++) {
      var dot = document.createElement('span');
      dot.textContent = '.';
      dots.appendChild(dot);
    }
    bubble.appendChild(dots);
    typingRow = assistantRow(bubble).row;
    messagesEl.appendChild(typingRow);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function removeTyping() {
    if (typingRow && typingRow.parentNode) typingRow.parentNode.removeChild(typingRow);
    typingRow = null;
  }

  function showTransient(text) {
    var note = document.createElement('p');
    note.className = 'transient';
    note.textContent = text;
    messagesEl.appendChild(note);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function buildRequestMessages() {
    // サーバーは user の質問だけを文脈として使う（assistant は採用されないため送らない）
    return history
      .filter(function (m) {
        return m.role === 'user';
      })
      .slice(-MAX_CONTEXT_QUESTIONS)
      .map(function (m) {
        return { role: 'user', content: m.content };
      });
  }

  // 入力欄は1行始まりで、入力内容（改行含む）に応じて自動で伸ばす。
  // Enter=改行のため複数行入力が通常操作。上限を超えたら内部スクロールに切り替わる
  // 上限は app.js のこの定数が唯一の定義（CSS側には持たない）
  var INPUT_MAX_HEIGHT = 120;
  function autosizeInput() {
    inputEl.style.height = 'auto';
    // box-sizing: border-box では height に border が含まれる一方 scrollHeight は含まないため、
    // 上下 border ぶんを加算しないと最終行の下端がクリップされる
    var borderY = inputEl.offsetHeight - inputEl.clientHeight;
    var needed = inputEl.scrollHeight + borderY;
    inputEl.style.height = Math.min(needed, INPUT_MAX_HEIGHT) + 'px';
    // 収まっている間はスクロールバーを出さない（CSS既定は auto = JS無効時も入力が見える）
    inputEl.style.overflowY = needed > INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
  }
  inputEl.addEventListener('input', autosizeInput);
  // 画面回転・幅変更・bfcache復元では input が発火しないため再計測する
  window.addEventListener('resize', autosizeInput);
  window.addEventListener('pageshow', autosizeInput);

  formEl.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var question = inputEl.value.trim();
    if (!question || sendBtn.disabled) return;
    if (!apiBaseUrl) {
      showTransient('設定エラー: 接続先が未設定です。');
      return;
    }
    history.push({ role: 'user', content: question });
    saveHistory();
    render();
    inputEl.value = '';
    autosizeInput();
    setBusy(true);
    showTyping();

    // 無応答時に「回答中です…」が永久に残らないよう設定した時間で打ち切る（既定40秒）。
    // 既定は API GW HTTP API の統合タイムアウト上限30秒より少し長く = サーバー側の504が先に返る
    // 通常経路を妨げず、「接続が張られたまま無反応」の限定ケースだけを拾う安全網。
    // 打ち切りは AbortError として既存の .catch（通信エラー文言）へ合流する
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timeoutId = controller
      ? setTimeout(function () {
          controller.abort();
        }, requestTimeoutMs)
      : null;

    fetch(apiBaseUrl.replace(/\/$/, '') + '/faq-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: buildRequestMessages() }),
      signal: controller ? controller.signal : undefined,
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { status: res.status, data: data };
        });
      })
      .then(function (result) {
        if (result.status === 200 && result.data && typeof result.data.answer === 'string') {
          history.push({
            role: 'assistant',
            content: result.data.answer,
            sources: Array.isArray(result.data.sources) ? result.data.sources : [],
          });
          saveHistory();
          render();
        } else if (result.status === 429) {
          showTransient('アクセスが集中しています。少し待ってからもう一度お試しください。');
        } else if (result.status === 503) {
          showTransient('ただいまチャットをご利用いただけません。時間をおいてお試しください。');
        } else {
          showTransient('送信に失敗しました。時間をおいてお試しください。');
        }
      })
      .catch(function () {
        showTransient('通信エラーが発生しました。時間をおいてお試しください。');
      })
      .then(function () {
        // finally 相当の終端に集約: 経路が増えても仮吹き出しが必ず外れる（PRレビュー指摘）。
        // 成功時は render() が先に走るため表示上の変化はない
        removeTyping();
        if (timeoutId) clearTimeout(timeoutId);
        setBusy(false);
        inputEl.focus();
      });
  });

  clearBtn.addEventListener('click', function () {
    history = [];
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      /* noop */
    }
    render();
  });

  // Enterは常に改行、送信は送信ボタンか Ctrl/Cmd+Enter（スマホ実機で誤送信が多発したため。
  // pointer/hover 系メディアクエリでは物理キーボードの有無を判定できないので出し分けはしない）。
  // formEl.submit() は submit イベントを発火せず CSP form-action 'none' で
  // ネイティブ送信もブロックされるため使わない（PRレビュー反映）
  inputEl.addEventListener('keydown', function (ev) {
    // 日本語IMEの変換確定キーでは何もしない（isComposing 未実装環境向けに keyCode 229 も見る）
    if (ev.isComposing || ev.keyCode === 229) return;
    var isEnter = ev.key === 'Enter' || ev.keyCode === 13;
    if (!isEnter || !(ev.ctrlKey || ev.metaKey)) return;
    ev.preventDefault();
    // 長押しリピートの連打抑止（submit 側の busy ガードと二重防壁）
    if (ev.repeat) return;
    submitForm();
  });

  render();
  autosizeInput();
})();
