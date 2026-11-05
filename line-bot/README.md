# 工作室 LINE 預約小幫手

客人在 LINE 上可以：

- 按「查空檔」→ 選日期 → 選時段 → 拿到「諮詢預約」頁面連結完成預約
- 直接打字問（例如「下週三下午有空嗎？」），由 Claude 查空檔後回答

預約一律在 Google「諮詢預約」頁面完成，確認信與防撞期由 Google 處理。
機器人只讀得到「忙／空」，看不到行程內容，也不能改行事曆。

## 一、建立 LINE 官方帳號與 Messaging API

1. 到 LINE Official Account Manager（manager.line.biz）建立官方帳號。
2. 「設定 → Messaging API」→ 啟用，選一個 Provider。
3. 到 LINE Developers Console（developers.line.biz）打開這個 channel：
   - 「Messaging API」分頁最下方 → **Channel access token** 按 Issue，複製起來。
4. 回 Official Account Manager →「設定 → 回應設定」：
   - 關閉「自動回應訊息」、開啟「Webhook」。

## 二、建立 Apps Script

1. 到 script.google.com →「新專案」，命名「工作室 LINE 預約」。
2. 左側「專案設定」→ 勾選「在編輯器中顯示 appsscript.json」。
3. 把本資料夾的 `appsscript.json`、`Code.gs` 內容分別貼進同名檔案。
4. 修改 `Code.gs` 最上面的 `CONFIG`：
   - `BOOKING_URL`：「諮詢預約」的預約頁網址（Google 日曆 → 點預約時段 → 開啟預約頁面 → 複製網址）
   - `OPEN_HOURS`：跟「諮詢預約」設定的可預約時段一致
5. 「專案設定 → 指令碼屬性」新增：
   - `LINE_CHANNEL_ACCESS_TOKEN` = 第一步複製的 token
   - `ANTHROPIC_API_KEY` = Claude API 金鑰（console.anthropic.com 申請，按用量付費，與 Claude 訂閱分開）
6. 選函式 `testFreeSlots` 按「執行」→ 授權 → 看執行記錄有沒有列出空檔。
7. 選 `testAi` 執行，確認 AI 回答正常。

## 三、部署並接到 LINE

1. 右上「部署 → 新增部署作業」→ 類型「網頁應用程式」
   - 執行身分：我
   - 存取權：所有人
2. 複製「網頁應用程式網址」。
3. LINE Developers Console →「Messaging API」→ Webhook URL 貼上 → 開啟「Use webhook」。
   - 按「Verify」可能顯示錯誤（Apps Script 會轉址），可忽略，直接用手機加好友傳訊息測試。
4. 之後改了程式碼要「部署 → 管理部署作業 → 編輯 → 版本選『新版本』」才會生效，網址不變。

## 建議：圖文選單

在 Official Account Manager →「圖文選單」做兩個按鈕：
「查空檔」（動作：文字 `查空檔`）和「預約頁面」（動作：連結 = 預約頁網址）。

## 費用與安全

- Apps Script、LINE 回覆訊息：免費。
- Claude API：預設用 Claude Opus 5.5（效果最好）。想省錢可把 `CONFIG.MODEL` 改成 `claude-haiku-5-5`，單價便宜很多。
- 有開啟 refusal fallback：模型婉拒時，API 會自動換模型重試。
- 為了避免被灌訊息燒錢，AI 回答每人每小時 20 次、全部每天 300 次，超過就只提供按鈕。可在 `CONFIG` 調整。
- Apps Script 讀不到 LINE 的簽章標頭，無法驗證請求真的來自 LINE；上面的次數限制就是主要防護。
