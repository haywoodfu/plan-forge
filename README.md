# plan-forge

[![ci](https://github.com/haywoodfu/plan-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/haywoodfu/plan-forge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40haywood%2Fplan-forge)](https://www.npmjs.com/package/@haywood/plan-forge)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Adversarial plan review between AI coding agents. One model drafts a complete
implementation plan for a frozen requirement, a second model reviews it
against the repository, and every unresolved `blocker`/`major` finding forces
a full-plan revision — looping until the reviewer approves or the workflow
hands off to a human with a complete audit trail. The approved plan is
archived into version control automatically.

v1 pairs **Claude Code** and **Codex CLI** in either direction.

```
requirement (frozen, hashed)
   │
   ▼
author drafts plan ──► reviewer files findings ──► blocker/major open?
   ▲                                                   │yes        │no
   └──── author revises (must answer every finding) ◄──┘           ▼
                                                              approved →
                                                    docs/plans/<task>.md
```

**See a real run**: [`docs/plans/inject-context.md`](./docs/plans/inject-context.md)
is plan-forge planning its own `--inject` feature — Codex authored, Claude
reviewed at `xhigh`, approved with four non-blocking findings. The file is the
tool's verbatim published archive: provenance header, full plan, frozen
requirement appendix.

## Why

Single-model plans have single-model blind spots. In real use, the reviewing
model consistently catches requirement-coverage gaps and correctness issues
the author missed (mid-operation reconnect races, missing client surfaces,
non-atomic commit points) — and the forced revision loop resolves them with
repository evidence rather than vibes. Every round is a file on disk you can
audit later: who claimed what, what changed, and why it was approved.

## Requirements

- Node.js ≥ 20, git
- [Claude Code](https://code.claude.com) CLI, authenticated
- [Codex](https://developers.openai.com/codex) CLI, authenticated
- Run `plan-forge doctor` to verify everything (checks both CLIs' versions
  and every flag the adapters rely on; costs zero tokens)

## Install

**From npm** (CLI usage, or to try it with zero setup):

```bash
npx @haywood/plan-forge doctor
npm install -g @haywood/plan-forge   # installs a global `plan-forge` command
plan-forge doctor
```

**As a Claude Code plugin** (recommended for Claude Code — the repo is its
own marketplace):

```text
/plugin marketplace add haywoodfu/plan-forge
/plugin install plan-forge@plan-forge
```

Then use `/plan-forge <your requirement>` in any session.

**As a Codex plugin** (recommended for Codex — the repo is its own
marketplace):

```bash
codex plugin marketplace add haywoodfu/plan-forge
```

Then restart Codex, open the plugin directory (`/plugins` in the CLI or
**Plugins** in the Codex app), choose the **Plan Forge** marketplace, and
install **Plan Forge**. Start a new session and invoke the skill explicitly
with `$plan-forge <your requirement>`, or ask for a plan review / adversarial
review and let Codex trigger it from its description.

**As a Codex skill clone** (manual fallback while iterating):

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/haywoodfu/plan-forge.git ~/.agents/skills/plan-forge
cd ~/.agents/skills/plan-forge && npm install
node cli.mjs doctor
```

Then restart Codex or open a new session. Invoke the skill explicitly with
`$plan-forge <your requirement>`, or ask for a plan review / adversarial review
and let Codex trigger the skill from its description.

**As a Claude Code skills-directory clone**:

```bash
git clone https://github.com/haywoodfu/plan-forge.git ~/.claude/skills/plan-forge
cd ~/.claude/skills/plan-forge && npm install
node cli.mjs doctor
```

**Legacy Codex custom prompt** (not recommended for new installs):

```bash
npm install -g @haywood/plan-forge
mkdir -p ~/.codex/prompts
cp integrations/codex/plan-forge.md ~/.codex/prompts/plan-forge.md
# then restart Codex or open a new session and invoke:
# /prompts:plan-forge <your requirement>
```

Custom prompts are local copies, do not update with the repo, require explicit
invocation, and assume the `plan-forge` CLI is already available on `PATH`.
Use the Codex plugin or skill install above for reusable workflow behavior.

## Quickstart

Inside any git repository:

```bash
# 1. Freeze the requirement — a file, inline text, or stdin
$EDITOR docs/requirements/dark-mode.md                 # file mode
#   ... or skip the file entirely:
#   --requirement-text "structured requirement text"    (inline)
#   --requirement -                                      (stdin)

# 2. Run the loop (author claude / reviewer codex, or swap them)
plan-forge run \
  --task dark-mode \
  --requirement docs/requirements/dark-mode.md \
  --author claude --reviewer codex

# 3. Watch progress from another terminal (no cost)
plan-forge status --task dark-mode

# 4. On approval the plan is archived automatically,
#    with the frozen requirement appended for a self-contained record
cat docs/plans/dark-mode.md
```

If you do not install the CLI globally, replace `plan-forge` with
`npx @haywood/plan-forge` or run `node cli.mjs` from a skills-directory clone.

When invoked through an agent integration (`/plan-forge <raw text>` in Claude
Code, or `$plan-forge <raw text>` in Codex), the agent must first ask
clarifying questions, structure the requirement (goal, constraints,
acceptance criteria, non-goals), and get your explicit confirmation — of both
the text and the expected spend — before freezing anything. A vague frozen
requirement weakens the review gate; the structuring step is mandatory, not
cosmetic.

You can also pass a Linear issue key or URL (e.g. `/plan-forge ENG-123`): the
agent fetches the ticket through an available Linear tool (such as the Linear
MCP), treats its content as the raw requirement, and records the ticket as a
`Source:` line in the structured requirement. The structuring-and-confirmation
flow above still applies in full — ticket content is never frozen as-is.

Expect a 3–4 round task to take 30–60 minutes and cost roughly **$15–25 of
Claude usage** (plus Codex usage) at the default effort levels. On a laptop,
keep the lid open: timeouts are suspension-aware (system sleep extends the
deadline instead of killing a healthy provider), but sleep still stretches
wall-clock time and can break provider connections.

## Commands

| Command | Purpose |
|---|---|
| `run --task <id> --requirement <file\|-> \| --requirement-text <text>` | create and run a task (file, stdin, or inline text) |
| `resume --task <id>` | continue after any interruption; never re-runs committed rounds |
| `status --task <id>` | current phase, round, open findings (free) |
| `show --task <id> [--publish <path>]` | print the approved plan / copy it elsewhere |
| `override --task <id> --finding F00N --disposition withdrawn\|severity_changed [--severity <s>] --reason "..."` | human ruling on a finding (append-only audit) |
| `doctor` | environment preflight, zero tokens |

Key options (`run`, and where noted `resume`):

```text
--author / --reviewer        claude | codex            (must differ)
--author-effort / --reviewer-effort                    (also on resume)
                             claude: low|medium|high|xhigh|max   default xhigh
                             codex:  none|minimal|low|medium|high|xhigh   default high
--author-timeout / --reviewer-timeout   seconds, default 1200   (also on resume)
--max-rounds 6
--publish-dir docs/plans     approved-plan archive directory (inside the repo)
--clear-failures --reason "..."          resume only: unlatch provider-failure stops
```

## How it stays trustworthy

- **Models are read-only.** Claude runs `--safe-mode` with only
  `Read/Glob/Grep`; Codex runs in its `read-only` sandbox with user config
  ignored. The orchestrator is the only writer, and its single write outside
  the runtime dir is the approved-plan archive.
- **Artifact graph over sessions.** Each round commits an authoritative
  `author-output.json` (plan + per-finding resolutions) and an
  orchestrator-stamped `review.json` (plan hash, model, effort, usage, git
  snapshot). Human-readable projections are derived and rebuildable. Crash
  anywhere and `resume` continues from the last committed artifact — never
  re-billing completed calls.
- **The gate is code, not vibes.** Finding IDs are assigned by the
  orchestrator; the verdict is recomputed from finding state and must match
  the reviewer's claim; approval requires zero open blocker/major findings.
  A critical finding still open after two consecutive re-reviews, round
  exhaustion, or repeated provider failures stops the loop as `needs_human` —
  it never auto-approves.
- **Structured output at both ends.** Both CLIs are driven with JSON-Schema
  constrained output (a shared subset both providers accept), validated
  locally with Ajv before anything is committed; rejected model output is
  preserved for diagnosis.

Runtime state lives in `.plan-forge/<task-id>/` (add `.plan-forge/` to your
`.gitignore`; `run` warns if you haven't).

## Development

```bash
npm test                      # 28 tests, fake providers, zero model cost
PLAN_FORGE_LIVE=1 node --test test/live.test.mjs   # opt-in real two-model smoke
```

Incubated in a private repo and battle-tested there: the loop has survived
laptop sleep mid-review, a full disk, provider protocol slips, and a CLI
update that silently truncated pipe output — each of which became a test.

## License

MIT
