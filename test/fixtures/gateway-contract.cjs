'use strict';

// Exercise the local gateway's response shapes without importing a vendor schema.
const string = { type: 'string' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const object = properties => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
});
const array = items => ({ type: 'array', items });
const reply = schema => ({ reply: schema });
const agent = object({ id: string, name: string });
const transcript = array(object({ id: string, kind: string, seq: integer }));
const transcriptPage = object({ entries: transcript });
const hostSettings = object({ hasSeenOnboarding: boolean });

module.exports = {
  $defs: {},
  methods: {
    countAgents: reply(integer),
    createAgent: reply(object({ agent, transcript })),
    createAgentWorkflow: reply(array(object({ id: string, name: string, body: string }))),
    getAgentAutomations: reply(array(object({
      id: string,
      schedule: string,
      isEnabled: boolean,
    }))),
    getAgentChannels: reply(array(string)),
    getAgentTranscript: reply(transcript),
    getAgentTranscriptWindow: reply(transcriptPage),
    getHostSettings: reply(hostSettings),
    getHostStatus: reply(object({ hostVersion: string, isBusy: boolean })),
    getMcpState: reply(object({})),
    listAgents: reply(array(agent)),
    openAgentTail: reply(transcriptPage),
    promptAcceptanceStatus: reply(object({ outcome: { const: 'found' } })),
    readAttachmentChunk: reply(object({ bytesBase64: string, totalSize: integer })),
    readAttachmentImage: reply(object({ dataUrl: string })),
    readAttachmentText: reply(object({ kind: { const: 'text' }, text: string })),
    sendPrompt: reply(object({ accepted: { const: true } })),
    setHostSettings: reply(hostSettings),
    uploadAttachmentChunk: reply(object({ committedPath: string })),
  },
  events: {
    'agent-activity': object({
      agentId: string,
      live: object({ isRunning: boolean, isComposingMessage: boolean }),
    }),
    'agent-upserted': object({ agent }),
    agents: object({ agents: array(agent) }),
    transcript: object({ type: string }),
  },
};
