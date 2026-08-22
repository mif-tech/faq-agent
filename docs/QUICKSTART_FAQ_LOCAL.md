# FAQローカル・クイックスタート

この手順は、同梱の架空 KB から回答が返るところまでをローカルで確認するものです。AWS アカウントは使いません。本番デプロイや公開環境の防御を再現する手順ではありません。

## 前提条件

- Node.js 22 以上と npm
- Docker Engine 24 以上または Docker Desktop 4 以上
- Docker Compose v2
- AWS SAM CLI 1.100 以上
- AWS CLI v2
- Bash、Git、curl

Windows は WSL2 と Docker の WSL integration を利用してください。Docker Desktop の業務利用条件は所属組織で確認してください。

## 起動

GitHub の Code メニューからこの公開リポジトリを clone し、clone 先で実行します。

```bash
npm install
(cd lambda && npm install)
npm run faq:preflight
npm run faq:local:up
```

起動処理は次を順番に行います。

1. ローカル要件とポート `3000` / `8000` を確認する
2. 固定バージョンの DynamoDB Local を起動する
3. `Settings`、`KnowledgeEntries`、`FaqQaLogs` の3テーブルだけを作る
4. 架空の KB と `faq_chat.enabled=true` を投入する
5. SAM をビルドし、free profile の API を起動する

ユーザーの AWS profile は使わず、ローカル endpoint とダミー資格情報を強制します。

## 応答確認

別のターミナルで実行します。

```bash
curl -s -X POST http://localhost:3000/faq-chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"返品ポリシーを教えてください"}]}'
```

HTTP 200 の JSON と、サンプル KB に基づく本文が返れば成功です。キーなしモードは外部 AI API を呼びません。

任意で、起動前のシェルに `ANTHROPIC_API_KEY` を設定すると AI 生成を試せます。起動スクリプトは SAM 用の `lambda/env-vars.local.faq.json`（gitignore 対象・所有者限定権限）へ渡すため、使用後はそのファイルとシェル変数を削除してください。

静的 UI は別ターミナルで配信します。

```bash
cd faq
python3 -m http.server 8080
```

ブラウザで `http://localhost:8080` を開きます。

## 終了

API 側で `Ctrl+C` を押し、リポジトリルートで実行します。

```bash
npm run faq:local:down
```

## よくある問題

- `docker info` が失敗する: Docker daemon を起動し、WSL2 から接続できることを確認します。
- ポートが使用中: `3000` または `8000` を利用している別プロセスを停止します。
  - 例外: `8000` をこのプロジェクトの `dynamodb-local` コンテナが掴んでいる場合（Ctrl+C で sam local だけ止めた後の再実行）は preflight が OK 扱いにし、テーブル作成・seed は skip/上書きで続行します。
- `docker compose ps` が `unhealthy` のまま: compose の healthcheck はコンテナ内の `curl` を使うため、イメージに無い環境では表示が `unhealthy` になります。up script はホスト側から `http://localhost:8000/` へ直接疎通確認するので、起動が進めば問題ありません。
- `ResourceNotFoundException`: API を止め、`npm run faq:local:up` を最初から実行します。
- Windows で `$'\r'` エラー: shell script を LF 改行で checkout します。
- Apple Silicon で image の architecture が合わない: 必要に応じて `DOCKER_DEFAULT_PLATFORM=linux/amd64` を設定します。

ローカルデータを初期化したい場合は、終了時に volume も削除します。DynamoDB Local は in-memory 構成なので通常の終了でもデータは残りません。

```bash
npm run faq:local:down -- -v
```
