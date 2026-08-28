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
- **fail-closed な remote 境界:** remote の必須設定不足や組み合わせ不整合は CloudFormation Rules と初期化時検証で拒否します。remote 障害時に `free` へ自動フォールバックせず、[`remote-v1`](lambda/functions/faq-chat/adapters/remote/README.md) の入出力 DTO も未知フィールドを含めて検証します。
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
- Q&A は接触先らしき文字列をマスクして `FaqQaLogs` に保存し、`ttl` で180日後を期限にします。ただし DynamoDB TTL の削除時刻は厳密ではありません。
- Q&A ログの Streams consumer、通知、恒久アーカイブはこの alpha 版に含みません。テンプレートも Streams を有効化しません。
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

⚠️ `sam deploy --guided` は `NoEcho` パラメータ（`AnthropicApiKey`・`FaqRemoteRagExternalId`・Slack の secret 2値）の入力を、既定値の表示なしで求めます。SAM CLI のバージョンによっては空のまま進められないため、これらを使わない最小デプロイでは上記の非対話コマンド（未指定のパラメータは既定の空になり、QAログ表 `{Environment}-{FaqTableNamespace}-SlackQaLogs` を除く Slack リソースは作成されません）を推奨します。`--guided` を使う場合も「Save arguments to configuration file」で secret を `samconfig.toml` に保存しないでください。

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
| `FaqRemoteRagBaseUrl` | 空 | 必須 | MIF Remote RAG API の HTTPS Base URL。operation suffix は含めません。 |
| `FaqRemoteRagRoleArn` | 空 | 必須 | MIF が提示した cross-account invoker role の完全な IAM role ARN。 |
| `FaqRemoteRagExternalId` | 空 | 必須 | MIF trust policy と一致する tenant 固有 ExternalId。2〜1224文字の STS 許可文字だけを受け付け、CloudFormation では `NoEcho` です。 |

**lite 殻と MIF Remote RAG API は同一 AWS region に配置してください。** Base URL、role ARN、ExternalId のいずれかが欠けた `remote` 更新は CloudFormation Rules が拒否します。Role ARN と ExternalId の片方だけを設定することもできません。

`NoEcho` は shell history、CI log、`samconfig.toml` への保存を防ぎません。ExternalId は secret 管理された CI/CD 入力などから渡し、コマンドや設定ファイルへ平文で残さないでください。なお ExternalId は Lambda の環境変数として**平文で保存**され、同一アカウントで `lambda:GetFunctionConfiguration` を持つ主体からは読み取れます。ExternalId は confused deputy 対策であって秘匿情報ではない前提です（主たる防御は MIF 側 trust policy の exact caller principal 一致）。したがって値の管理は「秘密鍵」ではなく「漏れても即座に権限昇格にはならないが、不用意にログ/リポジトリへ残さない」レベルで扱ってください。

`AnthropicApiKey` を `samconfig.toml` に保存しないでください。`sam deploy --guided` の「Save arguments to configuration file」は `N` を選び、API キーは秘密管理されたデプロイ入力から都度渡してください。CloudFormation の `NoEcho` は、ローカル設定ファイルへの保存を防ぐ機能ではありません。

これはデプロイ完了を保証する本番手順ではありません。組織のセキュリティ、プライバシー、法務、可用性要件に合わせたレビューが必要です。

## ライセンス

[MIF Free Self-Hosted License](LICENSE.md)（`LicenseRef-MIF-Free-Self-Hosted-1.0`）を参照してください。一般的なオープンソースライセンスではなく、1つの組織（または個人事業主）の内部利用に限った無償セルフホスト許諾です。本ソフトウェア自体を除く自組織の商品・サービスに付随する顧客対応・情報提供として、その利用者に自組織のデプロイで FAQ を使わせること（エンドユーザーアクセス）は内部利用に含まれます。他組織への再配布、他組織向けの SaaS/ホスティング、複数顧客への代理店展開、OEM、競合提供物の基礎利用には別途商用ライセンスが必要です。正文は英語で、日本語は参考訳です。

License: MIF Free Self-Hosted License (`LicenseRef-MIF-Free-Self-Hosted-1.0`) — free for one organization (or sole proprietor) to self-host for its own internal purposes, including end-user access as customer support or information provision incidental to its own products and services other than the Software itself; redistribution to other organizations, SaaS/hosting for other organizations, multi-customer agency use, OEM, and competing offerings require a separate commercial license. See [LICENSE.md](LICENSE.md); the English text controls.
