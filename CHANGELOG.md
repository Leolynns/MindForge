# Changelog

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

- Make the active write task required when present (`required when this task
  is present`) so smaller models are less likely to treat it as optional, and
  strip the matching echoed task line from model output.
- Widen name-trigger scanning to three times Lookback Turns so a recently named
  primary NPC stays active while later turns use only pronouns.
- Count delivered tasks that produce no usable memory operation as
  `unfilledTasks` and surface the counter in `/mf status`.
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
