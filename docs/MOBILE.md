# Mugi 私人手機版

原作：brian901106/japanese-tutor-mugi，MIT 授權。此衍生分支保留原作角色、對話、速查與小提醒本；新增手機雲端部署。

## 使用方式

- Safari／Chrome 打開自己的 Worker 網址，輸入私人密碼。無須開通 Cloudflare Zero Trust。
- 登入保留 30 天，密碼不存進 localStorage；使用 Secure、HttpOnly、SameSite=Strict 的簽章 Cookie。可在設定登出這台裝置。
- iPhone：分享 → 加入主畫面。Android：Chrome 選單 → 安裝應用程式／加入主畫面。
- 中文與日文朗讀使用裝置內建聲音，不啟用本機 VOICEVOX 或另外計費的雲端語音。
- API 文字對話另外計費，ChatGPT Plus 訂閱不抵 API 用量。

## 部署到自己的 Cloudflare

1. Workers & Pages → 建立 Worker → 連接 GitHub，選擇 `pmebruce/japanese-tutor-mugi`，生產分支務必選 `mobile-private`。
2. 建置命令：`npm run build:mobile`。部署命令：`npx wrangler deploy`。根目錄保持專案根目錄。
3. 使用 `wrangler.jsonc`：Worker 是 `mugi-mobile`，靜態資產是 `dist/`，並自動建立 SQLite Durable Object `UsageLimiter`。
4. 啟用正式 workers.dev 網址。不需要 Zero Trust、Access application 或 Access 相關變數。預覽網址已由 `preview_urls: false` 停用。
5. 在 Worker 的 Variables and Secrets 加入以下設定，再部署一次使設定生效：

| 名稱 | 類型 | 內容 |
|---|---|---|
| `OPENAI_API_KEY` | Secret | 此 App 專用的 API 金鑰 |
| `MUGI_ACCESS_CODE` | Secret | 至少 16 字、最多 128 字的私人密碼，建議密碼管理器產生至少 20 字隨機密碼 |
| `OPENAI_MODEL` | 文字 | 預設 `gpt-4.1-mini` |
| `MUGI_DAILY_REQUESTS` | 文字 | 預設 `100`，可設 1–1000 |

API 金鑰只能放 Secret，不能放到 `VITE_`、原始碼或 GitHub。私人密碼未設定時，Worker 保持拒絕存取。沒有登入時只提供密碼表單，不開放 App、靜態資產或 API；即使知道網址也需要密碼。知道密碼的人都能登入，請勿分享。

## 建置分支排查

若顯示 `Missing script: build:mobile`，確認生產分支已儲存為 `mobile-private`，由該分支的新提交觸發建置。不要重試舊 `main` 失敗紀錄；新建置的標籤應是 `mobile-private`。

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
- Worker 驗證登入 Cookie 的簽章、來源網址與有效期；不接受舊配對標頭或偽造的 Access 身份標頭。
- 登入嘗試持久化限速：每個來源 IP 每 15 分鐘最多 8 次、整個安裝最多 60 次。成功與失敗嘗試皆計數。
- 在 Cloudflare 更改 `MUGI_ACCESS_CODE` 並重新部署後，所有舊登入立即失效。一般登出只清除此裝置 Cookie；遺失裝置時請更換密碼。
- 聊天與圖片仍存在各裝置瀏覽器，不跨裝置同步。聊天文字會送到 OpenAI，Responses 請求設 `store: false`。
- 雲端版沒有原版的伺服器 kuromoji 補讀音；讀音由模型標示，學習時仍需核對。
- API、身份回應與 HTML 不由 service worker 快取；只有登入後取得的靜態素材可快取。離線時不能取得新的 AI 回覆。

## 本次驗證限制

建立的金鑰已能取得模型清單，但實際文字回覆測試回傳 `credit_balance_exhausted`。需要擁有者自行加值後再完成真實對話驗收。
