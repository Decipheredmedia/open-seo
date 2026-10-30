# Running OpenSEO agents against local Ollama models

This covers running the OpenSEO skill set on a self-hosted Ubuntu VPS,
driven by locally-installed [Ollama](https://ollama.com) models instead of a
hosted Claude/OpenAI/Anthropic API, orchestrated by
[cairn-dev/cairn](https://github.com/cairn-dev/cairn) as the background-agent
scheduler.

## What's provider-neutral already

OpenSEO's skills (`.agents/skills/*`, mirrored into `plugins/openseo/skills/`)
and the MCP tool surface they call are consumed through the Model Context
Protocol, not a Claude-specific API. Any MCP-capable agent runtime — Claude
Code, Cursor, Codex, or a custom Ollama-driven runner invoked through Cairn —
can read the same `SKILL.md` instructions and call the same tools. No
provider-specific rewrite of the skills or the three plugin manifests
(`.codex-plugin`, `.claude-plugin`, `.cursor-plugin`) is needed to add a new
agent consumer; swapping the model is a runner/orchestration config change,
not a skill-content change. (One skill doc has a plain link to the Claude
Code plugin guide — that's documentation, not a functional dependency.)

## Detecting installed models

`scripts/ollama-model-detect.mjs` queries the local Ollama daemon
(`GET /api/tags`) and classifies installed models into routing tiers:

- **agent** — families known to hold up for the multi-step MCP tool-calling
  that skills like `seo-audit` and `competitive-landscape` require, filtered
  to a minimum parameter size.
- **fast** — smaller/quicker models for single-shot classification or
  extraction steps where full agent-tier reliability isn't needed.
- **fallback** — anything installed, as a last resort.

```sh
# Human-readable summary
node scripts/ollama-model-detect.mjs
# or: pnpm ollama:detect

# Machine-readable routing config
node scripts/ollama-model-detect.mjs --json

# Write the routing config to a file Cairn's startup can read
node scripts/ollama-model-detect.mjs --out /etc/openseo/ollama-routing.json

# Health check only (exit non-zero if Ollama is unreachable) — useful in a
# systemd ExecStartPre or VPS monitoring check
node scripts/ollama-model-detect.mjs --check
```

Set `OLLAMA_BASE_URL` (or `OLLAMA_HOST`) if Ollama isn't on the default
`http://127.0.0.1:11434`. The script exits non-zero when no model at all is
installed, so it can gate a deploy or alert before agents start failing.

## Pointing Cairn at Ollama

Ollama exposes an OpenAI-compatible endpoint at `${OLLAMA_BASE_URL}/v1`. Since
Cairn already supports pluggable providers, no Cairn code change is needed —
configure its model provider as OpenAI-compatible, pointed at that endpoint,
with the model name taken from the `agent` tier of the routing config above
(falling back to `fast`/`fallback` as needed).

## hermes-agents integration gap

[Decipheredmedia/hermes-agents](https://github.com/Decipheredmedia/hermes-agents)
is private; its task/queue contract, auth model, and deployment shape aren't
visible from this repository, so the exact integration point with Cairn
can't be pinned down here. Prefer one of:

- hermes-agents acts as a task source/sink that Cairn polls, or
- both tools point at the same local Ollama endpoint and a thin router
  decides which tool handles which repo/task type.

Avoid building a bespoke third orchestrator between them — get hermes-agents'
maintainers to confirm its interface first.

## Reliability risk

Smaller local Ollama models are generally far less reliable at multi-step
tool-calling and long-context repo reasoning than Claude. Before relying on
this fully for production-grade skill runs, benchmark the specific OpenSEO
skills you plan to automate (especially longer MCP tool chains) against the
candidate local models. It's reasonable to keep Claude/Codex as a fallback
for the most complex skills while routing simpler, high-volume tasks to local
models — the `fast`/`agent` tier split above is meant to make that split
explicit rather than assuming every local model can do everything.

## VPS layout

Run each component as its own systemd service (or container) on the VPS:

1. **Ollama** — pull the models you want available
   (e.g. `ollama pull qwen2.5-coder:32b`), then confirm detection works:
   `pnpm ollama:detect`.
2. **Cairn** — background-agent scheduler, triggered from GitHub webhooks,
   configured to use the local Ollama OpenAI-compatible endpoint.
3. **hermes-agents** — once its runtime/contract is confirmed, run it
   alongside Cairn against the same Ollama endpoint.

Add health checks for: the Ollama endpoint being reachable
(`ollama-model-detect.mjs --check`), free disk space for model weights, and
GPU/CPU headroom — local inference is far more resource-constrained than a
hosted API, and an undersized model will silently degrade multi-step skill
runs rather than failing loudly.
