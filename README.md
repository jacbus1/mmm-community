# MMM Community

A local-first workbench for multi-model collaboration, design, and human review.

**Community beta | MIT | Node.js 24+ | English / 繁體中文 / 简体中文**

**Supported beta platforms: macOS and Linux (browser mode). Native Windows is
not supported yet**: the initial hosted run exposed filesystem permission,
open-file and migration differences. Do not rely on this beta for Windows data.
The optional native CLI bridge is macOS-only; Linux browser/API work is separate.

Think together. Design deliberately. Keep the work yours.

This standalone source edition reuses the older MMM public-app baseline, not
the private application or its Git history. It contains **no Antigravity
integration** and requires no MMM account. The original private repository
has not been made public by this edition.

Community repository: [jacbus1/mmm-community](https://github.com/jacbus1/mmm-community).

## Quick start

Install Node.js 24 or newer, then clone this repository:

```sh
git clone https://github.com/jacbus1/mmm-community.git
cd mmm-community
node --version
npm start
```

Alternatively, download and extract a source archive from
[Releases](https://github.com/jacbus1/mmm-community/releases), open its directory,
and run `npm start`.

Open the **complete local URL printed in your terminal**, including its session
fragment. The fragment is a local access credential: never share it or put it in
screenshots. The server chooses an available loopback port. Stop with `Ctrl+C`.
No npm dependencies or API keys are needed for local work.

1. Create a project and save a note or local task.
2. Optionally open **Settings & services**, supply your provider, model ID and key.
3. Open the project's **Team** view and choose **Use the design team**.
4. Assign a configured service to each role and save. Reusing one model for
   all roles is allowed; multiple providers are optional.
5. In **AI task**, select team discussion and confirm content sharing.
6. Review the artifact and enter acceptance evidence before approving completion.

Provider requests can incur charges. Saving a provider or team does not start
work. The optional connection test makes a small, explicitly confirmed call.
Use a currently available model ID from your own provider account.

## What works

| Capability | Source browser edition |
| --- | --- |
| Local projects, notes, tasks, artifacts, review evidence | Available, no AI required |
| Archive and restore projects | Available |
| JSON import and Markdown task exchange | Available; Markdown is not a full backup |
| Provider API and loopback-compatible local models | Explicit consent required |
| Multi-model discussion | 1-8 members, 1-3 rounds, coordinator synthesis |
| Design team preset | Coordinator, UI/UX designer, engineer, reviewer |
| English, Traditional and Simplified Chinese | Available |
| Browser key storage | In memory only; re-enter after server restart |
| Files/folders, OS-encrypted keys, manual CLI launch | Optional Electron bridge, not browser mode |
| Autonomous code execution, browser/CLI workers | Not implemented |
| Cloud hosting, shared multi-user access | Not supported |
| Signed desktop installer | Not included |

The design preset is a team configuration, not a Figma connector or automatic
website builder. Agents discuss text; they do not edit files or execute shell
commands. Gateway model identities are deliberately allowlisted in
`provider-policy.cjs`; arbitrary model IDs may be rejected. Provider plans,
quotas and model weights are not bundled.

## Privacy and storage

The service binds to `127.0.0.1`, authenticates each launch and checks request
origins. Do not expose it through public proxies or tunnels. There is no MMM
telemetry or automatic personal-account import.

| Platform | Separate Community data directory |
| --- | --- |
| macOS | `~/Library/Application Support/MMM-Community` |
| Linux | `$XDG_DATA_HOME/MMM-Community` or `~/.local/share/MMM-Community` |
| Windows (unsupported) | Reserved: `%LOCALAPPDATA%\MMM-Community` |

Project data is not encrypted at rest; use OS disk encryption. Browser-mode
provider keys live only in server memory. Explicit AI tasks send selected text
to the chosen provider. Teams share the brief and prior discussion with their
participating providers. Only public/non-sensitive inputs are accepted;
content detection is best-effort, not a guarantee. Keep secrets out of prompts.

Back up by stopping the app and copying its complete data directory into your
own secure backup. Markdown exchange is task metadata, not a substitute.
Never commit runtime data or keys.

## Development

```sh
npm test
npm run release:source
```

Tests use temporary stores and mock providers, not billable calls. Source
packaging uses an explicit allowlist, runtime scan, pinned logo and SHA-256
manifest. It requires the system `tar` command and creates a `.tar.gz` and
checksum in `dist/`. Tests and documentation are included; Git history,
credentials and runtime data are not. `private: true` in package.json prevents
accidental npm publishing, not MIT source redistribution.

The optional Electron bridge remains for contributors. Electron is neither
installed nor bundled here; desktop builds, signing and native verification
remain separate release work.

See [Design](docs/DESIGN.md), [Architecture](docs/ARCHITECTURE.md),
[Roadmap](docs/ROADMAP.md), [Contributing](CONTRIBUTING.md), and
[Security](SECURITY.md).

## 中文快速開始

這是從舊 MMM 整理的獨立社群版，並非把私人 GitHub 專案直接公開。
不包含 Antigravity，也不會複製原本的帳戶、金鑰或專案資料。

安裝 Node.js 24 或更新版本，在專案目錄執行 `npm start`，開啟終端機
顯示的完整本機網址。無須註冊或 API Key，即可建立專案、筆記及本機任務。
需要 AI 時才自行設定服務及模型，費用由你的供應商帳戶承擔。

「團隊」頁可套用協調者、UI/UX 設計師、工程師及審核者。先為角色選擇
服務並儲存，再明確提交任務。這是多角色文字協作，不是自動寫程式或操作
電腦。瀏覽器模式的 Key 不會永久保存，重啟後須重新輸入。

這是獨立公開 repo 的原始碼測試版，不含已簽署桌面安裝包；原本私人 repo 維持不變。
目前支援 macOS／Linux 的瀏覽器模式，原生 Windows 因權限及資料遷移相容問題暫不支援。

## License

[MIT](LICENSE.txt). Provider services, model weights, external CLIs and Electron
have their own licenses and terms; they are not distributed here.
