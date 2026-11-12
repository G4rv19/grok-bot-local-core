# Grok Bot Local Core

Grok Bot Local uses the original Grok Bot desktop interface with a local backend for conversations, memory, tasks, schedules, and connections. This repository includes the local backend and the build scripts and patches needed to assemble the desktop app from an installed copy of Grok Bot.

## Build the original desktop interface

Use an Apple silicon Mac with macOS 14 or later, Xcode Command Line Tools, Python 3, Node.js 22 or later, and Homebrew's `ripgrep` installed at `/opt/homebrew/bin/rg`. Install the original Apple silicon build of Grok Bot **0.79.3** at `/Applications/Grok Bot.app`. If yours is in a different folder, set `GROK_SOURCE_APP` to its absolute path.

```sh
git clone https://github.com/G4rv19/grok-bot-local-core.git
cd grok-bot-local-core
npm ci --ignore-scripts
npm run build:desktop
npm run verify:desktop
open 'build/Grok Bot Local.app'
```

The build checks the installed version, extracts its interface and resources locally, applies the local backend integration, and signs a separate app bundle. The generated app and extracted files stay in `build/`. If Grok Bot asks to move to Applications, choose **Not Now** to try the build in place. When switching between copies of **Grok Bot Local**, quit the running copy before opening another.

Use **Settings → Computer** to sign in with ChatGPT and choose a model. macOS Accessibility and Screen Recording permissions are needed for Mac control. By default, the desktop build uses `~/Library/Application Support/Grok Bot Local/` for local data. To launch with a separate profile, set `GROK_LOCAL_DATA_DIR` to an absolute directory path and run the bundle's executable directly.

## Run the demo

Use Node.js 22 or later.

```sh
git clone https://github.com/G4rv19/grok-bot-local-core.git
cd grok-bot-local-core
npm ci
npm run demo -- "I prefer short answers."
npm test
```

The demo runs one agent turn with a simulated model, saves a memory, and reloads it from disk. It uses a temporary directory and requires no API key, network access after installation, or Grok Bot installation. The full test suite uses Unix utilities, including `zip` and `unzip`.

## Use the runtime

- [AgentRuntime](runtime/agent-runtime.cjs) runs a turn with a model provider supplied by the caller. [AgentHarness](runtime/agent-harness.cjs) handles checkpoints, retries, and interrupted work.
- [AgentStore](runtime/agent-store.cjs) persists memory and journals. [LocalGateway](runtime/local-gateway.cjs) handles local conversations and events.
- [AgentTasks](runtime/agent-tasks.cjs) queues and resumes work. [Automations](runtime/automations.cjs) schedules one-time and recurring tasks.
- [Connectors](runtime/connectors.cjs) manages local CLI integrations and MCP sessions. [ChatGPTProvider](runtime/chatgpt-provider.cjs) implements model transport for a host that supplies a ChatGPT access token.

Start with the [demo wiring](examples/demo.cjs) to embed the runtime in a Node.js application. The tests use a small local gateway schema fixture.

The macOS helper and renderer additions under `src/` are compiled or copied into the desktop build. The command-line demo runs independently of the desktop build.

## License

The project code is available under the [MIT License](LICENSE). The bundled [pstack skill pack](src/skill-packs/pstack/NOTICE.md) retains its upstream [MIT license and attribution](src/skill-packs/pstack/LICENSE). The original Grok Bot app and its extracted files are covered by their own terms.
