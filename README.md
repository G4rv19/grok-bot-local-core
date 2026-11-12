# Grok Bot Local Core

Grok Bot Local is a desktop assistant with local conversations, memory, task checkpoints, schedules, and CLI and MCP connectors. This repository contains the open-source Electron app and agent runtime. It runs without the vendor app.

## Run the desktop app

Use Node.js 22 or later.

```sh
git clone https://github.com/G4rv19/grok-bot-local-core.git
cd grok-bot-local-core
npm ci
npm start
```

Open **Settings** and choose **Sign in with ChatGPT**. After signing in, choose a model and send a message. To try the desktop app with a simulated model and a temporary profile, run `npm start -- --demo`.

The app has per-Bot chats and workspaces, file attachments, task and schedule controls, and a connections panel. Interactive shell and connector actions require approval. The shell runs with your account's access. For scheduled tasks, keep the app running and your computer awake.

The Electron app is intended for macOS, Windows, and Linux. The desktop workflow has been tested on Apple silicon macOS. The source launch uses npm, and this repository does not ship installers. Native mouse, keyboard, and screen control from the previous macOS build are not connected in the open-source app.

## Run the tests and command-line demo

```sh
npm run demo -- "I prefer short answers."
npm test
npm run test:desktop
```

The command-line demo runs an agent turn with a simulated model, saves a memory, and reloads it from disk. The desktop smoke test exercises the Electron window with a simulated model and a temporary profile. The runtime test suite uses Unix utilities, including `zip` and `unzip`.

## Use the runtime

- [AgentRuntime](runtime/agent-runtime.cjs) runs a turn with a model provider supplied by the caller. [AgentHarness](runtime/agent-harness.cjs) handles checkpoints, retries, and interrupted work.
- [AgentStore](runtime/agent-store.cjs) persists memory and journals. [LocalGateway](runtime/local-gateway.cjs) handles local conversations and events.
- [AgentTasks](runtime/agent-tasks.cjs) queues and resumes work. [Automations](runtime/automations.cjs) schedules one-time and recurring tasks.
- [Connectors](runtime/connectors.cjs) manages local CLI integrations and MCP sessions. [ChatGPTProvider](runtime/chatgpt-provider.cjs) implements model transport for a host that supplies a ChatGPT access token.

Start with the [demo wiring](examples/demo.cjs) to embed the runtime in a Node.js application. The tests use a small local gateway schema fixture.

The current desktop host and renderer live in `desktop/`. The Swift helper and renderer additions under `src/` are integration source from the earlier build.

## License

The project code is available under the [MIT License](LICENSE). The bundled [pstack skill pack](src/skill-packs/pstack/NOTICE.md) retains its upstream [MIT license and attribution](src/skill-packs/pstack/LICENSE).
