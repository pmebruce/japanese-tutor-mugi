# Mugi 私人手機版

原作：brian901106/japanese-tutor-mugi，MIT 授權。此衍生分支保留原作角色、對話、速查與小提醒本；新增手機雲端部署。

## 使用方式

- Safari／Chrome 打開自己的 Worker 網址，先使用允許的擁有者 email 登入 Cloudflare Access。
- 第一次使用輸入私人使用碼；這台瀏覽器會記住。可在設定內忘記使用碼。
- iPhone：分享 → 加入主畫面。Android：Chrome 選單 → 安裝應用程式／加入主畫面。
- 中文與日文朗讀使用裝置內建聲音，不啟用本機 VOICEVOX 或另外計費的雲端語音。
- API 文字對話另外計費，ChatGPT Plus 訂閱不抵 API 用量。

## 部署到自己的 Cloudflare

1. Workers & Pages → 建立 Worker → 連接 GitHub，選擇 `pmebruce/japanese-tutor-mugi`，生產分支務必選 `mobile-private`（手機版程式位於此分支）。
2. 建置命令：`npm run build:mobile`。部署命令：`npx wrangler deploy`。根目錄保持專案根目錄。
3. 使用 `wrangler.jsonc`：Worker 是 `mugi-mobile`，靜態資產是 `dist/`，並自動建立 SQLite Durable Object `UsageLimiter`。
4. 為這個 Worker 的正式 hostname 建立 Cloudflare Access Self-hosted application。只允許擁有者的一個 email；不要用 Everyone、Bypass 或 Service Auth 政策。登入方式可選 email 一次性驗證碼。停用預覽網址，本專案已設 `preview_urls: false`。
5. 在 Worker 的 Variables and Secrets 加入以下設定，再部署一次使設定生效：

| 名稱 | 類型 | 內容 |
|---|---|---|
| `OPENAI_API_KEY` | Secret | 此 App 專用的 API 金鑰 |
| `MUGI_ACCESS_CODE` | Secret | 自選至少 12 字、最多 64 字的私人使用碼 |
| `ACCESS_TEAM_DOMAIN` | 文字 | 自己的 `xxx.cloudflareaccess.com`，不要含 https 或路徑 |
| `ACCESS_AUD` | 文字 | Access application 的 Application Audience (AUD) tag |
| `MUGI_OWNER_EMAIL` | 文字 | 唯一允許使用的擁有者 email |
| `OPENAI_MODEL` | 文字 | 預設 `gpt-4.1-mini` |
| `MUGI_DAILY_REQUESTS` | 文字 | 預設 `100`，可設 1–1000 |

API 金鑰只能放 Secret，不能放到 `VITE_`、原始碼或 GitHub。任何設定未完成，Worker 都應保持拒絕存取，不要移除 Access 驗證。

## 建置分支排查

若日誌顯示 `Missing script: build:mobile`，先查看該筆建置的分支標籤。`main` 不包含手機版建置命令；請在「設定 → 建置」將生產分支儲存為 `mobile-private`，再由此分支的新提交觸發建置。舊的 `main` 失敗紀錄仍會保留；不要重試那筆舊紀錄，應確認新的建置標籤是 `mobile-private`。

## 驗證

```sh
npm ci
npm run build:mobile
npx vitest run worker/mobile.test.ts
npx wrangler deploy --dry-run
```

手機版有獨立 TypeScript 設定，避免原版 QA 腳本的型別錯誤阻擋部署。原版電腦開發仍可用 `npm run dev`；原本 `npm run build` 的既有 QA 型別錯誤未在此分支混改。

## 費用控制與隱私

- 同一個私人安裝共用持久化的每日請求計數，台灣時間午夜重計；每分鐘最多 12 次，單次輸出最多 1600 tokens。
- 聊天、速查、錯題判斷及提醒重寫都計次。送到上游失敗也保守計次，不會因重新部署或換手機而重置。
- 這是請求次數上限，不是固定美元花費保證；仍以 OpenAI 帳單和 Platform 的可用餘額為準。
- Worker 驗證 Access JWT 的簽章、issuer、audience、到期時間及 owner email。只有網址或偽造的身份標頭不會獲得存取。
- 聊天與圖片仍存在各裝置瀏覽器，不跨裝置同步。聊天文字會送到 OpenAI，Responses 請求設 `store: false`。
- 雲端版沒有原版的伺服器 kuromoji 補讀音；讀音由模型標示，學習時仍需核對。
- API、身份回應與 HTML 不由 service worker 快取；只有登入後取得的靜態素材可快取。離線時不能取得新的 AI 回覆。

## 本次驗證限制

建立的金鑰已能取得模型清單，但實際文字回覆測試回傳 `credit_balance_exhausted`。需要擁有者自行加值後再完成真實對話驗收。
