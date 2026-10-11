---
name: gaim
description: Talk with Google AI Mode through a local, persistent, multi-turn research bridge. Use when a task benefits from current Google web search, when a prior AI Mode answer needs clarification or broader follow-up research, or when several agents need to share one explicit research conversation.
---

# GAIM

GAIM (pronounced "game") stands for Google AI Mode. It gives coding agents a natural-language conversation with Google AI Mode. It uses the user's locally installed system Google Chrome and dedicated signed-in profile. It does not provide a Google API or bypass login, regional restrictions, or human verification.

Before first use, run:

```bash
gaim doctor
```

If GAIM is not installed, install the `googaim` npm package globally first. Never install or download a browser for GAIM. If `gaim doctor` reports that system Google Chrome is missing, stop and ask the human to install Chrome or set `GAIM_CHROME`.

Register `gaim mcp` using the current agent's supported local stdio MCP configuration. Tell the human clearly if the agent must restart or reload its MCP configuration before the tools become available. Never claim registration succeeded until `gaim_status` actually runs.

Prefer the MCP tools `gaim_turn`, `gaim_history`, and `gaim_status`. Omit `conversation_id` for an isolated new conversation. Reuse the returned ID only when the next request should continue that exact Google AI Mode thread. Sources are conversation-level references, not claims that a URL supports a particular sentence.

`gaim guide` prints the full workflow matching the installed GAIM version.
