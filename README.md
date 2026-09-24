<p align="center">
  <img src="mindforge.png" width="800" alt="MindForge">
</p>

# MindForge

**Persistent NPC minds. Lighter context. Continuous storytelling.**

**by Leolynn**

MindForge is a lightweight NPC memory engine for **AI Dungeon**. Characters keep
private thoughts, motives, promises, relationships, secrets, and plans in their
own Brain Story Cards. Relevant memories guide the next scene while the player
continues playing normally.

[Install](#installation) · [What's new](#whats-new) · [NPC setup](#npc-setup) ·
[Comparison](#comparison-with-inner-self) · [Settings](#settings)

## What's new

- **Off by default:** prepares the configuration and main NPC name, then waits
  for the player to set `Enabled: true` before starting NPC memory.
- **Direct setup answers:** reads recognized player/main-NPC name questions from
  `state.placeholders`, even after the opening has left recent context.
- **Host-aware protection:** respects valid `info.memoryLength` boundaries and
  avoids empty Input/Output returns that the host rejects.
- **Optional FrontMemory experiment:** can stage existing primary-NPC memories
  in the host's shared memory field, with delivery checks and automatic cleanup.
- **~52% cheaper than Inner Self with the same prompt structure:** the default
  **Compact** prompt style keeps the operating-environment directive, the
  strict-format task, and the parenthesized `(key = \`thought\`)` operation with
  the wording minimized to the essential rules. The matched three-memory fixture
  costs 1,108 added characters and 248/247 reference tokens (Inner Self: 2,319 /
  524/526); with the model's own DeepSeek-V4-Flash tokenizer the prompt measures
  207 vs 477 tokens (-57%). **Full** style is available in the config as an
  opt-in fallback.
- **Compact passive turns:** 247 characters for the same three memories. Read-only
  turns keep complete thoughts and their owner while omitting editing syntax.
- **Memory before prose on write turns:** the model is asked to begin with one
  private memory operation and then continue the story. Output removes the
  operation; memory maintenance does not require a separate generation turn.
- **Improved output cleanup:** one shared parser handles active, passive, and
  no-NPC turns, including recognized prompt leaks and unfinished operations.
- **One automatic main NPC:** opening focus, relationship cues, and explicit
  scenario metadata help select one main character. Add supporting NPCs manually.
- **Independent supporting minds:** manually registered characters can become
  active and update their own memories when their names or aliases appear.
- **Cache-friendly transport:** preserves the incoming prefix when the host
  signals cache-efficient mode and appends only what fits.
- **Stronger memory safeguards:** turn-bound writes, retry protection, conservative
  duplicate detection, core-memory protection, and recoverable adaptive profiles.
- **Optional World Memory and World Cards:** retain complete public observations
  and create name-triggered cards for recurring entities without extra AI calls.

See [CHANGELOG.md](CHANGELOG.md) for the update notes.

## Installation

1. Open your scenario's **Details → Scripting → Edit Scripts**.
2. Copy the **entire contents** of each file into its matching tab:

   | AI Dungeon tab | File |
   |---|---|
   | Library | [src/library.js](src/library.js) |
   | Input | [src/input.js](src/input.js) |
   | Context | [src/context.js](src/context.js) |
   | Output | [src/output.js](src/output.js) |

3. Save all four tabs and start or continue the adventure.
4. Open the generated **Configure MindForge** Story Card. MindForge starts with
   **`Enabled: false`**. It can prepare the main NPC name while disabled.
5. When you want to use NPC memory, change that line to **`Enabled: true`**.

While disabled, MindForge does not inject memories or tasks, write or decay
brains, or process ordinary story output. Players can leave it off and play
normally. If it is switched off after a memory task was already sent, that
pending operation is cleaned once without saving a new memory.

Use GitHub's **Raw** button when copying a file. All four tabs should come from
the same version. No package installation, API key, or external service is
required to run MindForge.

### Language

MindForge's prompts, controls, and requested narration use **English**. Add this
line to your scenario's AI Instructions, especially for full cache contexts:

```text
Write all narration, dialogue and thoughts in English.
```

MindForge requests English; it is not a translator or a language classifier.

## NPC setup

### Automatic: one main NPC

With **Scenario Auto-Discovery: true**, MindForge can fill one main-NPC slot
when the configured cast is empty. A single recognized main-NPC setup answer
takes priority over text inference. Otherwise it considers the opening and Plot
Essentials together, preferring explicit main-NPC metadata over relationship
cues and opening focus. Existing registrations and a saved main NPC remain
authoritative.

Character cards contribute candidate names and aliases. They do **not** cause
every character in the scenario to be registered. Translation copies and known
location/organization cards are not treated as NPC registrations.

Discovery can prepare the name in the config notes while `Enabled: false`;
the brain is created when the engine is enabled and the character becomes active.
The chosen main character is saved once. Later scenes do not automatically grow
the cast or replace that character. If the evidence is ambiguous, register the
main NPC yourself. An explicit hint can use this format:

```text
{ Main NPC:
Name: Clara
}
```

### Manual: add supporting NPCs

In **Configure MindForge → Notes/Description**, put one character per line.
Write a simple first name first, followed by optional comma-separated aliases:

```text
NPC Names:
Clara, Clara Ashford
Marcus, Captain Marcus
Nora, the archivist
```

If Clara was discovered automatically, adding Marcus and Nora below her makes
them eligible for their own memories once `Enabled: true`. Manual registration
works even with Auto-Discovery off.
The first name identifies the brain; the other entries are trigger aliases.
Guide lines starting with `//` are ignored.

Each registered NPC can become the active character and write to its own brain.
The main NPC does not permanently occupy the active slot. Recent name mentions,
a short scene lock, profile limits, and available context determine which minds
are included. Registering seven NPCs does not inject seven brains every turn.

You can also explicitly mark a normal card by naming it `@Clara`, or by adding
`mindforge:npc` / `mf:npc` to its keys and using `Clara` as its title. Use a
**simple first name** for these markers; use the config list for full-name aliases.

### Player name

`Player Name: auto` first checks recognized answers in `state.placeholders`,
then falls back to resolved setup text such as `Your name is Alex`. A manually
entered name takes priority. If no usable name is found, it uses `protagonist`.

Recognized question examples:

| Purpose | Placeholder question |
|---|---|
| Player name | `What is your name?`, `Player name:`, `character.name` |
| Numbered player name | `[1/5] Player character name:` |
| Main NPC | `Main NPC name:`, `Primary NPC name:` |
| Numbered main NPC | `[3/5] Important NPC name:` |

Question matching ignores a leading `[n/m]` counter, case, and trailing `:` or
`?`. Conflicting name answers, multiline descriptions, and unrelated questions
such as a parent's name are not selected by array order. Use simple names for
automatic discovery; set names manually when your question wording is different.
Setup answers are read locally without another AI call or a new context block.

## How memory works

1. Find relevant registered NPCs in recent story actions.
2. Select complete memories within the context budget.
3. When useful and affordable, request one private memory operation after the
   story, then remove that operation from the displayed response.
4. Apply at most one authorized operation for that NPC and turn.

For example, the model might produce:

```text
Clara closes the gate and waits for Alex.
[+gate_promise: I promised Alex to guard the gate until sunrise.]
```

The player sees the story; the completed operation updates Clara's brain.
Incomplete trailing operations are removed without storing unfinished memories.
Older prefix-style operations and several common formatting mistakes are also
recognized.

When the format is ignored, a conservative fallback can record an explicit,
unambiguous NPC promise or plan. It does not invent motives from a gesture or
unattributed dialogue. A model response containing only a valid memory operation
can store it once, display `...`, and briefly cool down further memory prompts.

### Brain cards

You can inspect or edit a brain's Notes/Description:

```text
core_identity: I protect the archive above everything else.
relationship_alex: I trust Alex with the sealed map.
goal_current: I want to find the hidden door.
plan_next: I will search the western shelf.
secret_hidden: I know the captain lied.
_state_current(3): I am trying not to show fear.
```

- `core_*` keys are protected from automatic deletion, renaming, and compaction.
  An explicit set operation can still update them.
- `_key(n)` memories expire through active/present turns; repeated Context calls
  within the same turn do not apply decay twice.
- Reusing a key updates that thought. Duplicate checks preserve changed
  negation, quantities, and actors rather than relying on word overlap alone.
- Auto Doctor repairs recognizable damaged cards and compacts lower-value
  memories into `background` when needed.
- Model-authored writes include an operation index in storage. That index is
  omitted from the memory text sent to the model.

## Settings

**Balanced** is the recommended starting point for standard and cache models.

| Profile | Best suited to | Maximum NPC-memory block budget |
|---|---|---:|
| Stable | Smaller or fragile models; one active NPC | 600 characters |
| Balanced | Most adventures; multiple registered NPCs | 1,000 characters |
| Full | Larger windows and more memory context | 1,800 characters |

The percentage setting and available space can reduce these caps. Task
instructions and optional world lore also count toward the overall context
limit. Stored memories are not deleted just because they do not fit this turn.

<details>
<summary>Default configuration</summary>

```text
Enabled: false
Player Name: auto
POV (1=1st, 2=2nd, 3=3rd): 2
Model Profile (Stable/Balanced/Full): Balanced
Memory Transport (Context/FrontMemory): Context
Scenario Auto-Discovery: true
Thought Chance (0-100): 60
Half Thought Chance: true
Max Brain Context (1-95): 18
Context Guard Buffer (200-3000): 600
Lookback Turns (1-20): 5
Max Active NPCs (1-5): 2
Pin Config Card: false
Visual Indicator: true
Volatile Decay (1-10): 3
Use JSON Format: false
ZWSP Thought Labels: true
Brain Rotation: true
Self Reflection Chance (0-100): 20
Brain Steward: true
Agentic Charter: true
Auto Doctor: true
Bootstrap Empty Brains: true
World Memory: false
World Cards: false
Memory Slots: true
Thought Quality Gate: true
Max Brain Keys (3-20): 14
Max Lore Keys (3-30): 8
```

</details>

After opting in, keep the maintenance and quality features enabled for normal
play. Set the POV and player name to match your scenario. Bootstrap can request
initial memories even when the ordinary thought chance is low or zero; disable
it if you want to prevent those requests too.

### Context and cache behavior

With the default **Context** transport, when the host supplies
`info.useCacheEfficient === true`, MindForge preserves the incoming context
exactly and only appends what fits, with a 160-character margin. Stored primary
memory and core identity take priority over requesting a new thought. A
completely full cache prefix can leave no room for additions.

Standard mode can trim a bounded amount of the oldest `Recent Story` to fit
memory, while retaining instructions outside that section and the latest scene
under normal budget pressure. Read-only turns omit editing keys and the longer
maintenance instructions, keeping selected thought sentences and ownership.

A valid `info.memoryLength` protects the host's leading memory from both trimming
and label rewriting, including layouts without a `Recent Story:` heading.
Recognizable shared front memory is also protected. If the protected host
memory itself exceeds the reported limit, MindForge adds nothing and reports
`hostOverBudget` instead of deleting protected text to make room.

Empty Input and Output strings receive minimal nonempty placeholders because
the [host API](https://help.aidungeon.com/scripting) rejects empty returns in those
hooks. Empty Context has a different host fallback and is not filled by that
guard. Ordinary disabled-mode text remains unchanged.

`state.MindForge.contextStats` reports added/removed characters, memory budget,
prefix preservation, compact mode, and task delivery. These are script-side
diagnostics, not measurements of the host's actual cache-hit rate.

### Optional FrontMemory transport

For a creator-controlled experiment, change the config entry to:

```text
Memory Transport (Context/FrontMemory): FrontMemory
```

- **Input** stages a small block of already stored, nonvolatile primary-NPC
  memories in `state.memory.frontMemory`. The first block is capped at 320
  characters; later blocks at up to 600, subject to the last observed room.
- **Context** verifies that the exact block is actually present, still belongs
  to the active NPC, and matches current stored thoughts. Delivered memories
  count toward the normal budget and are not injected a second time.
- If the host omits the block, normal Context delivery is used. Recognizable
  stale, changed, or truncated owned blocks are removed; this cleanup can change
  the returned prefix even in cache mode.
- Only memory data is staged. New memory-write instructions stay in the Context
  hook and still require enough space and turn-bound authorization.
- The temporary shared-field addition is released on the next hook. Existing
  `state.memory.context`, `authorsNote`, and other scripts' front-memory text
  are preserved. Disabling or switching transport also clears owned additions.

**Context remains recommended.** FrontMemory is not free context, a guaranteed
cache improvement, or a substitute for the write-task budget. Wrapper text can
make it more expensive than direct delivery. The new path has been tested with
simulated host assembly; actual AI Dungeon delivery must be checked with Inspect.

Use `contextStats.frontMemoryStatus` (`delivered`, `not-in-context`, `stale`, etc.)
and `frontMemoryChars` to see which path ran. `frontMemoryChars` measures the owned
block already included in the input; `addedChars` measures subsequent additions,
so an unusually small `addedChars` alone does not mean the memory was free.

### Verify in AI Dungeon

Use **Script Test** on the real Input, Context, and Output tabs, then **Play** and
**Inspect** on an adventure you own. Check the assembled context, not just the
visible story: the selected NPC memories should appear once, protected host
instructions should remain, and no task should be expected when none was sent.
Inspect data expires after 15 minutes. Local tests do not certify the host's
16 MB sandbox limit, 2-second deadline, model behavior, or actual cache hits.

If a brain stays empty, compare the same turn's Context, raw model output, and
brain-card Notes/Description. `/mf status` reports **Unfilled Tasks** when Context
included an authorized task but Output had no usable operation or fallback.
This can include unfinished operations; it does not prove that the model saw
or deliberately ignored the instruction. Quality and duplicate rejections have
separate counters. A caught error is logged as `MindForge <hook> error:`, but an
empty Console Log alone does not establish that all hooks ran successfully.
The task wording requests a memory operation; model compliance still requires
live verification.

Write turns mirror Inner Self's proven prompt structure: an **operating
environment** directive (the NPC is also an agentic model that maintains its own
brain) plus a **strict-format task** that asks for one parenthesized
`(key = \`thought\`)` operation followed by the story, ending with the exact
output-shape example. The default **Compact** style condenses the wording of both
blocks while keeping the structure, syntax, and example; **Full** keeps Inner
Self's verbatim text and is available in the config. MindForge's parser accepts
the parenthesized syntax as a legacy form, so storage, labels, and quality gates
are unchanged. Balanced keeps pure parity; the Full profile adds the steward
priority, charter, and slot guidance inside the task block. Read-only turns keep
the English directive, compact memory, and POV rule.
`state.MindForge.contextStats.taskOrder` is `memory-first` when a task is included
and `none` otherwise; `contextStats.taskFormat` reports `inner-self-compact-v1`
or `inner-self-style-v1` (`none` on read-only turns). A task that cannot fit the
context budget is deferred as a whole.

The task's `<SYSTEM>` delimiters are prompt text, not an API system-role change.
Live DeepSeek V4 Flash traces in September 2026 returned only prose with every
earlier prompt revision, so this release adopts the Inner Self prompt that the
model family is known to follow. Local supplied-output tests establish parsing
and storage, not model compliance.

**Open the generated `Avery Brain` card**, rather than the scenario's ordinary
`Avery` character card (substitute your NPC's name). As in Inner Self, **Entry**
shows recent operations and **Notes/Description** stores the current thoughts.
The active-card symbol means the NPC was selected, not that a thought was saved.

The first Entry line, `// MindForge Memory Status:`, now distinguishes:

- `Task included; awaiting Output` — Context included a write task; no Output
  result has been recorded yet.
- `Saved. Stored thoughts: N` — Output wrote the brain card's Notes/Description.
- `No memory operation returned` or `Incomplete operation; not saved` — Output
  had no complete usable operation.
- `Quality filter rejected the thought`, `Duplicate thought`, or
  `Context/Output turn mismatch; not saved` — the operation did not produce a
  new stored thought, with the reason shown directly on the card.
- `Read-only turn; no write task included` — the current Context did not request
  a write.

This status replaces one line; it is not stored as an NPC thought. `/mf status`
also shows **Last Memory Result**, available in Inspect as
`state.MindForge.lastMemoryResult`. `Saved` records the script's card update;
check the adventure card after the turn to confirm live host persistence.

Completed memory operations can wrap onto multiple lines. Legacy Inner Self
assignments with a specific underscored key and a quoted first-person thought
are also recognized beside story prose. An actual model reasoning/“thinking”
display is not itself a memory operation; only text available to the Output
hook can be processed.

### Capture an empty-brain turn

Set `Diagnostics: true` in **Configure MindForge → Entry**, or type `/mf debug on`
in-game, then generate one new turn. Open **MindForge Diagnostics → Notes** to
read the paired report:

- `context.task` and `context.returnedTail`: the complete task block and end of
  the context returned by MindForge, with `taskIncluded`, `taskOrder`,
  `taskFormat`, and the turn hash. Check `omittedChars` for any truncation.
- `output.raw`: text received by MindForge's Output hook **before cleanup**.
- `output.cleaned`, parser counts, and `output.result`: what the script retained
  and why the memory operation was saved or rejected.
- `output.matchesContext`: whether the two captured hook histories match.
- `input`: the last Input-hook text and whether it matched a `/mf` command.
  A missing `input` section means the Input tab did not run MindForge.

This is local diagnostic data, not an NPC thought. The report has empty triggers
and is not inserted into MindForge's memory context. Capture is off by default;
set `Diagnostics: false` (or disable MindForge) to clear the stored report on
the next hook. Only the latest pair is kept; repeated hooks preserve the first
completed pair for that turn. Copy the report before generating another turn.

Text is bounded and `omittedChars` identifies omitted portions. Long Output
samples retain a head and tail; the serialized report is capped at 9,000
characters. The report observes **MindForge's hook boundaries**, not the host's
final model request, model settings, or any reasoning not exposed to Output.
Use Inspect to check host processing or other scripts that run afterwards.

### Updating existing adventures

Replace all four script tabs together. Existing configuration entries remain
authoritative: an adventure already set to `Enabled: true` stays enabled. New
configurations, or older ones without an Enabled setting, start disabled. Change
an existing card to `Enabled: false` if you want to pause its memory system.
Review old settings if you want the other new defaults. Older brain
metadata may contain a `chance` or `budget` value inherited from an earlier
version. Remove that field from the brain card's JSON keys if you want it to
inherit the current config again; intentional per-NPC overrides can remain.

## Optional World Memory and World Cards

With MindForge enabled, enable **World Memory** to retain public observations
about named places and objects. Also enable **World Cards** to create
specific-name-triggered cards after qualifying mentions on two different turns.

- Up to three recent, distinct, complete observations are retained per entity.
- Quoted claims, obvious hypothetical statements, and incomplete sentences are
  skipped. Detection is heuristic and may miss unusual or indirect references.
- Retrieval works without an active NPC and avoids repeating exact observations
  already present in the host context.
- Creator cards with matching titles/triggers are respected. Editing a generated
  card's entry, title, keys, or type pauses automatic updates.
- Disabling automation clears triggers on untouched managed cards. Edited cards
  remain under creator control.

No additional AI call is needed. Generated cards still consume context when the
host selects them. This is a bounded observation system; Inner Self's optional
Auto-Cards integration offers broader model-assisted worldbuilding automation.

## Comparison with Inner Self

**Measured on September 23, 2026.** These are controlled local script tests with
supplied model outputs and MindForge explicitly enabled. They measure context
assembly and parser behavior, not live story quality, model compliance,
inference speed, or actual cache reuse.

### Active memory overhead

Same 1,000-character host input, three stored memories, and a memory-update task:

| Script / mode | Extra context characters | Memories retained |
|---|---:|---:|
| **MindForge — standard or cache** | **1,108** | **3/3** |
| [Inner Self — standard](https://github.com/LewdLeah/Inner-Self) | 2,319 | 3/3 |
| [KV Inner Self — cache](https://github.com/Zoocata1/KV-Inner-Self) | 2,320 | 3/3 |
| [Optimized Context Inner Self — standard](https://github.com/XloSky/Optimized-Context-Inner-Self) | 2,048 | 3/3 |
| Optimized Context Inner Self — cache | 1 in context + 1,988 in a task card | 3/3 in the card |

MindForge adds about **52% fewer characters than original / KV Inner Self** in
this fixture while using the same proven prompt structure. Task-card text is not
free context; same-turn host selection of that card is not assumed.

### Reference token counts

Offline BPE counts use `gpt-tokenizer` 4.0.0. These are named reference encodings,
not a claim about the tokenizer used by a particular AI Dungeon model. Counts
below measure added or reformatted text, separately from any removed host text.

| Fixture / script | `cl100k_base` | `o200k_base` |
|---|---:|---:|
| **Active — MindForge** | **248** | **247** |
| Active — original Inner Self, standard | 524 | 526 |
| Active — KV Inner Self, cache | 521 | 522 |
| **Passive — MindForge** | **52** | **51** |
| Passive — original Inner Self, standard | 83 | 83 |
| Passive — KV Inner Self, cache | 79 | 78 |

The passive fixture retains the same three thoughts in **247 characters**,
versus 318–320 in original / KV Inner Self. Compared with KV, the added-text token
reduction is approximately **52% active** and **34–35% passive** on these
encodings. Measured with the model's own `deepseek-ai/DeepSeek-V4-Flash`
tokenizer, the active prompt alone is **207 vs 477 tokens (-57%)** for the same
proven structure. The original standard-path rows also remove/reformat 5 and 6
input tokens respectively; whole-prompt deltas are not the same as added-text
cost.

### Output handling

| Script | Normal narration preserved | Tested leaks cleaned | Native operation recovery |
|---|---:|---:|---:|
| **MindForge** | **60/60** | **32/32** | **3/3** |
| Inner Self | 40/60 | 12/32 | 3/3 |
| KV Inner Self | 40/60 | 12/32 | 3/3 |
| Optimized Context Inner Self | 40/60 | 12/32 | 3/3 |

The corpus repeats 20 narrative examples across three activation states and 16
leak examples across two states. It includes adverse cases and was used during
development, so these fractions are **test coverage, not production failure
rates**. Passing every example does not guarantee zero leaks for arbitrary
model outputs.

Other results: MindForge delivered all five supplied memories in the two-NPC
fixture and retained a complete owned memory with only 300 characters of free
cache space. All four scripts passed the supplied 120-turn overwrite sequences;
that does not establish superior long-term storytelling or retention.

<details>
<summary>Comparison setup and source versions</summary>

- Node 22.20.0; isolated hooks with JSON-persisted state and cards.
- Three seeds: 1, 17, 42. Ten context cases in standard/cache modes.
- Active measurements use the default Compact prompt style. Earlier 768-,
  901-, 1,399-, 1,569-, and 2,301-character figures described other prompt
  revisions and are superseded.- Shared active settings: 100% thought chance, 30% allocation, five-action
  lookback, second-person POV. MindForge profile: Balanced; transport: Context.
- Passive cases disable bootstrap and set thought chance to zero.
- Optional world generation and Auto-Cards disabled; NGO/SAE bundles excluded.
- Every implementation receives its own native operation syntax with matched
  thought content. Generated card payloads are measured separately.
- Coverage: 240 context observations, 368 output observations, and 960 supplied
  sequence turns across the four implementations.
- Inner Self: `297a1a0`; KV Inner Self: `a879e93`; Optimized Context: `0b6808a`.

</details>

## Optional commands

Players do not need commands during normal play. When MindForge is enabled,
these commands are available for inspection or manual edits:

```text
/mf status
/mf <agent>
/mf set <agent> <key> <value>
/mf forget <agent> <key>
/mf rename <agent> <new_key> <old_key>
/mf clear <agent>
/mf debug [on|off]
```

Commands work in **Do**, **Say**, and **Story** input modes. The command's
result replaces that input as the action, and the AI responds to it; use
**Undo** to remove the exchange from the story. If a command appears in the
story as written text instead, the Input tab is missing or stale: its first
line must call `MindForge("input");`.

## Credits and license

MindForge is an independent project by **Leolynn**, inspired by
[Inner Self](https://github.com/LewdLeah/Inner-Self) by **LewdLeah** and the AI
Dungeon scripting community. Thank you for the inspiration.

Released under the [MIT License](LICENSE). See [NOTICE](NOTICE).
