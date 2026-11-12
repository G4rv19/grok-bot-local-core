# Grok Bot Local Core

The independently written code from Grok Bot Local. It includes an agent runtime, local conversation and memory storage, task checkpoints, scheduling, and CLI and MCP connectors. The desktop build and the vendor app are separate from this repository.

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

The macOS helper and renderer additions under `src/` are integration source. The demo has no desktop UI. The renderer additions depend on the desktop host, and the Swift helper uses macOS Accessibility and Screen Recording permissions.

## License

The project code is available under the [MIT License](LICENSE). The bundled [pstack skill pack](src/skill-packs/pstack/NOTICE.md) retains its upstream [MIT license and attribution](src/skill-packs/pstack/LICENSE).
