# creating-dsh-plugins

An agent skill for building tools and plugins for **DeepSeek Harness (dsh)** — the official plugin API, project layout, and workflow, distilled from the real `@deepseek-ai/dsh-tools` type definitions. Written in the standard `SKILL.md` format so every mainstream AI coding agent can load it.

If your agent has ever refused to write a dsh plugin (unfamiliar API) or confidently emitted a wrong one (`run` instead of `execute`, missing `output`, no `inject`), this skill fixes both: it gives the agent authoritative signatures it can copy verbatim.

## Install

The skill is a single `SKILL.md` folder. Install it in the skills directory your agent reads. The common locations:

| Agent | Path |
|---|---|
| Claude Code | `~/.claude/skills/creating-dsh-plugins/` |
| Codex | `~/.codex/skills/creating-dsh-plugins/` or `~/.agents/skills/creating-dsh-plugins/` |
| Gemini CLI | `~/.agents/skills/creating-dsh-plugins/` |
| opencode | `~/.config/opencode/skills/creating-dsh-plugins/` (or a plugin) |
| Cursor | `~/.cursor/skills/creating-dsh-plugins/` |
| superpowers (plugin ecosystem) | `~/.config/opencode/node_modules/superpowers/skills/creating-dsh-plugins/` |

One-line install:

```bash
mkdir -p ~/.claude/skills && \
git clone --depth 1 https://github.com/dsh-io/dsh-plugin-skill.git ~/.claude/skills/creating-dsh-plugins
# swap the destination path for your agent (table above); for Codex/Gemini use ~/.agents/skills
```

For a single project, you can also drop the folder into the project's skills directory (`.claude/skills/`, `.cursor/skills/`, ...) so only that repo's agents load it.

## Verify it works

Start a fresh session in your agent and ask:

> Write a dsh plugin that registers a `get_weather` tool using the creating-dsh-plugins skill.

A correctly loaded skill produces `src/index.ts` with `inject = ['tools']`, `ctx.tools.register(defineTool({ ... output: { schema, render } ... }))` and an `execute(args)` method — never `run`, never a `required` array.

## Contents

- `SKILL.md` — the skill itself: tool API reference, hard schema rules, project layout, workflow, common mistakes, quick reference

## Authoritative facts baked in

- Tools register via `defineTool` from `@deepseek-ai/dsh-tools`; `output` (schema + `render`) is mandatory
- `required` is per-property (`required: true`); there is no `required` array, no `required: false`
- `additionalProperties` must be explicit on object schemas
- Container is `@deepseek-ai/cordis` (a cordis fork), not koishi
- pnpm users need a `pnpm-workspace.yaml` override for the unpublished upstream peer `@deepseek-ai/dsh-type-meta`
- Distribution: npm publish + GitHub `dsh-plugin` topic

## Related

- [@dsh-io/dsh-dev](https://github.com/dsh-io/dsh-dev) — the official dsh plugin toolchain CLI (`scaffold`, `dev`, `check`, `publish`)
- DeepSeek Harness — the agent framework this skill targets

## License

MIT © 2026 dsh-io
