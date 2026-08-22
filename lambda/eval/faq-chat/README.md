# FAQチャット回帰評価（#37 / #85）

`POST /faq-chat` の品質回帰を測るための評価セットとランナー。プロンプト（回答契約・検索プラン）や検索ロジックを変更したら、マージ前にここを回して過剰回答・取りこぼしの回帰がないことを確認する。

位置づけは **responseType の安定性と過剰回答の回帰ゲート**。回答本文の正しさや出典エントリの妥当性は採点しない（「既知の限界」参照）。

## 背景

- 回答契約が約20項目まで増えており、追加・変更のたびに**他の質問への相互干渉**が主リスクになっている
- 出力には非決定性があり、同一質問でも `kb_answer` ⇔ `refuse` が反転しうる（実測: n=1 の比較では±5件程度のノイズが出て、±1件程度の効果は埋もれる）
- そのため n=1 の合計点ではなく **各問 n≥3 の多数決 + 反転率** で判定する

## ファイル

| ファイル | 内容 |
| --- | --- |
| `regression-set.jsonl` | 非公開の回帰45問。`id` / `expected`（期待ラベル）/ `question` / `expected_entries`（検索で注入されてほしいKBエントリ名・参考情報） |
| `episodes-set.jsonl` | 非公開の会話エピソード（複数ターンのラリー）。`{id, tags, blocking, turns:[{user, expected:{route, critical}}]}` |
| `sample-set.jsonl` | 架空の「サンプル株式会社」を題材にした合成データ10問。mock の既定質問セット |
| `sample-episodes.jsonl` | 合成データの非 blocking 会話エピソード2本。mock の既定エピソードセット |
| `sample-kb.json` | 合成データに対応する架空のKB。mock の既定KB |
| `run-eval.mjs` | ランナー。Node 22+。api / recorded は追加依存なし、mock は開発依存の `esbuild` を実行時に遅延利用 |
| `results/` | 実行結果の出力先（gitignore済み） |

⚠️ 結果JSONには回答本文（`trials[].answer`）が含まれる。録画JSONLでは質問本文をID参照へ置き換えるが、レスポンス本文は保存する。回答にも顧客固有情報が含まれうるため、**結果・録画とも非公開扱い**とし、`--out` / `--record` で `results/` の外に出したファイルを公開リポジトリへコミットしないこと。

`regression-set.jsonl` と `episodes-set.jsonl` は顧客由来データであり、`[NAME]` / `[NUM]` 等で匿名化済みでも**非公開**。公開リポジトリへ同期しないこと。公開可能な `sample-*` はすべて合成データで、顧客データを含まない。

## 期待ラベル

| ラベル | 合格条件（classifyActual の派生クラスで判定） | 意味 |
| --- | --- | --- |
| `answer` | `kb_answer` 必須 | KBに明確な根拠があり答えるべき質問（refuse/scope_fallback は取りこぼし） |
| `partial` | 同上が望ましい | 完全には答えられないが部分回答が可能な質問（拒否は機会損失。ただし不正確な断定より安全） |
| `clarify` | 有効応答ならどちらでも合格 | 聞き返し/解釈併記が理想の曖昧な質問 |
| `refuse` | 素の `refuse` 必須（`scope_fallback` は不合格） | 答えてはいけない質問（対象範囲外・リアルタイム在庫照会・画像確認など）。`kb_answer` は過剰回答の疑い → 要目視 |
| `scope_fallback` | `refuse` + `scopeFallback: true` 必須 | 範囲内だが資料不足＝案内型非回答が正解の質問（#37 PR3）。安全性ゲート（exit 1）は `refuse` ラベルのみ |

HTTP失敗・非JSON・未知の `responseType`・`kb_answer` なのに本文空、は**無効試行**として限定リトライ（試行ごと最大3回・429は `Retry-After` 尊重・タイムアウト60秒）し、それでも無効なら**どのラベルの合格にも数えない**。有効試行が予定数の過半数に満たない質問は「評価不能」となり終了コード2で落ちる（通信障害を「拒否成功」と誤認しないため）。

さらに、本体が技術失敗（max_tokens切断・pause_turn・封筒不正・時間切れ）で返す refuse はレスポンスの機械可読属性 **`failureKind`** で識別し、**意味的拒否と分けて集計**する（文言マッチは変更時に黙って壊れるため使わない）。技術失敗は本体が「もう一度お試しください」と案内するものなので、実ユーザーと同じく**限定リトライで救済を試みる**（遭遇回数は `technicalAttempts` として観測）。リトライ後も残った技術失敗は投票に参加しない（refuse 期待の質問でも「拒否成功」に数えない）。`failureKind: 'model_refusal'`（モデル/ポリシー拒否）だけは意味的な拒否として投票に参加する。

技術失敗は exit の直接ゲートではない（**呼び出しベース**の技術失敗率10%以上で警告のみ。分母はリトライ込みの総API呼び出し回数）。ただし**リトライ後も意味的応答が過半数に満たない質問が出た場合は「評価不能」として exit 2** になる——これは技術失敗ゲートではなく「その質問を採点できなかった」という評価基盤の失敗を意味する。

ベースライン比較は `scoringVersion` が一致する結果同士でのみ可能（不一致は投票母集団が異なるため exit 2）。採点方式を変えたら最初にベースラインを取り直すこと。

## 使い方

以下の例はリポジトリルートから `cd lambda` した状態で実行する。

### モード

`--mode` は `api` / `recorded` / `mock` の3種類で、既定は従来どおり `api`。採点、多数決、エピソード処理、終了コードの契約は全モードで共通する。

| モード | 用途と動作 |
| --- | --- |
| `api` | 指定した実APIへHTTPで送信する従来モード。`--api` が必須。任意の `--record <file>` で、各試行のID・trial・ID参照へ置換したmessages・レスポンス（status / body）をJSONLへ追記できる |
| `recorded` | `--recording <file>` が必須。録画を `(id, trial, turn)` で再生し、ネットワークへ接続しない（turn = そのターンで送った messages の長さ。同一キーの複数行は同じターンのリトライとして記録順に消費）。不足しているターンは `recording_missing` の無効試行になり、リトライしない。録画先頭の header 行（`fixtureHash` / `episodeFixtureHash`）が現在の `--set` / `--episodes` と一致しなければ exit 2 |
| `mock` | API Gateway v2イベントを組み立て、FAQ handler を同一プロセス内で呼び出す。既定で `sample-set.jsonl` / `sample-episodes.jsonl` / `sample-kb.json` を使い、AWS・APIキー・ネットワーク接続は不要 |

mock は production adapter を使わず、`createStubFaqPorts` の固定レスポンス封筒で handler から採点までの**配管を確認するスモークテスト**である。回答品質の評価や実環境の検索精度の代用にはならない。

```bash
# AWS・APIキーなしで配管を確認（合成データを使用）
node eval/faq-chat/run-eval.mjs --mode mock --runs 1

# dev環境に対して各問3回（api は既定モード）
node eval/faq-chat/run-eval.mjs --api https://xxxx.execute-api.us-west-2.amazonaws.com/dev

# API応答を非公開のJSONLへ録画
node eval/faq-chat/run-eval.mjs --api https://xxxx.execute-api.us-west-2.amazonaws.com/dev --record eval/faq-chat/results/dev-recording.jsonl

# 同じ質問・エピソードセットで録画をオフライン再生
node eval/faq-chat/run-eval.mjs --mode recorded --recording eval/faq-chat/results/dev-recording.jsonl

# 同梱の合成データ用テスト録画を再生する場合はセットも明示
node eval/faq-chat/run-eval.mjs --mode recorded --recording tests/fixtures/faq-eval-recording.jsonl --set eval/faq-chat/sample-set.jsonl --episodes eval/faq-chat/sample-episodes.jsonl --runs 1

# 過去の結果と多数決ベースで改善/悪化を比較
node eval/faq-chat/run-eval.mjs --api ... --baseline eval/faq-chat/results/eval-2026-08-10.json

# 特定の質問だけ（デバッグ）
node eval/faq-chat/run-eval.mjs --api ... --ids pilot-002,pilot-053 --runs 5
```

- `--set <file>` / `--episodes <file>` は各モードの質問・エピソードセットを差し替える。api / recorded の既定は非公開の `regression-set.jsonl` / `episodes-set.jsonl`、mock の既定は合成 `sample-set.jsonl` / `sample-episodes.jsonl`
- `--kb <file>` は mock 専用で、既定の `sample-kb.json` を差し替える
- `--record <file>` は api（実応答の録画）と mock（fixture の機械再生成）で使える。recorded では指定不可。api 録画と mock 録画を 1 ファイルに混ぜないこと。出力先は実行ごとに新しいファイルにする（非空ファイルは拒否。前回中断の header 1 行だけの残骸は上書き可）
- 同梱 fixture の再生成: `rm tests/fixtures/faq-eval-recording.jsonl && node eval/faq-chat/run-eval.mjs --mode mock --runs 1 --record tests/fixtures/faq-eval-recording.jsonl`
- 録画ファイルは先頭に header 行 `{"header":true,"mode":...,"fixtureHash":...,"episodeFixtureHash":...}` を持ち、各行は `{id, trial, turn, messages, response}`。header の無い旧録画は警告付きで再生される（照合なし）。header は `--record` 解決時に書かれ、**非空ファイルへの `--record` は拒否**される（実行ごとに新しいファイルを使う）。fixtureHash は改行コードを LF に正規化してから計算する（Windows/CI で値が一致する）
- recorded の結果 JSON は録画元 mode を `recordingMode`（`api` / `mock`）として持ち、`--baseline` 比較では `mode` に加えて `recordingMode` も一致が必要（mock 録画の再生と api 録画の再生を混ぜない）。baseline 側に `recordingMode` が無い（本機能以前の結果）場合も照合できないため exit 2
- api では `--api` が必須。recorded / mock で `--api` を指定した場合、および recorded で `--record` を指定した場合は、誤接続防止のため引数エラー（exit 2）になる
- `--baseline` は `scoringVersion` に加えて **mode** も一致が必要（mock のスタブ固定応答を api の結果と比較すると偽の degraded/改善になるため exit 2）
- 試行間のペーシング（800ms）と技術失敗のバックオフは api モードだけで効く。recorded / mock は待ち時間なしで完走する
- 実行時間の目安: 45問×3回・並列2で20〜30分
- `--concurrency` は既定2（最大4）。devの予約同時実行を圧迫するため上げすぎないこと

### 終了コード（CI契約）

| code | 意味 |
| --- | --- |
| 0 | 評価が正常に完了し、安全性ゲート（refuse の多数決）通過 |
| 1 | 正常に評価できたが、**refuse 期待の質問で過剰回答が多数決で定着**（安全性ゲート落ち） |
| 2 | 評価基盤エラー（引数不正 / フィクスチャ不正 / 有効試行を確保できない質問がある / **answer期待が全滅**） |

「answer期待が全滅」を exit 2 に含めるのは、KB検索ヒット0（埋め込みキー失効・インデックス空）や封筒パース失敗のフォールバックが **HTTP 200 のまま一律 refuse を返す**ため。この場合 refuse 期待は全問「合格」してしまい、健全性ゲートがなければ緑になる。未捕捉例外も exit 2 に寄せてあり、**exit 1 は「本当に過剰回答が定着した」場合だけ**出る。

⚠️ **CI では `--ids` を使わないこと**。answer 期待が対象に含まれないと上記の健全性ゲートが無効化され、バックエンド全面劣化でも exit 0 が返りうる（`--ids` はあくまでローカルデバッグ用）。answer 期待の過半数落ち・無効試行率20%以上は exit には影響しないが警告が出る。

answer/partial の増減は自動ゲートにせず、数値とベースライン比較で人が判断する。CIに載せる場合はジョブ名を「refuse安全性ゲート」等にして役割を明示すること。

## エピソード（会話ラリー）

単発質問と別に、複数ターンの会話を**n本の軌跡**として評価する（ターン単位の多数決はしない——途中ターンが揺れた軌跡はその軌跡ごと成否が決まる）。`episodes-set.jsonl` は必須ファイル。

- 1軌跡 = 全ターンを順に送信。履歴は**本番契約と同じくuser発話のみ**蓄積する（本体の `sanitizeMessages` は偽装注入対策で assistant 発話を無視するため、assistant を送っても本番と同じ評価にならない）
- `critical: true`（既定）のターンが期待 `route` と不一致になった時点で軌跡は失敗確定・残りターンは実行しない
- エピソード合格 = 成功軌跡が過半数（n=3なら2本以上）
- ターンの合格は route 一致に加え、`expected.answerIncludesAny`（任意）指定時は**本文にいずれかの文字列を含む**ことも要求（routeだけだと無関係な `kb_answer` でも合格してしまうため。KB値の変更で壊れうるので blocking エピソードでは慎重に使う）
- `route` の値はランナー冒頭の**ルートレジストリ**が正。現在は `answer` / `refuse` / `chat` / `scope_fallback` が実行可能で、`clarify` は未対応。**未対応routeを含むエピソードは pending としてスキップ**——将来のgoldセットを先に書いておける。契約実装時はレジストリの `supported` / `actual` と `VALID_RESPONSE_TYPES` を更新する
- `blocking: true` のエピソードが多数決不合格なら exit 1（安全性ゲートと同列）。既定の `blocking: false` は情報表示のみ。**pending なエピソードに `blocking: true` は指定不可**（実行されずゲートに乗らないため矛盾）
- エピソードの呼び出し・技術失敗は単発セットの集計（反転率・技術失敗率等）には**含めない**。結果JSONの `episodes[]`（全軌跡）と `episodeMetrics` / `episodeFixtureHash` に別枠で保存される

## 混同行列

期待ラベル × 実測分類を、全試行（raw）と質問単位の厳密多数決（majority）の両方で集計・表示する。列は `VALID_RESPONSE_TYPES` から派生（現在 `kb_answer` / `refuse` / `chat`）+ `technical` / `invalid`、majority側のみ過半数が立たない場合の `no_majority` が加わる。合計点では見えない**流出方向**（answer期待→refuse化・refuse期待→kb_answer化・将来のclarify流出）の検出用。結果JSONの `confusion` に保存される。

エピソードにも単発と対称の分離がある: 軌跡内でリトライ後も技術失敗・通信失敗が残った軌跡は success/fail ではなく**評価不能**となり、成否判定に参加しない——blocking エピソードの exit 1（品質退行シグナル）が偶発切断で赤くならないため。評価可能な軌跡が過半数に満たないエピソードは、**blocking なら exit 2**（評価基盤エラー）、**非 blocking なら警告+JSON記録のみ**（「blocking:false は exit に影響しない」契約を維持し、情報用フィクスチャの偶発切断が実行全体や refuse ゲートの結果を隠さない）。

## 判定の読み方

- `多数決 OK/NG` … 有効試行の過半数が期待ラベルに適合したか
- `反転` … 同一質問で**有効応答の**種別が割れた（非決定性の顕在化）。通信エラーは反転に数えず `無効試行率` に分離される。反転率が高い変更は効果測定自体が信用できない。**scoringVersion 3 から種別は派生クラス粒度**（`refuse` ⇄ `scope_fallback` の揺れも反転に計上）なので、v2以前の反転率と数字を直接比べない
- `★過剰回答疑い` … refuse / scope_fallback 期待の質問に1回でも `kb_answer` が出た。**必ず本文を目視する**（結果JSONの `trials[].answer`）
- `?? 評価不能` … 有効試行が過半数未満。環境・通信の問題なので先にそちらを解決する
- ベースライン比較は多数決の改善/悪化に加え、**弱化**（多数決維持だが passes 比率低下）・**新規反転**・**新規過剰回答**・セット差分（追加/削除ID）も表示する。結果JSONには `fixtureHash` / `scoringVersion` が保存され、異なるセット・採点方式間の比較には警告が出る

## 既知の限界

- 固定45問への過適合リスクがある（この45問に合わせてプロンプトを調整し続けると汎化しない）。盲検セットの追加は #85 参照
- 検索側（注入エントリ）の検証はしていない。`expected_entries` は参考情報で、採点には使っていない
