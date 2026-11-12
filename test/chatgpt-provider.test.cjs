"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ChatGPTProvider } = require("../runtime/chatgpt-provider.cjs");

function stream(events, tail = "") {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") +
      tail,
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        // Deliberately split UTF-8 and SSE boundaries across network chunks.
        for (let i = 0; i < bytes.length; i += 7)
          controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
  );
}

test("model-only transport preserves agent instructions, tools, and structured context", async () => {
  const input = [
    { role: "user", content: "Read the current Bot state" },
    {
      type: "function_call",
      call_id: "prior-call",
      name: "read_bot",
      arguments: "{}",
    },
    {
      type: "function_call_output",
      call_id: "prior-call",
      output: '{"name":"test"}',
    },
  ];
  const tools = [
    {
      type: "namespace",
      name: "grok_bot",
      tools: [
        {
          type: "function",
          name: "read_bot",
          description: "Read Bot state",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
  ];
  const output = [
    { type: "reasoning", encrypted_content: "opaque-test-data" },
    {
      type: "function_call",
      call_id: "next-call",
      name: "read_bot",
      arguments: "{}",
    },
  ];
  const provider = new ChatGPTProvider({
    getAccessToken: async () => "test-token",
    fetch: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(options.headers.Authorization, "Bearer test-token");
      const body = JSON.parse(options.body);
      assert.deepEqual(body, {
        model: "account-model",
        instructions: "Recovered agent instructions fixture",
        input,
        tools,
        store: false,
        stream: true,
      });
      return stream([
        { type: "response.output_text.delta", delta: "Ready 🐱" },
        {
          type: "response.completed",
          response: { id: "response-test", model: "account-model", output },
        },
      ]);
    },
  });
  let delta = "";
  const response = await provider.complete({
    model: "account-model",
    instructions: "Recovered agent instructions fixture",
    input,
    tools,
    onDelta: (text) => {
      delta += text;
    },
  });
  assert.equal(delta, "Ready 🐱");
  assert.deepEqual(response.output, output);
});

test("uses the authenticated model catalog in server order", async () => {
  const provider = new ChatGPTProvider({
    getAccessToken: async () => "test-token",
    fetch: async (url) => {
      assert.equal(url, "https://api.openai.com/v1/models");
      return Response.json({
        models: [
          {
            slug: "b",
            display_name: "B",
            visibility: "list",
            context_window: 5000,
          },
          { slug: "hidden", display_name: "Hidden", visibility: "hide" },
          { slug: "a", display_name: "A", visibility: "list" },
        ],
      });
    },
  });
  assert.deepEqual(
    (await provider.models()).map((model) => model.slug),
    ["b", "a"],
  );
});

test("partial text and late usage errors cannot be reported as success", async () => {
  for (const events of [
    [{ type: "response.output_text.delta", delta: "partial" }],
    [
      { type: "response.output_text.delta", delta: "partial" },
      {
        type: "response.failed",
        response: {
          error: { code: "subscription_sharing_usage_limit_exceeded" },
        },
      },
    ],
    [
      {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "limit" } },
      },
    ],
  ]) {
    const provider = new ChatGPTProvider({
      getAccessToken: async () => "test-token",
      fetch: async () => stream(events),
    });
    await assert.rejects(
      provider.complete({ model: "test", instructions: "", input: [] }),
      /response.completed|response.failed|response.incomplete/,
    );
  }
});

test("file-input completion retains finished stream items when the final envelope omits output", async () => {
  const item = {
    id: "message",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "PDF fixture answer" }],
  };
  const done = { type: "response.output_item.done", output_index: 0, item };
  const provider = new ChatGPTProvider({
    getAccessToken: async () => "fixture",
    fetch: async () =>
      stream([
        done,
        {
          type: "response.completed",
          response: { status: "completed", output: [] },
        },
      ]),
  });
  assert.deepEqual(
    (await provider.complete({ model: "fixture", instructions: "", input: [] }))
      .output,
    [item],
  );
  provider.request = async () =>
    stream([
      done,
      {
        type: "response.failed",
        response: {
          error: { code: "subscription_sharing_usage_limit_exceeded" },
        },
      },
    ]);
  await assert.rejects(
    provider.complete({ model: "fixture", instructions: "", input: [] }),
    /response.failed/,
  );
});
