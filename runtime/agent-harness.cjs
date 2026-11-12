'use strict';
const { setTimeout: delay, setImmediate: yieldTurn } = require('node:timers/promises');
const { SAFE_REPLAY_TOOLS } = require('./tool-recovery.cjs');
class NeedsAttention extends Error {
  constructor() { super('The app stopped during an action whose outcome is unknown. Progress is saved. Inspect the result before asking this Bot to continue.'); this.code = 'TASK_NEEDS_ATTENTION'; }
}
class AgentHarness {
  constructor({ runtime, store, roundsPerCheckpoint = 60, retryDelays = [1000, 3000, 10000] }) {
    Object.assign(this, { runtime, store, roundsPerCheckpoint, retryDelays });
  }
  uncertain(agentId, turnId) {
    return Object.values(this.store.load(agentId).executions).filter(execution => execution.turnId === turnId && execution.status === 'started' && execution.name !== 'delegate_task' && !SAFE_REPLAY_TOOLS.has(execution.name));
  }
  async run(args) {
    let resume = !!args.resume && this.store.load(args.agent.id).turns.some(turn => turn.id === args.turnId), retries = 0;
    if (resume && this.uncertain(args.agent.id, args.turnId).length) {
      if (!args.allowUncertain) throw new NeedsAttention();
      for (const execution of this.uncertain(args.agent.id, args.turnId)) this.store.commit(args.agent.id, 'execution', { ...execution, status: 'uncertain', result: { error: 'This earlier action has an unknown outcome. The user requested continuation. Inspect current state before retrying; it has not been replayed.' } });
    }
    for (;;) {
      args.signal.throwIfAborted();
      try {
        const result = await this.runtime.run({ ...args, resume, maxRounds: this.roundsPerCheckpoint });
        if (typeof result === 'string') return result;
        if (result?.kind !== 'checkpoint') throw new Error('The agent returned an invalid checkpoint');
        resume = true; retries = 0;
        args.onActivity('Continuing the task');
        await yieldTurn();
      } catch (error) {
        if (args.signal.aborted || !error.retryable || retries >= this.retryDelays.length) throw error;
        const wait = this.retryDelays[retries++];
        args.onActivity('Reconnecting; progress is saved');
        this.store.commit(args.agent.id, 'checkpoint', { turnId: args.turnId, reason: 'network-retry', retries });
        await delay(wait, undefined, { signal: args.signal });
        resume = this.store.load(args.agent.id).turns.some(turn => turn.id === args.turnId);
      }
    }
  }
}
module.exports = { AgentHarness, NeedsAttention };
