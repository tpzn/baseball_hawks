# baseball-hawks (Cloudflare Workers + D1 + R2)

`index.html` を Cloudflare Workers で自前ホストし、ベーシック認証をかける構成です。

## セットアップ
1. 前提: Node 22、`npx wrangler login`
2. `npm i`
3. `npx wrangler d1 create baseball-hawks` を実行し、出力の `database_id` を `wrangler.jsonc` に書く
4. `npx wrangler r2 bucket create baseball-hawks-videos`
5. `npm run db:init`（`wrangler d1 execute baseball-hawks --remote --file=schema.sql`）
6. `npx wrangler secret put BASIC_USER` / `npx wrangler secret put BASIC_PASS`
7. `npm run deploy`（アプリ本体は `public/index.html`） → `https://baseball-hawks.<account>.workers.dev`
8. ローカル: `.dev.vars.example` を `.dev.vars` にコピーして編集し、`npm run db:init:local` のあと `npm run dev`
9. データ移行: `node scripts/import.mjs https://... user pass export.json`
10. R2 の容量と費用の目安: 無料枠 10GB、以降 $0.015/GB/月、下り（egress）無料。アプリ側の上限は 9GB / 10,000 ファイル、1 本 60MiB まで。

## API（すべて Basic 認証）
- `GET /api/all` / `GET /api/:col` / `PUT|DELETE|GET /api/:col/:id`
- `POST /api/blob`（生バイト, Content-Type: video/mp4 等）/ `GET /api/blob` / `DELETE /api/blob/:id`
- `GET /_blob/:id`（Range 対応）

## クライアント
`client/rest-backend.js` は `public/index.html` に組み込み済みのアダプタの原本です。`init()` が claude.ai 上なら Artifact の db、自前サーバーなら REST、それ以外は端末内保存を選びます。
