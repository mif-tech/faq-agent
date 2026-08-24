# MIF FAQ Chat Free

MIF FAQ Chat Free は、非公開の正本から公開可能な FAQ チャット部分だけを切り出した、セルフホスト向けのフリー版です。静的 UI、`POST /faq-chat`、DynamoDB Local のサンプルデータ、モック評価を含みます。

このリポジトリは正本から一方向に再生成されます。更新は正本で行った後、公開同期で反映します。そのため、このリポジトリへの Pull Request を直接取り込めない場合があります。個別サポート、SLA、ロードマップ、利用者データのアップロードサービスは付属しません。

## 30分で確認する

必要なものは Node.js 22 以上、Docker Engine 24 以上または Docker Desktop 4 以上、Docker Compose v2、AWS SAM CLI、AWS CLI v2、Bash です。Windows では WSL2 から実行してください。

```bash
# GitHub の Code メニューからこの公開リポジトリを clone した後
cd <cloned-directory>
npm install
(cd lambda && npm install)

npm run faq:preflight
npm run faq:local:up
```

起動コマンドは DynamoDB Local、3テーブル、合成サンプル KB、SAM API を準備し、`http://localhost:3000` で待ち受けます。別のターミナルから確認します。

```bash
curl -s -X POST http://localhost:3000/faq-chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"営業時間を教えてください"}]}'
```

API キーを設定しなければ、外部 AI API を呼ばない決定的なキーワードモードで回答します。任意で起動前に `ANTHROPIC_API_KEY` を設定すると、簡素なグラウンディング用プロンプトで回答生成を試せます。利用料金と送信データは API 提供者の条件に従います。

静的 UI も確認する場合は API を起動したまま、別のターミナルで次を実行し、`http://localhost:8080` を開きます。

```bash
cd faq
python3 -m http.server 8080
```

終了時は API 側で `Ctrl+C` を押した後、リポジトリルートで次を実行します。

```bash
npm run faq:local:down
```

詳しいトラブルシューティングは [ローカル・クイックスタート](docs/QUICKSTART_FAQ_LOCAL.md) を参照してください。

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

`ports/` が handler と実装詳細の境界です。公開版の `adapters/production.ts` は export 名を正本と揃えた互換層です。`free` profile では free adapter と3テーブル専用の軽量 DynamoDB client を組み合わせ、`remote` profile では同じ殻の storage とガードを維持したまま RAG 処理を MIF Remote RAG API へ委譲します。

## テストとモック評価

```bash
npm test
npm run eval:mock
```

モック評価は合成された架空の質問、会話エピソード、KBだけを使い、ネットワークへ接続しません。主目的は HTTP handler、応答封筒、採点ランナーの配管確認です。実際の回答品質や検索精度を保証するものではありません。

第三者環境での動作確認記録（OS / architecture、clone から応答までの所要時間、つまずいた点）は、実測後に追記します。未計測の値を成果として扱いません。

## 既知の制約

- 検索は小規模 KB 向けの文字 bigram とキーワードだけです。埋め込み検索や高度なランキングは含みません。
- handler 内の smalltalk 分岐は正本との互換性のため残っています。free profile は `template_only` を前提とし、自由な smalltalk 生成は提供しません。
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
sam deploy --guided
```

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

#### prod candidate の side-by-side 契約

既存顧客本番と同じ AWS account に candidate を置く場合は、次の値を固定します。この契約は既存の
実デプロイ凍結を解除するものではありません。運用承認前に deploy、sync、tag を実行しないでください。

| 項目 | 固定値 |
| --- | --- |
| CloudFormation stack | `mif-faq-lite-prod-candidate` |
| `Environment` | `prod` |
| `FaqTableNamespace` | `candidate` |
| 初回 `FaqPortsProfile` | `free` |

この組合せで作る3表は `prod-candidate-Settings`、`prod-candidate-KnowledgeEntries`、
`prod-candidate-FaqQaLogs` です。既存本番の `prod-Settings`、`prod-KnowledgeEntries`、
`prod-FaqQaLogs` を import、参照、IAM Resource に指定しません。

1. **free/bootstrap**: stack 名、`Environment=prod`、`FaqTableNamespace=candidate`、
   `FaqPortsProfile=free` を明示した非対話のデプロイ入力で新規作成します。remote 用3パラメータは空のままです。
2. **Outputs と seed**: stack 作成後、caller role と3表名を Outputs から取得し、下記の完全一致検証後だけ
   candidate 表へ承認済みデータを投入します。
3. **remote 更新**: caller role の trust 登録完了後、同じ stack を `FaqPortsProfile=remote` と remote 用3値で
   更新します。`Environment=prod` と `FaqTableNamespace=candidate` は変えず、その他の既存 parameter も保持します。

Outputs は手入力の表名より優先し、次のように同じ stack から解決します。この例は標準入力や対話プロンプトを
使いません。

```bash
set -euo pipefail

STACK_NAME='mif-faq-lite-prod-candidate'
REGION='<remote-ragと同じregion>'
AWS_PROFILE_NAME='<customer-account-profile>'
EXPECTED_ACCOUNT_ID='<12-digit-customer-account-id>'

ACTUAL_ACCOUNT_ID="$(aws sts get-caller-identity \
  --region "$REGION" \
  --profile "$AWS_PROFILE_NAME" \
  --query Account \
  --output text \
  --no-cli-pager)"
if [[ ! "$EXPECTED_ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || \
   [ "$ACTUAL_ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" ]; then
  echo "AWS account mismatch: expected $EXPECTED_ACCOUNT_ID, got $ACTUAL_ACCOUNT_ID" >&2
  exit 1
fi

stack_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --profile "$AWS_PROFILE_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" \
    --output text \
    --no-cli-pager
}

FAQ_CALLER_ROLE_ARN="$(stack_output FaqChatCallerRoleArn)"
FAQ_SETTINGS_TABLE="$(stack_output FaqSettingsTableName)"
FAQ_KNOWLEDGE_TABLE="$(stack_output FaqKnowledgeEntriesTableName)"
FAQ_QA_LOGS_TABLE="$(stack_output FaqQaLogsTableName)"

if [ -z "$FAQ_CALLER_ROLE_ARN" ] || [ "$FAQ_CALLER_ROLE_ARN" = 'None' ]; then
  echo 'FaqChatCallerRoleArn output is missing' >&2
  exit 1
fi
if [ "$FAQ_SETTINGS_TABLE" != 'prod-candidate-Settings' ] || \
   [ "$FAQ_KNOWLEDGE_TABLE" != 'prod-candidate-KnowledgeEntries' ] || \
   [ "$FAQ_QA_LOGS_TABLE" != 'prod-candidate-FaqQaLogs' ]; then
  echo 'candidate table outputs do not match the deployment contract' >&2
  exit 1
fi
```

seed は低レベル DynamoDB JSON としてレビュー済みの item file を用意し、解決済みの candidate 表名を
`--table-name` に渡します。Settings には `faq_chat.enabled=true` を含む承認済み設定を1件、
KnowledgeEntries には公開を承認した `active` / `public` / default-agent の entry だけを投入します。
KnowledgeEntries のコマンドはレビュー済み item ごとに繰り返します。`FaqQaLogs` に初期 seed は不要です。

```bash
set -euo pipefail

SETTINGS_ITEM_FILE='<absolute-path-to-approved-settings-item.json>'
KNOWLEDGE_ITEM_FILE='<absolute-path-to-approved-knowledge-item.json>'

ACTUAL_ACCOUNT_ID="$(aws sts get-caller-identity \
  --region "$REGION" \
  --profile "$AWS_PROFILE_NAME" \
  --query Account \
  --output text \
  --no-cli-pager)"
if [ "$ACTUAL_ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" ]; then
  echo "AWS account mismatch before seed: expected $EXPECTED_ACCOUNT_ID, got $ACTUAL_ACCOUNT_ID" >&2
  exit 1
fi

aws dynamodb put-item \
  --table-name "$FAQ_SETTINGS_TABLE" \
  --item "file://$SETTINGS_ITEM_FILE" \
  --region "$REGION" \
  --profile "$AWS_PROFILE_NAME" \
  --no-cli-pager

aws dynamodb put-item \
  --table-name "$FAQ_KNOWLEDGE_TABLE" \
  --item "file://$KNOWLEDGE_ITEM_FILE" \
  --region "$REGION" \
  --profile "$AWS_PROFILE_NAME" \
  --no-cli-pager
```

`scripts/faq-local-seed.ts` は DynamoDB Local の `http://localhost:8000` と `dev` prefix に固定した
ローカル専用スクリプトです。AWS candidate の seed には使用しないでください。

`FaqTableNamespace` は stack 作成後に変更しません。変更すると3表すべてが replacement され、新しい空表へ
切り替わる一方、旧表は `UpdateReplacePolicy: Retain` により残ります。profile 更新では明示的に
`candidate` を維持するか、CloudFormation change set で `UsePreviousValue=true` にしてください。

cleanup では、stack を削除する**前**に上記3つの table-name Output を incident record に保存し、必要な
backup/export と削除承認を完了させます。成功済み stack を削除しても、3表は
`DeletionPolicy: RetainExceptOnCreate` により AWS account に残り、保存料金等の課金が続きます。初回 CREATE が
失敗して rollback された場合だけは `RetainExceptOnCreate` により削除されることがあります。

stack 削除後に retained table も不要なら、記録済みの3表名が上記 `prod-candidate-*` と完全一致することを
再確認してから明示削除します。stack 削除後は Outputs を取得できません。

```bash
set -euo pipefail

ACTUAL_ACCOUNT_ID="$(aws sts get-caller-identity \
  --region "$REGION" \
  --profile "$AWS_PROFILE_NAME" \
  --query Account \
  --output text \
  --no-cli-pager)"
if [ "$ACTUAL_ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" ]; then
  echo "AWS account mismatch before cleanup: expected $EXPECTED_ACCOUNT_ID, got $ACTUAL_ACCOUNT_ID" >&2
  exit 1
fi

aws cloudformation delete-stack \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --profile "$AWS_PROFILE_NAME"
aws cloudformation wait stack-delete-complete \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --profile "$AWS_PROFILE_NAME"

for table_name in \
  "$FAQ_SETTINGS_TABLE" \
  "$FAQ_KNOWLEDGE_TABLE" \
  "$FAQ_QA_LOGS_TABLE"
do
  case "$table_name" in
    prod-candidate-Settings|prod-candidate-KnowledgeEntries|prod-candidate-FaqQaLogs) ;;
    *) echo "unexpected retained table: $table_name" >&2; exit 1 ;;
  esac
  aws dynamodb delete-table \
    --table-name "$table_name" \
    --region "$REGION" \
    --profile "$AWS_PROFILE_NAME" \
    --no-cli-pager
  aws dynamodb wait table-not-exists \
    --table-name "$table_name" \
    --region "$REGION" \
    --profile "$AWS_PROFILE_NAME"
done
```

`AnthropicApiKey` を `samconfig.toml` に保存しないでください。`sam deploy --guided` の「Save arguments to configuration file」は `N` を選び、API キーは秘密管理されたデプロイ入力から都度渡してください。CloudFormation の `NoEcho` は、ローカル設定ファイルへの保存を防ぐ機能ではありません。

これはデプロイ完了を保証する本番手順ではありません。組織のセキュリティ、プライバシー、法務、可用性要件に合わせたレビューが必要です。

## ライセンス

[MIF Free Self-Hosted License](LICENSE.md)（`LicenseRef-MIF-Free-Self-Hosted-1.0`）を参照してください。一般的なオープンソースライセンスではなく、1つの組織（または個人事業主）の内部利用に限った無償セルフホスト許諾です。本ソフトウェア自体を除く自組織の商品・サービスに付随する顧客対応・情報提供として、その利用者に自組織のデプロイで FAQ を使わせること（エンドユーザーアクセス）は内部利用に含まれます。他組織への再配布、他組織向けの SaaS/ホスティング、複数顧客への代理店展開、OEM、競合提供物の基礎利用には別途商用ライセンスが必要です。正文は英語で、日本語は参考訳です。

License: MIF Free Self-Hosted License (`LicenseRef-MIF-Free-Self-Hosted-1.0`) — free for one organization (or sole proprietor) to self-host for its own internal purposes, including end-user access as customer support or information provision incidental to its own products and services other than the Software itself; redistribution to other organizations, SaaS/hosting for other organizations, multi-customer agency use, OEM, and competing offerings require a separate commercial license. See [LICENSE.md](LICENSE.md); the English text controls.
