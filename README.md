# MIF FAQ Chat Free

[![CI](https://github.com/mif-tech/faq-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/mif-tech/faq-agent/actions/workflows/ci.yml)

## このリポジトリの位置づけ

MIF FAQ Chat Free は、AI 応答支援、CRM、配信・分析、ナレッジ運用を含む非公開の ChatOps 運用基盤から、公開 FAQ チャットの実行境界を切り出した、ソース公開型の無償セルフホスト版です。静的 UI、`POST /faq-chat`、DynamoDB Local 用の架空サンプルデータ、モック評価を含みます。

```text
MIF FAQ Chat Free（self-host）
+-- free profile
|   +-- API キーなし          -> keyword / bigram 検索 + 決定的な回答
|   `-- ANTHROPIC_API_KEY     -> 簡易 AI 生成（任意）
`-- remote profile
    `-- MIF Remote RAG API    -> 検索・生成を委譲（別契約）
```

CRM、回答承認、配信、分析、管理画面、高度な検索・評価資産は含みません。free profile は小規模な FAQ の試用と検証を目的とする alpha であり、回答品質、検索精度、監視、可用性は保証しません。

MIF管理の検索・生成APIを接続した商用構成は、実顧客向け公開FAQとして本番運用されています。本repo単体の free profile は alpha であり、商用構成と同等の検索品質・監視・可用性・SLAは含みません。

本リポジトリは一般的なオープンソースではありません。利用、改変、再配布等の条件は [LICENSE.md](LICENSE.md) を確認してください。

このリポジトリは正本から一方向に再生成されます。更新は正本で行った後、公開同期で反映します。そのため、このリポジトリへの Pull Request を直接取り込めない場合があります。個別サポート、SLA、ロードマップ、利用者データのアップロードサービスは付属しません。

## 設計上の要点

- **交換可能な実行境界:** HTTP handler と検索・生成・保存の実装を [`ports/`](lambda/functions/faq-chat/ports/) で分離しています。`free` / `remote` を切り替えても、入力ガード、Q&Aログ、PIIマスク、応答封筒は lite 側に残ります。
- **fail-closed な remote 境界:** remote の必須設定不足や組み合わせ不整合は CloudFormation Rules と初期化時検証で拒否します。remote 障害時に `free` へ自動フォールバックせず、[`remote-v1` / `remote-one-shot-v1`](lambda/functions/faq-chat/adapters/remote/README.md) の入出力 DTO も未知フィールドを含めて検証します。
- **限定された cross-account 認証:** remote 認証は指定した role への `sts:AssumeRole` に限定し、caller role に直接の `execute-api:Invoke` を付与しません。取得した一時 credential で Remote RAG API へのリクエストを SigV4 署名します。
- **再現可能な検証:** [CI](.github/workflows/ci.yml) で TypeScript 型検査、契約・異常系・権限境界のテスト、SAM template lint を実行します。モック評価は合成データだけを使い、ネットワークへ接続しません。

## ローカルで確認する

必要なものは Node.js 22 以上、Python 3（AWS SAM CLI の前提）、Docker Engine 24 以上または Docker Desktop 4 以上、Docker Compose v2、AWS SAM CLI、Bash、Git、curl です。AWS CLI と AWS アカウントはローカル実行には不要です。Windows では WSL2 から実行してください。

```bash
# GitHub の Code メニューからこの公開リポジトリを clone した後
npm ci && npm --prefix lambda ci
npm run faq:preflight
npm run faq:local:up
# 別のターミナルで応答を確認
curl -s -X POST http://localhost:3000/faq-chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"営業時間を教えてください"}]}'
```

期待結果は HTTP 200 の JSON と、同梱サンプル KB に基づく回答です。API キーを設定しなければ外部 AI API は呼びません。静的 UI、任意の AI 生成、終了・秘密情報の消去、トラブルシューティングは [ローカル・クイックスタート](docs/QUICKSTART_FAQ_LOCAL.md) を参照してください。

## 構成

```text
faq/ static UI
      |
      v
POST /faq-chat -> handler -> FaqStoragePort -> Settings / FaqQaLogs
                         |
                         +-> FaqKbSourcePort -> public KnowledgeEntries
                         |                         |
                         |                         v
                         +-----------------> bigram retrieval
                                                   |
                              +--------------------+-------------------+
                              v                                        v
                    grounded demo generator                 optional AI generator
                              |                                        |
                              +--------------------+-------------------+
                                                   v
                                      validated response envelope
```

`ports/` が handler と実装詳細の境界です。公開版の `adapters/production.ts` は export 名を正本と揃えた互換層です。`free` profile では free adapter と4テーブル専用の軽量 DynamoDB client を組み合わせ、`remote` profile では同じ殻の storage とガードを維持したまま RAG 処理を MIF Remote RAG API へ委譲します。

## HTTP マルチエージェント

従来の `POST /faq-chat` は AgentConfig を参照せず、これまでどおり default FAQ として動作します。HTTPマルチエージェントは `FaqPortsProfile=free` 専用です。named agent を公開する場合は、`scripts/agent-config-cli.ts` で `AgentConfig` テーブルへプロファイルを投入し、`POST /agents/{agentId}/faq-chat` を呼び出します。remote-v1契約にはagentスコープがないため、`FaqPortsProfile=remote` のnamed routeは常に404へ閉じます。

⚠️ named agent の実効モデル（プロファイルの `model`、未指定なら `FAQ_FREE_MODEL` / 既定モデル）は許可リスト内である必要があります。**`FAQ_FREE_MODEL` に許可外モデルを設定すると default FAQ は動き続けるのに named agent だけが全件404になる**ので注意してください。named の404はレスポンスでは理由を区別しませんが、サーバログに `{"metric":"faq_named_agent_rejected","reason":...}` が必ず出ます（`invalid_agent_id` / `config_read_error` / `profile_invalid_or_disabled` / `effective_limits_invalid`）。運用ではこのログ文字列へのメトリクスフィルタ設定を推奨します。

```bash
# デプロイしたstackの出力値を指定する
export FAQ_TABLE_NAME_PREFIX=dev-lite
export FAQ_AGENT_CONFIG_TABLE_NAME=dev-lite-AgentConfig
export FAQ_API_URL=https://example.execute-api.us-west-2.amazonaws.com/dev

# JSONプロファイルを検証してから投入する
npx tsx scripts/agent-config-cli.ts validate ./agent-profile.json
npx tsx scripts/agent-config-cli.ts upsert ./agent-profile.json

# 登録済みプロファイルの確認と無効化
npx tsx scripts/agent-config-cli.ts list
npx tsx scripts/agent-config-cli.ts disable support

curl -s -X POST "$FAQ_API_URL/agents/support/faq-chat" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"営業時間を教えてください"}]}'
```

`agent-profile.json` は、たとえば `{"agentId":"support","enabled":true,"kbAgentId":"support"}` のように `agentId` とboolean型の `enabled` を含めます。AWS region / profile は AWS CLI と同じ標準設定を使います。このCLIはデプロイ済みstackのAgentConfig表を主対象とし、`FAQ_AGENT_CONFIG_TABLE_NAME` にはCloudFormation出力 `FaqAgentConfigTableName` の値を指定します。誤った表への書き込みを防ぐため、`FAQ_TABLE_NAME_PREFIX` も同時に指定し、CLIは `${FAQ_TABLE_NAME_PREFIX}-AgentConfig` との完全一致を要求します。既定のローカル初期化はdefault FAQ用の3表だけを作るため、DynamoDB Localでnamed agentを試す場合はAgentConfig表を別途作成してから、`DYNAMODB_ENDPOINT` に `http://localhost:8000` のような完全な `http(s)` URLを指定してください。非空の不正URLはAWS側へフォールバックせずエラーになります。

`agentId` が許可パターンに一致しない、プロファイルが未登録、`enabled` が `true` ではない、またはプロファイルの値が不正な場合は、すべて `404 {"error":"agent not found"}` になります。default FAQ へはフォールバックしません。

`upsert` は行全体の置換です。AgentConfig の行は HTTP named route と Slack agent で共用のため、既存行にあるフィールドを含まないプロファイルでの `upsert` はエラーになります（Slack 用の `systemPrompt` や `logPolicy` を誤って消さないための保護）。意図的に削除する場合だけ `upsert <profile.json> --replace` を使ってください。

named agent の KB は、プロファイルの `kbAgentId`（省略時は route の `agentId`）と `KnowledgeEntries.agentId` が完全一致する公開・有効な行だけを読み込みます。`agentId` 未設定または `default` の既存行は `POST /faq-chat` 専用で、named agent には混入しません。

## テストとモック評価

```bash
npm test
npm run eval:mock
```

モック評価は合成された架空の質問、会話エピソード、KBだけを使い、ネットワークへ接続しません。主目的は HTTP handler、応答封筒、採点ランナーの配管確認です。実際の回答品質や検索精度を保証するものではありません。

## 既知の制約

- 検索は小規模 KB 向けの文字 bigram とキーワードだけです。埋め込み検索や高度なランキングは含みません。
- handler 内の smalltalk 分岐は正本との互換性のため残っています。free profile の既定は `template_only` で、`smalltalkMode=generated` は `ANTHROPIC_API_KEY` を持つ環境でのみ opt-in できます。
- 同梱データは架空のサンプルです。非公開の評価質問、会話、結果、顧客データは含みません。
- Q&A は接触先らしき文字列をマスクして `FaqQaLogs` に保存し、SAM parameter `FaqQaLogRetentionDays`（既定180日）に従う `ttl` を設定します。DynamoDB TTL の削除時刻は厳密ではありません。
- Q&A の恒久アーカイブは含みません。任意の Slack 通知は既定では保存成功後に FAQ Lambda から直接送り、`FaqQaNotifyAsyncEnabled=true` で専用 Streams worker へ切り替えられます。
- ファイルアップロード、認証、管理画面、監視、WAF、独自ドメイン、バックアップは含みません。
- Docker Desktop の業務利用条件は組織規模等で異なります。所属組織で確認し、必要なら Docker Engine を利用してください。

## AWSへ配置する場合

ローカル確認と本番運用は別です。最小スタックは `lambda/template.yaml` にありますが、公開前に少なくとも次を行ってください。

1. `FaqChatCorsOrigin` を UI の正確な HTTPS origin に限定する（`*` のまま公開しない）。
2. 専用 API キー、低い利用上限、請求アラートを設定する。
3. レート制限、同時実行数、ログ、障害通知、バックアップ、削除方針を設計する。
4. `Settings` の `faq_chat.enabled` と、自組織が公開を承認した `KnowledgeEntries` だけを投入する。
5. UI の `faq/config.js` と `faq/index.html` の CSP `connect-src` を同じ API origin へ変更する。

```bash
cd lambda
sam build
sam deploy \
  --stack-name STACK_NAME \
  --region REGION \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides FaqChatCorsOrigin=https://YOUR_UI_ORIGIN
```

`FaqQaLogRetentionDays` は0以上3650以下の整数日（最大10年）です。既定値は180です。SAM parameter は符号・空白・小数点・指数表記・16進表記・複数桁の先頭0を含まない正規形の ASCII 十進文字列だけを受理し、それ以外はデプロイ前に拒否します。`0` にすると新しい Q&A レコードから `ttl` を省略し、手動で削除するまで保持します。テーブルの DynamoDB TTL 設定自体は有効なままなので、変更前に `ttl` が付いた既存レコードはそれぞれの期限後に削除対象になります。実行時環境変数の防御的な読み取りは前後の空白を除く ASCII 十進数字だけを受理し、`1.0`、`1e3`、`0x10` などの不正または範囲外の値は、cold start ごとに固定 warn を最大1回記録して180日にフォールバックします。この alpha 版には恒久アーカイブがないため、`0` を選ぶ場合は保存量、削除手順、プライバシーポリシーを別途設計してください。

⚠️ `sam deploy --guided` は `NoEcho` パラメータ（`AnthropicApiKey`・`FaqRemoteRagExternalId`・`FaqQaNotifyWebhookUrl`・Slack の secret 2値）の入力を、既定値の表示なしで求めます。SAM CLI のバージョンによっては空のまま進められないため、これらを使わない最小デプロイでは上記の非対話コマンド（未指定のパラメータは既定の空になり、QAログ表 `{Environment}-{FaqTableNamespace}-SlackQaLogs` を除く Slack リソースは作成されません）を推奨します。`--guided` を使う場合も「Save arguments to configuration file」で secret を `samconfig.toml` に保存しないでください。

### FAQ の時間予算

| 設定 | 既定値 | 解釈 |
| --- | --- | --- |
| SAM `FaqChatFunctionTimeoutSeconds` | 28 秒 | FAQ shell Lambda の Timeout。10〜300秒のASCII十進整数のみ受理し、先頭ゼロ・符号・空白・小数・指数表記は拒否 |
| `faq/config.js` の `requestTimeoutMs` | 40000 ms | UI の要求全体の待機上限。正の整数の数値を指定（最大2147483647 ms）。未設定・文字列・小数・範囲外などの不正値は40000 ms |

shell は Lambda context の残時間から返却余白2500 msを引いて remote の残予算を決めます。remote-v1 の `remainingMs` 契約上限60000 msは維持し、Timeout を環境変数へ重複設定しません。UI の設定は公開版の `faq/config.js` にも40000 msで同梱します。正本の frontend 設定生成スクリプトもこの値を `faq/config.local.js` へ引き継ぎます。

この変更は設定化だけで、HTTP API の統合時間上限や現在の既定値は変更しません。Lambda と UI の値だけを延長しても入口の制限は解消されません。時間延長は PR4 の段階切替と同時に行います。

### 公開 REST STREAM 経路（PR3・既定 OFF）

`FaqRestStreamApiEnabled=true` を指定すると、Regional REST API と専用の
`FaqChatStreamFunction` が追加されます。既定の `false` では REST API、専用関数、
呼び出し権限、Gateway Responses、REST 用 Output は生成しません。従来の HTTP API と
`FaqApiUrl` は常設のままです。追加経路は `POST` / `OPTIONS /faq-chat` および
`POST` / `OPTIONS /agents/{agentId}/faq-chat` を扱い、各メソッドの throttle は
2 requests/秒・burst 5 です。OPTIONS は既存 handler の CORS ヘッダを使い、
Gateway の 4xx/5xx にも `FaqChatCorsOrigin` を返します。

REST API の Lambda proxy 統合は `responseTransferMode=STREAM` を使います。
`bootstrap.streamHandler` が REST v1 event を既存 handler の v2 event へ変換し、
完成した JSON 応答を `awslambda.HttpResponseStream.from` のステータス・ヘッダ付き
prelude と本文1回で出力します。UI の逐次表示や封筒契約の変更はありません。
統合時間は `FaqRestStreamIntegrationTimeoutSeconds`（既定70秒）で指定し、
許容値は1・5・10・20・29・30・45・60・70・90・120・180・240・300・600・900秒です。
AWS の STREAM 統合上限は900秒（15分）、Regional の idle timeout は300秒です。
この段階では完成 JSON まで書き出さないため、長時間設定時も idle timeout が別の上限になります。
Lambda の `FaqChatFunctionTimeoutSeconds=28` 秒、UI の40000 ms、remote の既存予算は
延長しません。[AWS の STREAM 制約](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html)と
[Lambda 統合形式](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html)を参照してください。

有効時の `FaqRestStreamApiUrl` は stage を含む base URL です。末尾に `/faq-chat` を
1回結合して使います。専用関数は従来と別の IAM role を持つため、remote 利用時は
`FaqChatStreamCallerRoleArn` を MIF 側の invoker role の信頼対象に登録する準備も必要です。
同じ `FaqRemoteRagRoleArn`・External ID・環境変数・IAM policy を設定するだけでは、
新しい caller role の信頼は追加されません。
MIF 運用者は旧 caller の設定を保持し、任意の stream caller 追加設定で exact ARN を登録します。
この設定の初回既定値は空で、deploy 入力は非空時だけ override し、未指定時は override しません。
旧 trust を置換せず、同じ tenant 固有 ExternalId を条件に新旧両 caller を許可します。
stream caller だけの設定は拒否します。同じ invoker role を引き受けるため、role と tenant の対応表は変更しません。

公開 lite の UI 切替は、PR4 の検証を完了してから次の手動手順で行います。
正本の `generate-frontend-env.sh` は公開配布に含まれず、この切替には使えません。
tenant chatops 側の対応には、正本 `lambda/template.yaml` に同じパラメータと Output を追加する別 PR が必要です。

1. 配信中の `faq/config.js` と `faq/index.html`、旧 API URL / origin を退避し、対象の公開 lite stack から新旧の Output を取得します。`STACK_NAME` / `REGION` は対象 stack に置き換えます。`FaqRestStreamApiUrl` が空または `None` なら切替を中止します。

   ```bash
   aws cloudformation describe-stacks --stack-name STACK_NAME --region REGION \
     --query "Stacks[0].Outputs[?OutputKey=='FaqRestStreamApiUrl'].OutputValue | [0]" --output text
   aws cloudformation describe-stacks --stack-name STACK_NAME --region REGION \
     --query "Stacks[0].Outputs[?OutputKey=='FaqApiUrl'].OutputValue | [0]" --output text
   ```

2. **先に `faq/index.html` の CSP `connect-src` で新旧両 API origin を許可して配信します。** 新 origin は `FaqRestStreamApiUrl` の `https://ホスト名` 部分（stage なし）です。旧 origin も切り戻し期間中保持します。以下は既存配信先が bucket 直下の場合で、prefix 配下なら既存キーを指定してください。**bucket 全面 sync は禁止**です。

   ```bash
   aws s3 cp faq/index.html s3://FAQ_UI_BUCKET/index.html --content-type text/html
   ```

   CloudFront などの `index.html` キャッシュを更新し、新旧 origin を許可する CSP が反映されたことを確認します。
3. その後、配信中の設定を基に `faq/config.js` の `apiBaseUrl` を `FaqRestStreamApiUrl` の値（stage を含み、末尾スラッシュなし）へ切り替えます。ここでは `/faq-chat` を付けません。config を先に変えると旧 CSP に拒否され得ます。

   ```bash
   aws s3 cp faq/config.js s3://FAQ_UI_BUCKET/config.js --content-type application/javascript
   ```

   config のキャッシュを更新し、ブラウザの送信先・CSP・FAQ 応答を確認します。時間延長時の `requestTimeoutMs` は下記の順序で75000に設定します。
4. **時間延長後の切り戻しは URL 復元だけでは不十分です。** MIF の cap / TTL / Timeout を **20000 ms / 30000 ms / 28秒**へ一組で短縮 → 処理中要求の完了を確認 → shell の `FaqChatFunctionTimeoutSeconds` を **28秒**へ戻す → 旧 throttle / routes / caller trust の利用可能性を確認・必要なら復元 → shell の MIF base URL と UI URL・CSP を復元、の順で行います。MIF / shell の処理枠は維持します。
   MIF base URL は記録した旧 API Gateway URL、UI の旧 URL は公開 lite の `FaqApiUrl` です（正本 tenant chatops の同等 Output 名は `ApiEndpoint`）。UI では旧 origin を許可する CSP を先に反映し、config の `apiBaseUrl` と `requestTimeoutMs` を旧値へ戻してキャッシュ更新・動作確認後、新 origin を CSP から外します。

PR4 の有効化・切替チェックリスト:

- **検証ステージで一度 `FaqRestStreamApiEnabled=true` の CreateStack まで通してから本番切替する**（正本 `CLAUDE.md` の「最初の有効化は必ず検証ステージから」に従う）。`Fn::If` 方式は検証 stack の CreateStack で `timeoutInMillis: 70000`（整数）・`responseTransferMode: STREAM`・既存封筒と同一の応答バイトを確認済みです（本番切替前に自分の検証ステージでも同じ確認を行ってください）。実機で確認したのは70秒分岐のみで、他の分岐はテストで固定した構造同一性に依存するため、配布先の検証ステージでは切替に使う値で再確認してください。`sam build` / `sam validate --lint`、ローカル SAM 変換後のテンプレートテスト、read-only の `aws cloudformation validate-template` だけでは、CloudFormation 側の Processed template や `responseTransferMode: STREAM` の実配備を確認できません。新規検証 stack の Processed template で4経路の `timeoutInMillis` を確認し、整数として受理され、実際の STREAM 応答が既存封筒を保つことを確認します。
- 併存前に `FaqMaxInflight` を正の値（1〜10）に設定し、両関数の `FAQ_MAX_INFLIGHT` リースを有効にします。`FaqChatStreamFunction` に `ReservedConcurrentExecutions` はなく、共有する同時処理ガードはこのリースだけです（既定0は無効）。新旧入口へ同時に流入させ、合算が `FaqMaxInflight` で制限されること、解放後に再取得できることを確認します。
- 併存中の throttle は API 単位で独立します。既定値では同じ FAQ route の実効レート上限は2系統合計 **4 rps / burst 10**（各2 rps / burst 5）になるため、両方への流入と共有リースの拒否を確認します。
- remote 利用時は MIF の tenant 満杯・total 満杯をそれぞれ発生させ、公開 shell の429、busy 時の quota 未消費、解放後の再取得を確認します。MIF total が4の場合、`eval-public` に `maxInflight=1` を設定し、評価だけで全4枠を占有させない選択肢があります。caller / MIF 両アカウントの `ConcurrentExecutions` / `Throttles` と処理枠メトリクスも照合します。
- 新旧両 caller の trust / ExternalId を保持し、**実 caller の実行環境または同じ実行 role の一時検証関数**から ExternalId 付き AssumeRole → SigV4（service `lambda`）による Function URL 呼出しの許可を実 role smoke で確認します。ExternalId なし・不一致、trust 対象外 principal の拒否と、通常の直接 Invoke が Function URL 限定権限では拒否されることも確認します。管理者 credential からの検証だけでは実 caller の権限を確認できません。
- 延長後は単位を揃えて **`shell Lambda Timeout < REST 統合 timeout < UI requestTimeoutMs`（例 65 < 70 < 75 秒）**、
  かつ **`MIF cap + 余白 ≤ MIF Timeout < shell Timeout`、全体 < Regional idle 300s** を満たします。
  MIF の余白は生成250 ms + 退出1500 msです。UI が Gateway の応答を待てる順序にし、先行 abort を防ぎます。
- PR4 の最終設定は **MIF cap 45000 ms / TTL 60000 ms / MIF Timeout 60秒 / shell 65秒 / REST 統合70秒 / UI `requestTimeoutMs=75000`** の組です。cap 45秒へ延長する際は TTL 60秒も必ず同時に設定します。旧 TTL 30000 ms のままでは `sessionTtlMs >= cap + 250 ms` の初期化検証を通りません。
- 延長順序は **REST 統合70秒 → UI 75秒 → shell 65秒 → MIF 45000 / 60000 / 60（一組）**です。処理枠の有効化・計測と、MIF Function URL / 公開 REST STREAM への切替・動作確認を終えてから延長します。切り戻しは上記手順4の順序で行います。
- 切替後は次のパラメータと手順で旧 HTTP API の FAQ 経路を絞り、利用がなくなってから停止します。UI の送信先変更だけでは旧公開入口は止まりません。

旧 HTTP API の FAQ 経路用パラメータ（PR5）:

| SAM パラメータ | 既定値 | 動作 |
| --- | --- | --- |
| `FaqHttpApiFaqRoutesEnabled` | 文字列 `'true'` | `'true'` / `'false'`。`false` は Slack agent 設定済みの場合のみ指定でき、`POST` / `OPTIONS /faq-chat` と `POST` / `OPTIONS /agents/{agentId}/faq-chat` の4ルートと呼出し権限、および2つの POST RouteSettings を生成しません |
| `FaqHttpApiFaqThrottlingRateLimit` | 2 | 旧 FAQ の2つの POST route の requests/秒。整数1〜100 |
| `FaqHttpApiFaqThrottlingBurstLimit` | 5 | 旧 FAQ の2つの POST route の burst。整数1〜100 |

SAM が `Events: !If` を受理しないため、従来の4 events 相当の FAQ ルートを明示的な OpenAPI `DefinitionBody` に定義し、`HasFaqHttpApiFaqRoutes` による `!If` で切り替えます。4つの Lambda 呼出し権限にも同じ Condition を付け、従来の logical ID と権限範囲を維持します。`FaqChatFunction` と IAM role は無効化中も保持し、再有効化時に remote のクロスアカウント trust が参照する principal を作り直しません。Slack の event と統合は従来どおりです。

throttle の2パラメータは `Number` 型です。`AllowedPattern` は `Number` に使えないため、`MinValue: 1` / `MaxValue: 100` と `AllowedValues` の整数1〜100で範囲と整数性を検証します。遮断は `FaqHttpApiFaqRoutesEnabled=false`（Slack 設定あり）で行います。

1. 切替前の throttle / routes / caller trust を記録します。移行観測期間は `FaqHttpApiFaqThrottlingRateLimit=1` / `FaqHttpApiFaqThrottlingBurstLimit=2` へ下げ、数日間 `faq_shell_timing` の `entrypoint=http-api` 件数を観測します。REST STREAM 側の throttle は変わりません。
   整数のため 1 rps 未満の段階は作れません。rate 1 / burst 2 が実質的な最小段階です。
2. 旧 FAQ ルートを無効化できるのは Slack agent を設定している配布先のみです。Slack 非利用なら HTTP API に route が残らないため、無効化せず throttle で絞ります（`FaqHttpApiMustKeepARoute` Rule が Slack 未設定での無効化を拒否します）。Slack 設定ありで旧入口の利用件数が0になったら、`FaqHttpApiFaqRoutesEnabled=false` で再デプロイします。FAQ の4ルートと呼出し権限、および2つの POST RouteSettings だけを削除し、`HasSlackAgent` で制御される `POST /slack/events` とその RouteSettings は変更しません。HTTP API 自体と Output `FaqApiUrl` は Slack 用として残りますが、**この URL の FAQ ルートは無効**です。
3. 旧 FAQ 入口の再有効化は `FaqHttpApiFaqRoutesEnabled=true` へ戻して再デプロイします。UI の CSP に旧 origin を保持している間は CSP の再変更を待たずに旧入口へ復帰できます。**時間延長後の切り戻しは前述の UI 切替手順4を守り**、MIF の時間短縮・処理中要求の完了・shell の短縮後に旧入口を再有効化し、記録した throttle / caller trust を確認・必要なら復元してから UI の URL と待機時間を戻します。
4. 旧入口を無効化した後は UI の CSP `connect-src` から旧 origin を削除して構いません。削除後に切り戻す場合は、前述の UI 切替手順4に従い旧 origin を許可する CSP の配信・キャッシュ更新を先に完了してから UI の URL を戻します。

統合時間は、秒パラメータを `Conditions` の `Fn::Equals` で比較し、4経路それぞれの
`Fn::If` の連鎖で整数ミリ秒リテラルを返します。既存の許容値16個と既定70秒を維持し、
最後の分岐は `AllowedValues` により900秒だけが残るため900000を返します。
`Fn::FindInMap` 方式は検証 stack の CreateStack で引数解決エラーになったため廃止しました。
[CloudFormation の `Fn::If`](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/intrinsic-function-reference-conditions.html#intrinsic-function-reference-conditions-if)
はリソースのプロパティ値とネストをサポートしています。
[ネイティブ CFN の Integration](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-apigateway-method-integration.html)
にも `ResponseTransferMode: STREAM` はありますが、既存 SAM の stage・deployment・Gateway Responses を
維持し、修正を時間変換に限定するため `Fn::If` 方式を採用しています。
テンプレートテストで許容値と条件・整数リテラルの対応、SAM 変換後の全許容値と4経路、
既定 OFF 時に REST 一式が生成されないことを固定します。

監視は専用 Lambda の CloudWatch `Invocations`・`Duration`・`Errors`・`Throttles` と、
REST API の CloudWatch `Count`・`4XXError`・`5XXError`・`Latency`・`IntegrationLatency` を
API/stage 単位で確認します。`faq_shell_timing.entrypoint=rest-stream`（旧入口は `http-api`）で
shell のログを分け、Gateway 側で止まった429/5xxと Lambda 内の障害を照合します。
`faq_chat` メトリクスの既存フィールドは不変です。

### FAQ Q&A の Slack 通知（任意）

SAM parameter `FaqQaNotifyWebhookUrl` に Slack Incoming Webhook URL を秘密管理されたデプロイ入力から渡すと、Q&A ログの DynamoDB 保存成功後に通知します。受理するのは標準の `https://hooks.slack.com/services/{workspace}/{channel}/{secret}` 形式（3つの path segment は ASCII 英数字のみ）です。userinfo、独自 port、query、fragment、segment の不足・追加を含む URL は固定 warn を残して送信せず、HTTP redirect も追従しません。未指定（既定の空文字）では通知fetchは発生しません。この機能は下記 Slack bot の有効化条件や資格情報とは独立しています。DynamoDB の Q&A ログが正本であり、Slack 通知は補助経路です。`FaqQaNotifyAsyncEnabled=false`（既定）では従来の同期best-effort配送を維持し、`true` では保存した行を専用workerが再試行付きで配送します。

通知には、保存済みレコードと同じ接触先マスク・NFKC 正規化済みの質問と回答の冒頭、`responseType`、`route`、`totalMs` などを含めます。同期経路の Webhook POST は FAQ 応答前に待機し、呼び出し元の残余予算に従い最長2秒で打ち切ります。非同期 stream worker の POST は最長10秒で、Lambda の `Timeout=15` 秒の内側で実行します。claim 完了後に Lambda の残余時間から `store.complete()` 用の予備 `COMPLETE_RESERVE_MS=2,000` ms を引き、`min(10,000 ms, 残余時間 - 2,000 ms)` を送信予算にします。予算が非正値なら送信せず再試行対象とし、テスト等で Lambda context がない場合だけ固定10秒を使います。HTTPエラー・通信失敗・タイムアウトは Lambda の warn ログに残し、FAQ の応答を失敗させません。URL は `samconfig.toml`、shell history、CI log、公開コードへ保存せず、secret 管理された CI/CD 入力などから渡してください。

既定の直接通知経路は同期リトライや DLQ への退避を行いません。Slack が HTTP 429 を返した通知は warn を残して破棄します。応答前のSlack待機を除く場合は、次の非同期配送を有効にしてください。非同期workerもレート制御専用queueではないため、大量通知や429が続く場合は通知量と再試行・DLQを監視します。

運用時は Lambda の CloudWatch Logs で安定 prefix `[faq-chat] Q&A Slack notification` を検索し、`failed`、`timed out`、`rate limited`、`skipped` の warn を対象に metric filter と alarm を設定してください。`started` は有効な正の送信予算で実際に送信を開始する直前、`completed` は成功時だけ記録されます。非正値の予算では fetch を開始せず、handler が通知前に予算切れを検知した場合は `budget`、`remaining`、`route`（named agent では `agentId` も）、adapter の防御で検知した場合は `budgetMs=0`、元の `requestedMs`、`reason=non_positive_budget` を持つ `skipped` だけを記録します。どちらも `started` / `completed` は発生しません。`started` があり `completed` がない試行も調査対象です。通知漏れの確認と再処理は Slack 履歴ではなく DynamoDB の Q&A ログを基準に行ってください。

#### Streams による非同期通知の配備・確認・rollback

`FaqQaNotifyAsyncEnabled` はデプロイ時だけ設定できる `true` / `false`（既定）のパラメータで、shell の `FAQ_QA_NOTIFY_ASYNC_ENABLED` へ反映されます。`true` の場合もQA Putは従来の短い予算内で待ちます。通知所有者を同じ行に `qaNotifyDelivery=async-v1` として保存するため、Put失敗で行が作られなければ通知も発生しません。同期行は `sync-v1`、通知未設定行は `disabled` となり、workerが同期通知を重ねて送ることはありません。Put待機のtimeoutは書込み失敗の確定ではなく、後でPutが成功すれば通知される場合があります。

1. レビュー済み公開revisionを利用者側cloneへ取り込み、既存のstack手順でまず `FaqQaNotifyAsyncEnabled=false` のまま配備します。新templateは `NEW_IMAGE` Streams、INSERTかつ `async-v1` のfilter、最小worker、専用IAM role、14日保持のSQS DLQとalarmを常設します。既存接続先・transport・保持日数・秘密入力を維持してください。
2. `FaqQaNotifyFunctionName` / `FaqQaNotifyDLQUrl` / `FaqQaNotifyDLQAlarmName` のstack出力を確認し、event source mappingがEnabled、filterと `ReportBatchItemFailures` が設定済みであることを確認します。DLQ alarmの通知先は運用担当者が設定してください。worker失敗、IteratorAge、DestinationDeliveryFailuresも監視対象です。
3. Webhook設定を保持して `FaqQaNotifyAsyncEnabled=true` で更新し、shell環境変数を読み戻します。別途承認された合成データの動作確認で、QA行の `qaNotifyDelivery=async-v1`、配送後の `qaNotifyStatus=sent`、Slack1件、shellの `qa_notify_outcome=skipped` とworker成功ログを照合します。本文・連絡先・認証値を計測ログに出さず、QA失敗・重複再配信・一時失敗とDLQ経路も検証環境で確認してください。
4. workerは元QA行を条件付き更新で60秒leaseし、送信成功後に `sent` を記録します。完了済み行の再配信は送信を省略します。batchは1件、最大10回再試行またはレコード年齢1時間で打ち切り、SQS DLQへ退避します。Slack送信とDynamoDB完了記録は原子的に確定できないため、その間の停止や曖昧なHTTP結果では重複通知が残ります。exactly-once配送ではありません。
5. **rollback は `FaqQaNotifyAsyncEnabled=false` で同じrevisionを再配備します。** 新しい行が同期に戻ったことを確認し、既存 `async-v1` 行はworkerに処理させます。滞留中はworker・Streams・Webhookを削除しないでください。古いtemplateへの巻戻しはconsumerを消す可能性があるため、未完了行・IteratorAge・DLQが解消するまで行いません。

Streamsの保持は24時間で、SQS失敗宛先には通常、元レコード全体ではなくstream/shard/sequence等の失敗batch情報が入ります。DLQメッセージをそのままworkerへ渡すことはできません。保持期間内はそのsequenceから元INSERTを取得し、期間後は権限保持者がQA表の未完了 `async-v1` 行（`qaNotifySequenceNumber` も照合）から元キーを特定して、`INSERT` / `Keys` / `NewImage.qaNotifyDelivery` / `SequenceNumber` を持つイベントを再構成します。原因を修正し、lease失効と `sent` 未設定を確認して同じworkerで再処理し、`sent` を確認してからDLQを削除します。キーを確定できないものを推測で再送しないでください。QA表のTTLや手動削除で元行がなくなると復旧できないため、調査中の保持方針を決めてください。

`timeout` 起因の復旧では、worker の `started` ログの `timeoutMs` と `timed out`、Lambda の `Task timed out` を照合します。worker の送信上限は同期経路の2秒ではなく、claim 後の残余時間に連動する最長10秒です。claim が遅い場合は送信予算が短くなるため、Slack の応答だけでなく DynamoDB の claim / complete の遅延も確認してください。2秒の完了記録予備は `store.complete()` の成功を保証するものではありません。Lambda が送信後・完了記録前に停止した可能性があれば、上記の lease と `sent` を確認し、再処理による重複通知の可能性を扱ってください。

workerの固定ログ `faq_qa_notify_worker outcome=success|duplicate|failure` とDLQを照合します。公開workerは通知だけを担当し、恒久アーカイブ・非公開RAG・prompt・KBへのアクセスはありません。計測フィールドの定義は[公開shell telemetry](lambda/functions/faq-chat/adapters/remote/README.md#terminal-shell-timing-fields)を参照してください。

既存の応答メトリクス `faq_chat` は応答確定時点で出力し、shell の終端計測は別の `faq_shell_timing` 行として同じ request ID で関連付けます。メトリクスフィルタは部分文字列検索ではなく `{ $.metric = "faq_chat" }` の完全一致を使ってください。Lambda のハードタイムアウトでは終端行が出ない場合があります。

### FAQ の処理枠（既定無効）

SAM パラメータ `FaqMaxInflight` は環境変数 `FAQ_MAX_INFLIGHT` に配線され、整数 0〜10 を受理します。
既定の `0` は無効で、処理枠の DynamoDB I/O は発生しません。有効化と枠数の決定は PR4 の段階切替で行います。
公開 API Gateway throttle の既定値（2 rps / burst 5）も維持します。旧 HTTP API の FAQ 経路だけを絞る場合は上記 PR5 のパラメータを使います。

有効時は Settings テーブルの `key=faq_inflight_slot#<i>` に条件付き UpdateItem で期限付きリースを取得します。
新しいテーブルや Settings の Key/TTL 変更はなく、追加 IAM は Settings だけの UpdateItem です。
入力検証・Settings 読込み後、Claude router と KB 検索より前に取得し、Claude / remote を呼ばない
`template_only` の即答・確定 refuse は枠を取りません。DynamoDB のない local adapter も無効です。
リースは Lambda context の残時間から算出し、caller deadline や返却余白を引きません。
正常終了・例外・timeout の解放は ownerToken 一致条件付きの best-effort で、失敗しても `leaseUntil` により自然回収されます。

全枠が満杯なら待たずに HTTP **429**、`Retry-After: 5`、本文 `{ "error": "busy", "retryable": true }` を返します。
CORS ヘッダは既存応答と同じです。remote の `busy` DTO（`retryable: true`）も同じ429に変換し、
`Retry-After` は `retryAfterMs` を秒へ切り上げた値を1〜60秒に制限して返します。shell 自身の枠満杯時は5秒です。
refuse 封筒にしません。UI は既存の429分岐をそのまま使います。日次制限の `quota_exceeded` とは別のエラーです。

終端メトリクス `faq_shell_timing` に `inflight_outcome`（`acquired` / `busy` / `disabled`）、
`inflight_slot`（番号または null）、`inflight_acquire_ms`、`inflight_release_outcome` を追加します。
既存 `faq_chat` メトリクスは変更しません。

### Slack bot（フリー版）

Slack bot は AWS 上の Events API、FIFO SQS、worker を使う非同期経路です。フリー版は **1 stack = 1 Slack agent** で、DM と許可した channel の `@bot` mention に応答します。

1. Slack の **Create New App** からアプリを作成し、Bot Token Scopes に `chat:write`、`app_mentions:read`、`im:history`、`channels:history` を設定して workspace へインストールします。この時点では Request URL と event subscription は設定しません。Basic Information / OAuth & Permissions から Signing Secret、Bot User OAuth Token、App ID（`A...`）、Team ID（`T...`）、Bot User ID（`U...`）を控えます。scope を変更した場合は workspace へ再インストールしてください。`channels:history` は bot を招待した allowlist channel のスレッド文脈取得にだけ使い、`message.channels` の購読には使いません。private channel 用の `groups:history` はこの手順では付与しません。
2. 次の7つの SAM parameter をすべて設定して stack をデプロイします。7つをすべて空にすると、QAログ表 `{Environment}-{FaqTableNamespace}-SlackQaLogs`（無効化してもログを保全するため常に作成される空表・コストゼロ）を除き、Slack リソースは作成されません。一部だけを設定した構成は CloudFormation Rule が拒否します。

   | SAM parameter | 内容 |
   | --- | --- |
   | `SlackSigningSecret` | Slack App の Signing Secret |
   | `SlackBotToken` | Bot User OAuth Token |
   | `SlackApiAppId` | App ID（`A...`） |
   | `SlackTeamId` | 許可する workspace の Team ID（`T...`） |
   | `SlackBotUserId` | Bot User ID（`U...`） |
   | `SlackAgentId` | この stack が固定で処理する agent ID |
   | `SlackAllowedChannelIds` | 応答を許可する channel ID（`C...`）のカンマ区切り |

   Slack を有効にする場合、`SlackAllowedChannelIds` は最低1件必要です。空は全 channel 許可を意味しません。また Slack worker は AI 生成を行うため、既存の `AnthropicApiKey` も非空で設定してください。`SlackSigningSecret`、`SlackBotToken`、`AnthropicApiKey` は秘密管理されたデプロイ入力から渡し、shell history、CI log、`samconfig.toml` へ平文で残さないでください。
3. デプロイ後、CloudFormation output `FaqApiUrl` と `SlackIngressEndpointPath` を連結した URL（例: `https://example.execute-api.us-west-2.amazonaws.com/dev/slack/events`）を Slack App の **Event Subscriptions → Request URL** に設定します。`Verified` になったら **Subscribe to bot events** に `app_mention` と `message.im` を追加します。通常の channel 投稿は入口で処理しないため、`message.channels` は購読しません。allowlist 外、Slack Connect 共有 channel、bot 自身の投稿、編集・削除などの subtype event には応答しません。
4. HTTP named agent と共用する `AgentConfig` 行を CLI で投入します。JSON の `agentId` は `SlackAgentId` と完全に一致させてください。

   ```json
   {
     "agentId": "support",
     "enabled": true,
     "kbAgentId": "support",
     "systemPrompt": "自組織のFAQに基づき、簡潔に回答してください。",
     "model": "claude-haiku-4-5-20251001",
     "maxOutputTokens": 600,
     "logPolicy": "metadata_only"
   }
   ```

   ```bash
   # ENVIRONMENT-NAMESPACE は stack の {Environment}-{FaqTableNamespace}、
   # テーブル名は CloudFormation output FaqAgentConfigTableName の値に置き換える
   export FAQ_TABLE_NAME_PREFIX=ENVIRONMENT-NAMESPACE
   export FAQ_AGENT_CONFIG_TABLE_NAME=ENVIRONMENT-NAMESPACE-AgentConfig
   npx tsx scripts/agent-config-cli.ts validate ./slack-agent-profile.json
   npx tsx scripts/agent-config-cli.ts upsert ./slack-agent-profile.json
   ```

   `logPolicy` は `off` / `metadata_only` / `redacted_full` から選びます。省略時は本文を保存しない `metadata_only` です。全文保存を行う `redacted_full` は、保存内容とアクセス権を確認したうえで明示的に指定してください。`KnowledgeEntries` は `kbAgentId`（省略時は `agentId`）が一致する公開・有効な行だけが使われます。
5. `SlackAllowedChannelIds` に登録した channel へ bot を招待し、DMへの質問と channelでの `@bot 質問` を確認します。

CloudWatch alarm `{Environment}-{FaqTableNamespace}-slack-events-dlq-not-empty` は、worker が同じイベントを5回処理できず、DLQ の可視メッセージ数が1件以上になったとき `ALARM` になります。alarm action は stackで固定しないため、Slackを有効にする前に通知先を設定してください。`ALARM` になった場合は worker のCloudWatch LogsとDLQメッセージを確認し、14日のDLQ保持期限内に原因を調査します。

### free から remote へ切り替える二段 onboarding

`remote` は、公開 lite 殻の Lambda が MIF 側の cross-account IAM role を `sts:AssumeRole` し、取得した一時 credential で Remote RAG API を SigV4 署名して呼び出す profile です。Role ARN を wildcard にした権限や、同一アカウント API への直接 `execute-api:Invoke` 権限は使いません。設定不備時に `free` 検索へ静かにフォールバックすることもありません。

デプロイは次の二段階で行います。

1. **free/bootstrap**: `FaqPortsProfile=free` のまま lite stack を先にデプロイします。remote 用3パラメータは空で構いません。CloudFormation output `FaqChatCallerRoleArn` から、SAM が生成した FAQ Lambda caller role ARN を取得します。
2. **remote 有効化**: caller role ARN と tenant 用 ExternalId を MIF 運用者へ渡し、MIF 側 invoker role の trust policy 登録完了を待ちます。その後、同じ stack を `FaqPortsProfile=remote` と下表の3値で更新します。

caller role ARN は、たとえば次の読み取り専用コマンドでも取得できます。

```bash
aws cloudformation describe-stacks \
  --stack-name <lite-stack-name> \
  --region <remote-ragと同じregion> \
  --query "Stacks[0].Outputs[?OutputKey=='FaqChatCallerRoleArn'].OutputValue" \
  --output text
```

| SAM parameter | free/bootstrap | remote 更新時 | 内容 |
| --- | --- | --- | --- |
| `FaqPortsProfile` | `free` | `remote` | RAG 実装の選択。公開 lite ではこの2値だけを受け付けます。 |
| `FaqRemoteRagTransport` | `split-v1`（既定） | `split-v1`（既定）または `one-shot-v1` | remote の HTTP 契約。one-shot は `POST /v1/answer` を1回だけ呼びます。 |
| `FaqRemoteRagBaseUrl` | 空 | 必須 | MIF Remote RAG API の HTTPS Base URL。既存 API Gateway または IAM 認証 Lambda Function URL を指定でき、operation suffix は含めません。 |
| `FaqRemoteRagRoleArn` | 空 | 必須 | MIF が提示した cross-account invoker role の完全な IAM role ARN。 |
| `FaqRemoteRagExternalId` | 空 | 必須 | MIF trust policy と一致する tenant 固有 ExternalId。2〜1224文字の STS 許可文字だけを受け付け、CloudFormation では `NoEcho` です。 |

transport はデプロイ時の `FaqRemoteRagTransport` → `FAQ_REMOTE_RAG_TRANSPORT` だけで選択し、`FAQ_PORTS_PROFILE=remote` のときだけ読みます。Settings やリクエストからは変更できません。既定の `split-v1` を維持し、one-shot は MIF 側の有効化と品質・性能評価が完了してから opt-in します。ロールバックは `FaqRemoteRagTransport=split-v1` での再デプロイです。

署名 service は `FaqRemoteRagBaseUrl` → `FAQ_REMOTE_RAG_BASE_URL` のホスト名から自動判定します。
`^[a-z0-9]+\.lambda-url\.([a-z0-9-]+)\.on\.aws$` に完全一致する Function URL は `lambda`、
それ以外は従来どおり `execute-api` です。署名 service を上書きする環境変数・SAM パラメータは設けません。
標準の Function URL / API Gateway ホストの region が shell の `AWS_REGION` と異なる場合は、
credential 取得や HTTP 呼出し前に構成エラーで停止します。custom domain の region は推定しません。
リクエスト先は引き続き `${baseUrl}/v1/${operation}` で、DTO・時間予算・transport の既定値は変わりません。

Function URL は入口追加のみで、既存 API Gateway からの切替は PR4 です。上記「公開 REST STREAM 経路」の
チェックリストと配信・切り戻し順序に従い、切替時は MIF が提示する URL を `FaqRemoteRagBaseUrl` に指定します。
時間延長後の切り戻しは MIF の時間短縮・処理完了・shell の短縮・旧入口の確認を先に行い、
記録した API Gateway Base URL に戻します。MIF 側の引受先 role に対象 v1 関数限定の `lambda:InvokeFunctionUrl` と
`lambda:InvokedViaFunctionUrl=true` 条件付き `lambda:InvokeFunction` が必要です。
lite caller role の権限は引き続き exact role への `sts:AssumeRole` のみです。

### 既存利用者の one-shot 切替手順

1. 正本から公開同期され、レビュー済みの公開 revision を clone 側へ取り込みます。`PUBLIC_SYNC_MANIFEST.json` の source ref / SHA と、`remote-one-shot-v1` client、`FaqRemoteRagTransport` を含む template の対応を確認し、切替前の revision と `split-v1` 設定を記録します。コードがあるだけでは本番切替の承認にはなりません。
2. MIF 担当者に、その tenant の `enabled=true` / `answerEnabled=true`、global gate、exact tenant role mapping、MIF 所有 invoker role の exact `api/POST/v1/answer` への `execute-api:Invoke` を確認してもらいます。caller の exact role への AssumeRole 許可と MIF 側 trust / ExternalId の一致も必要です。gate は最大60秒の cache 反映待ちがあり、MIF 側の現在値や認証値は公開文書に記録しません。
3. 品質・性能評価と運用承認の後、利用者側の権限保持者が既存 faq-lite の配備手順で `FaqPortsProfile=remote` を維持し、`FaqRemoteRagTransport=one-shot-v1` を指定して再配備します。既存の接続先・role・秘密入力・通知設定を保持し、実環境の `FAQ_REMOTE_RAG_TRANSPORT` を読み戻します。
4. 別途承認された動作確認で `remote_transport=one-shot-v1`、`remote_operation=answer`、`remote_http_calls=1` と、shell / MIF の request ID の対応を確認します。401/403、429/503、timeout、未対応route、品質悪化があれば切替を停止し、本文を含まない件数・終端余裕を保存します。ローカル単体テストだけで性能改善を判断しません。
5. **rollback は caller を `FaqRemoteRagTransport=split-v1` に戻して再配備する操作です。** 環境変数と新しい shell metric を読み戻し、通常の検索回答では retrieve / generate に戻ったことを確認します。MIF の `answerEnabled=false` だけでは one-shot caller が拒否を続けるため不十分です。caller 切戻しと処理中要求の完了後、必要なら MIF 担当者が answer gate を閉じます。処理中 answer の split 再送や自動 fallback は行いません。

one-shot は HTTP retry を行わず、timeout・network error・401/403・429・5xx や未対応 route でも split/free にフォールバックしません。契約に一致する `no_match` の404は通常の検索不一致として扱い、それ以外の404/501は `remote_transport_unsupported` の技術的拒否として記録します。MIF invoker role には exact `/api/POST/v1/answer` の実行権限が必要で、lite caller role は引き続き exact role への `sts:AssumeRole` のみです。

**lite 殻と MIF Remote RAG API は同一 AWS region に配置してください。** Base URL、role ARN、ExternalId のいずれかが欠けた `remote` 更新は CloudFormation Rules が拒否します。Role ARN と ExternalId の片方だけを設定することもできません。

`NoEcho` は shell history、CI log、`samconfig.toml` への保存を防ぎません。ExternalId は secret 管理された CI/CD 入力などから渡し、コマンドや設定ファイルへ平文で残さないでください。なお ExternalId は Lambda の環境変数として**平文で保存**され、同一アカウントで `lambda:GetFunctionConfiguration` を持つ主体からは読み取れます。ExternalId は confused deputy 対策であって秘匿情報ではない前提です（主たる防御は MIF 側 trust policy の exact caller principal 一致）。したがって値の管理は「秘密鍵」ではなく「漏れても即座に権限昇格にはならないが、不用意にログ/リポジトリへ残さない」レベルで扱ってください。

`AnthropicApiKey` を `samconfig.toml` に保存しないでください。`sam deploy --guided` の「Save arguments to configuration file」は `N` を選び、API キーは秘密管理されたデプロイ入力から都度渡してください。CloudFormation の `NoEcho` は、ローカル設定ファイルへの保存を防ぐ機能ではありません。

これはデプロイ完了を保証する本番手順ではありません。組織のセキュリティ、プライバシー、法務、可用性要件に合わせたレビューが必要です。

## ライセンス

[MIF Free Self-Hosted License](LICENSE.md)（`LicenseRef-MIF-Free-Self-Hosted-1.0`）を参照してください。一般的なオープンソースライセンスではなく、1つの組織（または個人事業主）の内部利用に限った無償セルフホスト許諾です。本ソフトウェア自体を除く自組織の商品・サービスに付随する顧客対応・情報提供として、その利用者に自組織のデプロイで FAQ を使わせること（エンドユーザーアクセス）は内部利用に含まれます。他組織への再配布、他組織向けの SaaS/ホスティング、複数顧客への代理店展開、OEM、競合提供物の基礎利用には別途商用ライセンスが必要です。正文は英語で、日本語は参考訳です。

License: MIF Free Self-Hosted License (`LicenseRef-MIF-Free-Self-Hosted-1.0`) — free for one organization (or sole proprietor) to self-host for its own internal purposes, including end-user access as customer support or information provision incidental to its own products and services other than the Software itself; redistribution to other organizations, SaaS/hosting for other organizations, multi-customer agency use, OEM, and competing offerings require a separate commercial license. See [LICENSE.md](LICENSE.md); the English text controls.
