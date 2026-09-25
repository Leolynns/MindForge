# Changelog

## Unreleased — Prompt echo cleanup

- Strip longer leaked task closings such as "Story continues from <player>'s
  second person perspective...", including the `(example_key = ...)` prefix,
  markdown headers, the "The story continues ... new prose" line, and echoes
  appended directly to the end of a prose line. The bare "Story continues..."
  line was already removed; every named variant now is too.

## Unreleased — Enabled by default

- New adventures now start with `Enabled: true`. No card editing, no setup
  answer, and no paste step is required: paste the four tabs and NPC memory
  works from the first turn.
- Add `/mf on` and `/mf off` so players can pause or resume in-game, including
  while MindForge is disabled. The config card's `Enabled` line stays
  authoritative.
- Add a one-time adventure-start toast through the host's `state.message` slot:
  it tells players MindForge is enabled and how to pause it, and it never enters
  the story or the context. A disabled adventure gets a one-time "type /mf on"
  toast instead. If another script owns the message slot, MindForge leaves it
  untouched.
- The optional `MindForge:` setup question still works as an override: "Yes"
  keeps it enabled, any other answer disables it once at adventure start, and
  the question line is removed from Context afterwards.
- Existing configuration cards are untouched: an explicit `Enabled: false`
  stays paused, and older cards without the line still start disabled.

## Unreleased — Compact prompt default

- Add `Prompt Style (Full/Compact)` with **Compact as the default**. Compact
  keeps the proven Inner Self structure and every rule — role framing,
  memory-first order, key and thought rules, novelty priority, closing syntax,
  story continuation, key reuse, and the exact-shape example — with the wording
  minimized. Measured with the model's own `deepseek-ai/DeepSeek-V4-Flash`
  tokenizer: 244 vs 477 tokens for the prompt alone (-49%). In the matched
  three-memory fixture: 285/284 vs 521/522 reference tokens for KV (-45%), and
  1,316 vs 2,320 added characters (-43%).
- Add a scenario setup answer for the initial opt-in: a placeholder question
  containing "MindForge" decides `Enabled` once at adventure start — "Yes"
  enables it, any other answer leaves it disabled. Later manual changes in the
  config card are never overridden. The question line (raw or resolved) is
  removed from every Context afterwards so it never consumes play-time space.
  Counted as `setupEnableAnswers` and shown in `/mf status`.
- Full keeps Inner Self's verbatim text as an opt-in fallback; tests cover both
  styles, including echo-stripping of every compact line.
- The parenthesized syntax, storage, labels, and quality gates are unchanged.
- Live model compliance of the Compact prompt has not been verified yet; the
  user can switch to Full at any time in the config card.

## Unreleased — Inner Self-style prompt parity

- Adopt Inner Self's proven prompt structure: an "OPERATING ENVIRONMENT"
  directive (the NPC is also an agentic model that maintains its own brain)
  plus the strict-format assign task requesting the parenthesized
  `(key = ` + "`thought`" + `)` operation and ending with the exact output-shape
  example.
- The parser already accepts the parenthesized syntax as a legacy form; storage,
  labels, and quality gates are unchanged. `contextStats.taskFormat` reports
  `inner-self-style-v1`.
- Strip full and partial echoes of the directive and task from Output; the
  partial-echo test covers every line of both blocks.
- Balanced keeps pure parity; the Full profile adds the steward priority,
  charter, and slot guidance inside the task block.
- Active context cost moves to parity with Inner Self (2,301 vs 2,319 added
  characters in the matched fixture); passive delivery remains 247 characters.
- Live model compliance of this prompt has not been verified yet.

## Unreleased — Proven task layout parity

- Write turns now place the task block directly after the story and brain, with
  no other instruction paragraphs in between — the layout of the May 2025 build
  that produced live writes. The English directive, POV rule, slot guidance, and
  charter no longer sit between the story and the task on write turns.
- The POV requirement is carried inside the task block; the reflection hint and
  Full-profile slot/charter guidance move inside it. Read-only turns keep the
  English directive, compact memory, and POV rule.
- Update the English contract: the directive is delivered on read-only and
  no-agent turns; write turns rely on the documented AI Instructions line.

## Unreleased — Command input formats

- Accept `/mf` commands in all three AI Dungeon input formats: Do (`> You
  /mf ...`), Say (`> You say "/mf ..."`), and raw story text. Previously only
  raw text matched, so live Do/Say commands passed into the story instead.
- Capture the last Input-hook text and whether it matched a command in the
  MindForge Diagnostics report, so a missing or stale Input tab is visible.

## Unreleased — Restore proven Thought Forge task

- Restore the May 2025 "MindForge Thought Forge" task wording after two live
  DeepSeek V4 Flash traces showed the model ignoring the structured rewrites
  even when the complete task was delivered untruncated.
- The restored task names a concrete operation example, key/thought rules, and
  the behavior-changing thought types, and keeps memory-first output order.
- Keep whole-task budgeting and diagnostics capture; `contextStats.taskFormat`
  reports `thought-forge-v1` on active turns.
- Strip full and partial Thought Forge task echoes from Output; keep stripping
  older structured v2/v3 echoes.
- Remeasure the matched three-memory payload: 1,569 added characters and
  338/337 reference tokens; passive delivery remains 247 characters and 52/51.
- The older wording is the build the user reported working, but this restored
  revision has not yet been re-tested in-game.

## Unreleased — Structured memory task

- Replace the compact task paragraph with a separate MEMORY/STORY instruction
  block, explicit key/value rules, and a combined output shape.
- Explain that the script saves the NPC thought and removes its operation from
  visible prose; distinguish the operation from dialogue and model reasoning.
- Retain whole-task budgeting and new-thought-only instructions for empty brains.
  The larger task is deferred when it cannot fit alongside required memory.
- Strip complete and partial task echoes without turning placeholders into
  memories. Capture the multi-line task in Diagnostics and expose
  `contextStats.taskFormat: structured-v2` on active turns.
- Reproduce the reported 297-character prose-only response in local tests:
  matching hooks and zero parser removals still result in no memory write.
  Live compliance with the revised task remains unverified.
- Remeasure the matched three-memory payload: 1,399 added characters and
  308/306 reference tokens; passive delivery remains 247 characters and 52/51.

## Unreleased — Paired diagnostic capture

- Add opt-in `Diagnostics: false` configuration and a separate MindForge
  Diagnostics card with empty triggers.
- Pair the returned Context task/tail with pre-cleanup Output text, parser
  counts, turn-match information, errors, and the memory result.
- Bound the serialized report to 9,000 characters, report omitted text, preserve
  the first completed pair across repeated hooks, and clear capture when disabled.
- Add `/mf debug [on|off]` to toggle capture in-game without editing the config
  card; no argument flips the current value.
- Keep diagnostic failures separate from normal story and memory processing.
- This provides local hook evidence for empty-brain diagnosis; it does not
  establish live model delivery or instruction compliance.

## Unreleased — Memory-first task delivery

- Request one private memory operation before the story continuation, matching
  Inner Self's output order. Remove the conflicting instruction to omit memory
  before shortening the story; both output parts are explicitly requested.
- Give empty brains only the new-thought operation, without delete/rename forms.
- Reserve the complete task before optional guidance and append it last without
  changing the incoming cache prefix. Expose `contextStats.taskOrder`.
- Ask the model to name other characters in private thoughts and leave the
  player's choices and dialogue to the player.
- Cover the reported Avery prose-only response, prefix writes, prompt echoes,
  and whole-task budgets in 23 local scripted scenarios. Prose-only output still
  does not fabricate a private thought; live model compliance remains unverified.
- Remeasure the matched three-memory payload: 901 added characters and 195/194
  reference tokens; passive delivery remains 247 characters and 52/51 tokens.

## Unreleased — Brain write compatibility and visible status

- Compare card storage with Inner Self, KV Inner Self, and Optimized Context
  Inner Self: current thoughts belong in Notes/Description, recent operations
  in Entry, on the generated Brain card.
- Parse completed memory operations across wrapped lines; previously they were
  incorrectly rejected as truncated and could leave their continuation visible.
- Recognize narrowly identified inline legacy assignments with specific keys
  and quoted first-person values, preserving ordinary equations and asides.
- Display a replaceable `MindForge Memory Status` line on the brain card for
  pending, saved, missing/incomplete, rejected, duplicate, and mismatched turns.
- Expose the latest result, card ID, stored-key count, and turn-match diagnostic
  through `state.MindForge.lastMemoryResult` and `/mf status`.
- Verify new-card writes, visible operation logs, persisted Notes, and next-turn
  memory retrieval with index-returning and extended card APIs in local tests.

## Unreleased — Host API integration

- Read recognized player and main-NPC names from persistent `state.placeholders`
  answers. Preserve manual configuration and reject ambiguous answer matches.
- Keep automatic discovery limited to one main NPC, including disabled setup.
- Guard empty Input and Output returns without changing ordinary disabled text.
- Use valid `info.memoryLength` as a protected leading-context boundary and
  preserve recognizable shared front memory while budgeting additions.
- Add optional `Memory Transport: FrontMemory`: stage stored, nonvolatile
  primary-NPC thoughts in Input, verify delivery in Context, and release only
  the script-owned shared-field block. Keep write tasks out of persistent memory.
- Fall back to direct Context delivery when staged memory is absent; discard
  recognizable stale blocks without granting a memory-write authorization.
- Expose front-memory delivery and protected-memory diagnostics. Context remains
  the default transport; live FrontMemory/cache behavior still needs Inspect.

## Unreleased — Live empty-brain diagnostics

- Request a memory operation explicitly when an active task is present and
  strip the matching echoed task line. Live model compliance is not established
  by the local tests.
- Widen name-trigger scanning to three times Lookback Turns so a recently named
  primary NPC stays active while later turns use only pronouns.
- Align FrontMemory Input preparation with the Context name window, counting
  the pending player action as one slot. Test both sides of the window boundary.
- Count delivered tasks that produce no usable memory operation as
  `unfilledTasks` and surface the counter in `/mf status`.
- Clarify that unfilled tasks include unfinished operations and do not establish
  whether a live model saw or ignored the task; log silence is not a health check.
- Lower relationship-based auto-discovery from two narrative mentions to one so
  beach/prose openings that lean on pronouns still register the main NPC.
- Log caught script errors with a `MindForge <hook> error:` console line so
  live Console Log can show failures that would otherwise restore the turn
  silently.

## Context & Memory Update — 2026-09-23

### Opt-in startup

- Default new configurations to `Enabled: false`.
- Prepare the config card and one main NPC name while disabled, with no memory
  injection, brain writes, decay, or ordinary output processing.
- Start prepared and manually registered NPCs when the player sets `Enabled: true`.
- Preserve explicit settings in existing adventures; clean a task already sent
  before disabling once, without committing its memory operation.

### Context efficiency

- Use a compact shared memory/update protocol for standard and cache modes.
- Preserve the incoming prefix when the host signals cache-efficient mode.
- Budget complete memories before new thought tasks; defer tasks that cannot fit.
- Add read-only formatting for passive, retry, and tight-budget turns.
- Cap NPC memory context at 600 / 1,000 / 1,800 characters by profile.
- Use 18% brain allocation, two active NPCs, and 14 stored normal keys as defaults.
- Matched active fixture: 768 added characters versus about 2,320 in original
  Inner Self / KV Inner Self. Matched passive fixture: 247 characters.

### NPC discovery and control

- Automatically select at most one clear main NPC from scenario metadata,
  relationship evidence, and opening focus.
- Use character cards as candidate identities without registering the full cast.
- Keep manually added supporting NPCs eligible for independent memory and tasks.
- Route by the latest matching name across aliases within a history action.
- Preserve explicitly configured casts and existing brains.

### Output and memory reliability

- Prefer story prose first, followed by an optional private memory operation.
- Share output cleanup across active, passive, no-NPC, and damaged-runtime paths.
- Handle recognized prompt echoes, technical wrappers, and unfinished operations
  while preserving normal dialogue, asides, equations, and short responses.
- Reject unfinished memory writes and enforce single-use, turn/NPC-bound tasks.
- Protect changed negation, quantities, and actors from false duplicate matches.
- Limit extractive fallback to explicit, unambiguous promises and plans.
- Preserve other characters' pronouns and possessives during perspective repair.
- Use the host action count for cooldowns when history becomes a sliding window.
- Resolve inherited NPC settings dynamically and allow adaptive profiles to recover.
- Support index-returning card APIs and preserve memory on same-key renames.

### World memory

- Retain up to three complete chronological observations per named entity.
- Retrieve relevant world observations even without an active NPC.
- Avoid reinjecting exact observations already present in host context.
- Add opt-in World Cards for recurring entities, using specific name triggers.
- Respect creator edits and deactivate untouched managed triggers when disabled.

### Distribution

- Provide four ready-to-copy script tabs with user-facing documentation.
- Keep the cover image at the top of the README.
- Include aggregated comparison results and their measurement limitations in
  the README. Results are local software tests, not live gameplay guarantees.

## 0.1.0

- Initial public release.
