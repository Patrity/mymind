# Chat Completions API

The chat completions endpoint takes a list of messages and returns a model-generated message.

## Message roles

Each message has a `role` and `content`.

- `system` — the system prompt. Sets the assistant's behavior for the whole conversation. Put stable instructions here: tone, format, constraints.
- `user` — what the end user typed.
- `assistant` — earlier model replies, so the model sees the conversation so far.
- `tool` — results of tool calls the model requested.

## Example request

```json
{
  "model": "example-large",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant that answers in British English." },
    { "role": "user", "content": "What's the capital of Australia?" }
  ],
  "temperature": 0.2
}
```

## Writing a good system prompt

Keep the system prompt short and specific. Tell the model who it is talking to and what a good answer looks like. Avoid contradictory instructions: if the system prompt says "answer in one sentence" and the user asks for a list, the model has to guess which wins.

## Tool calling

Pass `tools` with JSON schemas. When the model wants to call a tool it returns a message with `tool_calls`; run the tool and send the result back as a `tool` message with the matching `tool_call_id`.

## Errors

A `400` means the request body is invalid — usually a malformed message list. A `429` means you hit a rate limit: back off and retry with jitter.
