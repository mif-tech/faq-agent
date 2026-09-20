// Local default. For a deployed UI, set this to the deployed API stage URL and
// update faq/index.html's connect-src CSP to the same origin.
window.FAQ_CONFIG = {
  requestTimeoutMs: 40000,
  apiBaseUrl: 'http://localhost:3000',
  title: 'サンプルFAQチャット',
  welcomeMessage: 'こんにちは。サンプルFAQの内容に基づいて回答します。',
  suggestions: [
    '営業時間を教えてください',
    '返品ポリシーを教えてください',
    '支払い方法を教えてください',
  ],
};
