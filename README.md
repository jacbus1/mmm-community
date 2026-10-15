# MMM Community

A local-first workbench for multi-model collaboration, design, and human review.

**English** · [繁體中文](README.zh-Hant.md) · [简体中文](README.zh-Hans.md)

**Start here:** [Step-by-step tutorial](docs/TUTORIAL.md) — local tasks first, then optional AI and team discussion.

**Community beta | MIT | Node.js 24+**

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

![MMM Community home screen, English](docs/screenshots/home.png)

## Screenshots

These are captures of this Community edition using a disposable local project.
The example has no connected AI provider and no AI task was run.

**Project workspace:** a synthetic community-library note saved locally.

![A local project conversation with a synthetic community-library note](docs/screenshots/project-workspace.png)

**Design team draft:** four roles with AI services still unconfigured.

![Four-role design team draft, with AI services unconfigured](docs/screenshots/design-team.png)

The design-team screenshot shows a **draft**, not completed agent work. No
personal accounts, credentials or session URL appear in these images.

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

## License

[MIT](LICENSE.txt). Provider services, model weights, external CLIs and Electron
have their own licenses and terms; they are not distributed here.
