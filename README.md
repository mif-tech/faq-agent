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

`ports/` が handler と実装詳細の境界です。公開版の `adapters/production.ts` は export 名を正本と揃えた互換層で、中身は free adapter と3テーブル専用の軽量 DynamoDB client を組み合わせます。

## テストとモック評価

```bash
npm test
npm run eval:mock
```

モック評価は合成された架空の質問、会話エピソード、KBだけを使い、ネットワークへ接続しません。主目的は HTTP handler、応答封筒、採点ランナーの配管確認です。実際の回答品質や検索精度を保証するものではありません。

### 3名確認の記録

次の表は実測値を人が記入するためのプレースホルダーです。未計測値を成果として扱わないでください。

| 確認者 | OS / architecture | cloneから応答まで | 結果・つまずき |
| --- | --- | --- | --- |
| 1 | 未記入 | 未記入 | 未記入 |
| 2 | 未記入 | 未記入 | 未記入 |
| 3 | 未記入 | 未記入 | 未記入 |

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

`AnthropicApiKey` を `samconfig.toml` に保存しないでください。`sam deploy --guided` の「Save arguments to configuration file」は `N` を選び、API キーは秘密管理されたデプロイ入力から都度渡してください。CloudFormation の `NoEcho` は、ローカル設定ファイルへの保存を防ぐ機能ではありません。

これはデプロイ完了を保証する本番手順ではありません。組織のセキュリティ、プライバシー、法務、可用性要件に合わせたレビューが必要です。

## ライセンス

[MIF Free Self-Hosted License](LICENSE.md) を参照してください。現在の文面は **DRAFT（弁護士確認前）** です。一般的なオープンソースライセンスではなく、再配布、OEM、第三者向けホスティング等に制限があります。
