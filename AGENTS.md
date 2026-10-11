# AGENTS.md

Instructions for AI coding agents working in this repository.

## Project overview

GAIM is a local browser bridge that lets other agents hold researched, multi-turn conversations with Google AI Mode. It is not an autonomous planning agent.

The architecture has one shared core and three thin interfaces:

```text
CLI ─┐
MCP ─┼─> local daemon -> GAIM core <-> system Google Chrome <-> Google AI Mode
ACP ─┘
```

The core is the only owner of browser interaction, conversations, persistence, concurrency, answer extraction, and sources. Do not duplicate that behavior in an adapter.

## Repository map

- `core.mjs`: product behavior and browser automation.
- `daemon.mjs`: singleton core exposed over local IPC.
- `client.mjs`: shared local-core client.
- `gaim.mjs`: human-facing CLI.
- `gaim-mcp.mjs`: local stdio MCP adapter.
- `gaim-acp.mjs`: ACP adapter.
- `platform.mjs`, `paths.mjs`: Chrome discovery and platform paths.
- `*.test.mjs`: unit and protocol regression tests.
- `e2e.mjs`: real-browser smoke test.
- `README.md`: primary public documentation.
- `README.zh-CN.md`: maintained Chinese translation.

## Commands

```bash
npm ci                  # install the locked dependencies
npm test                # run all unit and protocol tests
npm pack --dry-run      # inspect the public package contents
node e2e.mjs            # real Chrome test; requires an eligible local Google session
node gaim.mjs doctor    # inspect Node, Chrome, and local paths
node gaim.mjs status    # inspect the running local core
```

Run the narrowest relevant test while iterating, then run `npm test` before declaring work complete. Do not claim real-browser support from unit tests alone.

## Working rules

- Reproduce a bug before editing and add a regression test for the reproduced case.
- Identify the single owning module, then make the smallest complete change there.
- Preserve the deep boundary between the core and its adapters.
- Prefer semantic and accessibility selectors. Keep selectors centralized and avoid generated class names.
- Serialize turns within one conversation. Keep bounded parallelism across different conversations.
- Every successful turn must show fresh-search evidence, a completed-response signal, and deduplicated source links.
- Keep answer text free of UI controls and source-card labels; return sources separately.
- Update both READMEs for user-visible behavior. Do not claim a platform or host is verified without a real end-to-end run there.
- Keep public project files in English except the intentionally translated README.
- Do not fix unrelated code, rewrite unrelated history, or discard changes you did not create.

## Browser and security boundaries

- Use an already-installed system Google Chrome. Never download, bundle, or install Chromium or another browser.
- Keep the default architecture local-only. Do not add a public HTTP service, hosted account storage, or remote authentication layer.
- Never bypass sign-in, account or region eligibility, CAPTCHA, or other human verification.
- Do not weaken timeouts, concurrency limits, browser sandboxing, or search-evidence checks merely to make a test pass.
- Never commit credentials, cookies, browser profiles, personal paths, user data, or private instructions.

## Release rules

- Do not hard-code the current package version in README installation commands. The npm badge follows the registry's `latest` tag.
- Package versions belong in package metadata, Git tags, and GitHub Releases.
- Do not publish to npm, create a release, rewrite public history, or change package ownership without explicit user approval.

## Done criteria

Before reporting a change as complete:

1. The focused regression test passes.
2. `npm test` passes.
3. `npm pack --dry-run` has been inspected when packaging or public files changed.
4. A real researched turn and same-conversation follow-up pass when the change touches browser behavior and an eligible Chrome session is available.
5. Any unavailable verification is reported explicitly.
