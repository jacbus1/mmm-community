# MMM Community

一個以本機資料為中心的工作台，讓你組織多模型討論、設計工作與人工驗收。

[English](README.md) · **繁體中文** · [简体中文](README.zh-Hans.md)

**社群測試版 | MIT | Node.js 24+**

**目前支援 macOS 和 Linux 的瀏覽器模式，暫不支援原生 Windows。**初步託管測試發現 Windows 的檔案權限、開啟檔案及資料遷移行為有差異，請勿依賴此測試版儲存 Windows 資料。可選的原生 CLI 橋接只支援 macOS；Linux 的瀏覽器與 API 功能另行運作。

一起思考，審慎設計，工作由你掌握。

這份獨立原始碼版本以較早期的 MMM 公開應用為基礎，並非把私人應用或其 Git 歷史公開。它**不包含 Antigravity 整合**，也無須 MMM 帳戶；原本的私人 repository 沒有因此公開。

社群專案：[jacbus1/mmm-community](https://github.com/jacbus1/mmm-community)。

![MMM Community 英文首頁](docs/screenshots/home.png)

## 系統截圖

圖片取自此社群版的真實介面，使用一次性的本機示例專案；沒有連接 AI 服務，也沒有執行 AI 任務。

**專案工作區：** 儲存在本機的合成社區圖書館筆記。

![合成社區圖書館筆記及本機專案對話](docs/screenshots/project-workspace.png)

**設計團隊草稿：** 四個角色，尚未設定 AI 服務。

![四角色設計團隊草稿，尚未設定 AI 服務](docs/screenshots/design-team.png)

團隊圖片展示的是**尚未儲存或執行的草稿**，不是代理完成工作的紀錄。圖片沒有個人帳戶、憑證或本機 session 網址。

## 快速開始

安裝 Node.js 24 或更新版本，然後複製專案：

```sh
git clone https://github.com/jacbus1/mmm-community.git
cd mmm-community
node --version
npm start
```

你也可以從 [Releases](https://github.com/jacbus1/mmm-community/releases) 下載原始碼封存檔、解壓後在目錄內執行 `npm start`。

開啟終端機印出的**完整本機網址**，包括 session 片段。該片段是本機存取憑證，切勿分享或放進截圖。伺服器會選用可用的 loopback 連接埠；按 `Ctrl+C` 停止。建立本機工作不需要 npm 套件依賴或 API Key。

1. 建立專案，儲存筆記或本機任務。
2. 如需 AI，到「設定與服務」填入供應商、模型 ID 及金鑰。
3. 在專案的「團隊」頁選擇「使用設計團隊」。
4. 為每個角色選擇已設定的服務並儲存。各角色可以重用同一模型；多個供應商並非必要。
5. 在「AI 任務」選擇團隊討論，並明確同意分享內容。
6. 檢查成果及填寫驗收證據，再決定是否批准完成。

供應商請求可能收費。儲存服務或團隊設定不會開始執行；可選的連接測試會在你明確確認後發出少量請求。請使用你自己供應商帳戶目前可用的模型 ID。

## 現有功能與限制

| 功能 | 原始碼瀏覽器版本 |
| --- | --- |
| 本機專案、筆記、任務、成果及驗收證據 | 可用，毋須 AI |
| 封存及還原專案 | 可用 |
| JSON 匯入及 Markdown 任務交換 | 可用；Markdown 並非完整備份 |
| 供應商 API 及 loopback 相容本機模型 | 需要明確同意 |
| 多模型討論 | 1–8 位成員、1–3 輪、協調者整合 |
| 設計團隊預設角色 | 協調者、UI/UX 設計師、工程師、審核者 |
| 英文、繁體及簡體中文介面 | 可用 |
| 瀏覽器模式的金鑰 | 只存於記憶體；伺服器重啟後須重新輸入 |
| 檔案／資料夾、系統加密金鑰、手動啟動 CLI | 可選 Electron 橋接，不屬於瀏覽器模式 |
| 自主寫程式、瀏覽器或 CLI 代理 | 尚未實作 |
| 雲端託管、多人共用 | 不支援 |
| 已簽署桌面安裝程式 | 未提供 |

設計團隊預設值只是團隊設定，不是 Figma 連接器或自動網站建構器。代理進行文字討論，不會編輯檔案或執行 shell 指令。Gateway 模型身分受 `provider-policy.cjs` 許可清單限制，任意模型 ID 可能被拒絕。此專案不包含供應商方案、額度或模型權重。

## 私隱與儲存

服務綁定 `127.0.0.1`，每次啟動都驗證 session，並檢查請求來源。不要透過公開代理或通道對外開放。MMM 不會收集遙測，也不會自動匯入個人帳戶資料。

| 平台 | 獨立的 Community 資料目錄 |
| --- | --- |
| macOS | `~/Library/Application Support/MMM-Community` |
| Linux | `$XDG_DATA_HOME/MMM-Community` 或 `~/.local/share/MMM-Community` |
| Windows（不支援） | 預留：`%LOCALAPPDATA%\MMM-Community` |

專案資料在磁碟上並未加密，請使用作業系統磁碟加密。瀏覽器模式的供應商金鑰只存在伺服器記憶體。明確提交的 AI 任務會把所選文字送給指定供應商；團隊討論會向參與的供應商分享簡報及先前回覆。此測試版只接受公開、非敏感輸入；內容偵測只是盡力而為，並非保證。請勿在提示中放入秘密。

備份時先停止程式，再把完整資料目錄複製到自己的安全備份位置。Markdown 交換只包含任務中繼資料，不能取代完整備份。切勿把執行資料或金鑰提交到 Git。

## 開發

```sh
npm test
npm run release:source
```

測試使用暫存資料與模擬供應商，不會產生付費呼叫。原始碼封裝使用明確檔案清單、執行內容掃描、固定 logo 雜湊與 SHA-256 清單；需要系統 `tar`，並在 `dist/` 產生 `.tar.gz` 和校驗檔。封裝包含測試與文件，不包含 Git 歷史、憑證或執行資料。`package.json` 的 `private: true` 防止意外發布至 npm，不限制 MIT 原始碼再散布。

可選 Electron 橋接供貢獻者使用，但此處沒有安裝或捆綁 Electron。桌面建構、簽署及原生端到端驗證仍是獨立的發行工作。

參閱 [設計](docs/DESIGN.md)、[架構](docs/ARCHITECTURE.md)、[路線圖](docs/ROADMAP.md)、[貢獻指南](CONTRIBUTING.md)及[安全政策](SECURITY.md)。這些深入文件目前以英文撰寫。

## 授權

[MIT](LICENSE.txt)。供應商服務、模型權重、外部 CLI 及 Electron 有各自的授權與條款，不隨本專案發行。
