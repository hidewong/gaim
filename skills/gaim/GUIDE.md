# GAIM agent guide

GAIM is a local bridge between an AI agent and Google AI Mode. The stable interface is one conversation core with three operations: `turn`, `history`, and `status`. MCP, ACP, and CLI are adapters over that same core.

## Conversation rule

- Omit `conversation_id` to create a new isolated conversation.
- Reuse the returned `conversation_id` to ask a follow-up in that same Google AI Mode thread.
- Different callers may deliberately reuse one ID for a shared, multi-speaker conversation.
- Never guess an ID. Use `gaim_history` when you need to inspect the transcript.

Every normal turn instructs AI Mode to perform a fresh web search and GAIM verifies both a fresh Google search request and a minimum source count. If that evidence is absent, report the returned error instead of presenting the answer as searched.

## MCP tools

### `gaim_turn`

Required: `message`. Optional: `conversation_id`, `speaker_id`, `speaker_name`, and idempotent `request_id`.

The result contains `answer_markdown`, approximate `sources`, `conversation_id`, `turn_id`, and `search_evidence`.

### `gaim_history`

Read recent turns from one conversation. It does not trigger a search.

### `gaim_status`

Check browser connectivity, login/availability, queue depth, and the most recent browser error.

## ACP behavior

Each ACP session starts isolated and keeps using its first GAIM conversation for later prompts. Commands:

- `/new` makes the next prompt start a new conversation.
- `/join ID` deliberately joins an existing conversation.
- `/history` reads the current transcript.
- `/status` reports availability.

## Errors

- `HUMAN_VERIFICATION`: ask the human to complete Google's verification in the dedicated profile.
- `NOT_LOGGED_IN`: ask the human to run `gaim login` in a graphical session.
- `AI_MODE_UNAVAILABLE`: the account, device, or region does not currently have AI Mode.
- `GENERATION_TIMEOUT`: Google did not finish within the bounded timeout.
- `SEARCH_EVIDENCE_INSUFFICIENT`: a response appeared, but GAIM could not verify a fresh search and enough sources.

Do not attempt to bypass any of these conditions. GAIM serializes turns within one conversation, allows bounded parallel work across different conversations, and keeps active conversation tabs available for follow-ups until GAIM is stopped.
