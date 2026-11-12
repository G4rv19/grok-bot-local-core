'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { AgentHarness } = require('../runtime/agent-harness.cjs');
const { AgentRuntime } = require('../runtime/agent-runtime.cjs');
const { AgentSkills } = require('../runtime/agent-skills.cjs');
const { AgentStore } = require('../runtime/agent-store.cjs');
const { LocalGateway } = require('../runtime/local-gateway.cjs');

async function main(prompt) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-core-demo-'));
  const store = new AgentStore(dataDir);
  const skills = new AgentSkills(store);
  const gateway = new LocalGateway({
    dataDir,
    contract: { methods: {} },
    runModel: args => harness.run(args),
  });
  const runtime = new AgentRuntime({
    gateway,
    store,
    skills,
    provider: {
      async complete({ input }) {
        if (!input.some(item => item.type === 'function_call_output')) {
          return { output: [{
            type: 'function_call',
            namespace: 'grok_bot',
            name: 'remember',
            call_id: 'demo-memory',
            arguments: JSON.stringify({ id: 'demo', text: prompt }),
          }] };
        }
        return { output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Saved the demo memory.' }],
        }] };
      },
    },
    nativeTools: { catalog: [], images: () => [] },
    getPermission: () => 'never',
    getModel: () => 'demo',
    modelCatalog: async () => [{ slug: 'demo', context_window: 100000 }],
  });
  const harness = new AgentHarness({ runtime, store });
  gateway.contextStore = store;
  gateway.skills = skills;

  try {
    const { agent } = gateway.create({ name: 'Demo' });
    await gateway.send({ agentId: agent.id, prompt });
    const deadline = AbortSignal.timeout(5000);
    while (gateway.jobs.has(agent.id)) await delay(10, undefined, { signal: deadline });
    const memory = new AgentStore(dataDir).load(agent.id).memories.find(item => item.id === 'demo');
    if (!memory || agent.lastTurnSettlement?.outcome !== 'success') {
      throw new Error(gateway.entries(agent.id).at(-1)?.content || 'Demo turn failed');
    }
    console.log(gateway.entries(agent.id).at(-1).content);
    console.log('Reloaded memory:', memory.text);
  } finally {
    gateway.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main(process.argv.slice(2).join(' ') || 'I prefer short answers.').catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
