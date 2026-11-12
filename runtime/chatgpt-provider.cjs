"use strict";

// Model transport only. The caller supplies Grok Bot's instructions, context,
// tools, and selected model. This module never starts Codex or loads plugins.
const API = "https://api.openai.com/v1";

class ChatGPTProvider {
  constructor({ getAccessToken, fetch: request = globalThis.fetch }) {
    this.getAccessToken = getAccessToken;
    this.request = request;
  }
  async call(route, options = {}) {
    const token = await this.getAccessToken();
    if (typeof token !== "string" || !token)
      throw new Error("Continue with ChatGPT to connect this app");
    let response;
    try {
      response = await this.request(API + route, {
        ...options,
        redirect: "error",
        headers: { ...options.headers, Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      if (
        !options.signal?.aborted ||
        options.signal.reason?.name === "TimeoutError"
      )
        error.retryable = true;
      throw error;
    }
    // Do not log provider bodies, credentials, or authorization URLs.
    if (!response.ok) {
      let code;
      try {
        code = (await response.json()).error?.code;
      } catch {}
      const error = new Error(
        `ChatGPT request failed (HTTP ${response.status}${typeof code === "string" && /^[a-z0-9_]{1,100}$/i.test(code) ? `, ${code}` : ""})`,
      );
      error.retryable = response.status >= 500 || response.status === 408;
      throw error;
    }
    return response;
  }
  async models({ signal } = {}) {
    const response = await this.call("/models", { signal });
    const body = await response.json();
    if (!Array.isArray(body.models))
      throw new Error("ChatGPT returned an invalid model catalog");
    const visible = body.models.filter((model) => model?.visibility === "list");
    if (
      !visible.every(
        (model) =>
          typeof model.slug === "string" &&
          model.slug.length > 0 &&
          typeof model.display_name === "string",
      )
    ) {
      throw new Error("ChatGPT returned an invalid model catalog");
    }
    // Preserve account-specific order and metadata, including context windows.
    return visible;
  }
  async complete({
    model,
    instructions,
    input,
    tools,
    signal,
    onDelta = () => {},
  }) {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(600000)])
      : AbortSignal.timeout(600000);
    try {
      return await this.completeOnce({
        model,
        instructions,
        input,
        tools,
        signal: requestSignal,
        onDelta,
      });
    } catch (error) {
      if (
        !signal?.aborted &&
        (requestSignal.reason?.name === "TimeoutError" ||
          (error instanceof TypeError &&
            /fetch|terminated|network/i.test(error.message)))
      )
        error.retryable = true;
      throw error;
    }
  }
  async completeOnce({ model, instructions, input, tools, signal, onDelta }) {
    if (typeof model !== "string" || !model)
      throw new Error("Choose a model in settings");
    if (typeof instructions !== "string" || !Array.isArray(input))
      throw new Error(
        "The agent must supply its instructions and structured context",
      );
    const response = await this.call("/responses", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model,
        instructions,
        input,
        ...(tools === undefined ? {} : { tools }),
        store: false,
        stream: true,
      }),
    });
    if (!response.body)
      throw new Error("ChatGPT did not return a response stream");
    let completed;
    const finishedItems = new Map();
    for await (const event of readEvents(response.body)) {
      signal?.throwIfAborted();
      switch (event.type) {
        case "response.output_item.done":
          if (
            Number.isSafeInteger(event.output_index) &&
            event.output_index >= 0 &&
            event.item &&
            typeof event.item.type === "string"
          )
            finishedItems.set(event.output_index, event.item);
          break;
        case "response.output_text.delta":
          if (typeof event.delta === "string") onDelta(event.delta);
          break;
        case "response.completed":
          if (!event.response || !Array.isArray(event.response.output))
            throw new Error("ChatGPT returned an invalid completed response");
          completed = event.response;
          break;
        case "error":
        case "response.failed":
        case "response.incomplete": {
          const code =
            event.response?.error?.code ??
            event.error?.code ??
            event.code ??
            event.response?.incomplete_details?.reason;
          const error = new Error(
            `ChatGPT ${event.type}${typeof code === "string" && /^[a-z0-9_]{1,100}$/i.test(code) ? `: ${code}` : ""}`,
          );
          error.retryable = ["server_error", "internal_error"].includes(code);
          throw error;
        }
      }
    }
    if (!completed)
      throw new Error("ChatGPT stream ended before response.completed");
    // File-input responses can omit output from the final envelope while
    // delivering fully completed items in the stream. Never reconstruct from
    // partial deltas, and still require the successful terminal event above.
    if (!completed.output.length && finishedItems.size)
      completed = {
        ...completed,
        output: [...finishedItems]
          .sort(([a], [b]) => a - b)
          .map(([, item]) => item),
      };
    // Return every structured output item. The Grok Bot runtime must execute
    // function calls and retain reasoning/tool items in its own context store.
    return completed;
  }
}

async function* readEvents(body) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(pending);
      if (!boundary) break;
      const frame = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data || data === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        throw new Error("ChatGPT returned malformed stream data");
      }
      if (!event || typeof event !== "object" || typeof event.type !== "string")
        throw new Error("ChatGPT returned an invalid stream event");
      yield event;
    }
    if (pending.length > 8 * 1024 * 1024)
      throw new Error("ChatGPT stream event exceeded the transport limit");
  }
  pending += decoder.decode();
  if (pending.trim()) throw new Error("ChatGPT stream ended inside an event");
}

module.exports = { ChatGPTProvider, readEvents };
