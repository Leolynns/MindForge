/**
 * MindForge Core Library
 * A lightweight, context-efficient, high-quality agentic NPC memory script for AI Dungeon.
 * Opt-in NPC memory with story-first output and bounded context use.
 */
function MindForgeConfigCard() {
    return Array.isArray(globalThis.storyCards) ? storyCards.find(card => card && (
        (typeof card.title === "string" && card.title.trim().toLowerCase().includes("configure mindforge")) ||
        (typeof card.keys === "string" && card.keys.trim().toLowerCase().includes("mindforge_config"))
    )) : undefined;
}

function MindForgeIsEnabled(card = MindForgeConfigCard()) {
    let enabled = false;
    for (const line of typeof card?.entry === "string" ? card.entry.split("\n") : []) {
        const match = line.match(/^\s*Enabled\s*:\s*(.*?)\s*$/i);
        if (match) enabled = match[1].toLowerCase() === "true";
    }
    return enabled;
}

// Locate only the block leased by this script. Other frontMemory text belongs
// to the scenario or other scripts and must survive cleanup byte-for-byte.
function MindForgeFrontRange(source, lease) {
    if (typeof source !== "string" || !lease || lease.version !== 1 ||
        typeof lease.frame !== "string" || lease.frame.length > 600 ||
        typeof lease.open !== "string" || !/^<!--mf-front:[a-f0-9]+-->$/.test(lease.open) ||
        lease.close !== lease.open.replace("<!--", "<!--/") ||
        !lease.frame.startsWith(`${lease.open}\n`) || !lease.frame.endsWith(`\n${lease.close}`)) return null;
    let start = source.indexOf(lease.open);
    if (start < 0) return null;
    const close = source.indexOf(lease.close, start + lease.open.length);
    let end;
    if (close >= 0) end = close + lease.close.length;
    else if (lease.frame.startsWith(source.slice(start))) end = source.length;
    else return null; // An edited, unclosed block cannot safely own the remainder.
    const exact = source.slice(start, end) === lease.frame;
    if (lease.separator === "\n\n" && source.slice(Math.max(0, start - 2), start) === lease.separator) start -= 2;
    return { text: source.slice(0, start) + source.slice(end), start, end, exact, removedChars: end - start };
}

function MindForgeReleaseFrontMemory() {
    const lease = globalThis.state?.MindForge?.frontMemory;
    if (!lease || typeof lease !== "object" || Array.isArray(lease)) return null;
    const memory = globalThis.state?.memory;
    if (!memory || typeof memory !== "object" || Array.isArray(memory)) return lease;
    const owned = MindForgeFrontRange(memory.frontMemory, lease);
    if (owned) {
        if (owned.text === "" && !lease.hadFront) delete memory.frontMemory;
        else memory.frontMemory = owned.text;
        if (lease.createdMemory && Object.keys(memory).length === 0) delete state.memory;
    }
    return lease;
}

function MindForge(hook) {
    "use strict";
    const originalText = typeof globalThis.text === "string" ? globalThis.text : "";
    const delivery = globalThis.state?.MindForge?.delivery;
    // Players who have not opted in get untouched output. A task already sent
    // before disabling is cleaned once, without committing a memory change.
    const priorFront = globalThis.state?.MindForge?.frontMemory;
    const hasPriorFront = priorFront && typeof priorFront === "object" && !Array.isArray(priorFront);
    const ownsOutput = hook === "output" && (MindForgeIsEnabled() || (delivery?.task && !delivery.consumed) ||
        (hasPriorFront && priorFront.delivered && !priorFront.outputHandled));
    let output = null;
    try {
        if (ownsOutput) output = MindForgeParseOutput(originalText);
        const sharedFront = globalThis.state?.memory?.frontMemory;
        const frontLease = MindForgeReleaseFrontMemory();
        return MindForgeCore(hook, output, frontLease, sharedFront);
    } catch (error) {
        if (globalThis.state && typeof state === "object" && !Array.isArray(state)) {
            const MF = state.MindForge = state.MindForge && typeof state.MindForge === "object" && !Array.isArray(state.MindForge) ? state.MindForge : {};
            MF.agent = "";
            MF.delivery = null;
            MF.pendingMemory = { agent: "", hash: "", turn: -999 };
            MF.health = MF.health && typeof MF.health === "object" && !Array.isArray(MF.health) ? MF.health : {};
            MF.health.errors = (MF.health.errors || 0) + 1;
            MF.health.lastError = String(error && error.message ? error.message : error).slice(0, 180);
        }
        const errLine = `MindForge ${hook} error: ${String(error && error.message ? error.message : error).slice(0, 180)}`;
        if (typeof console !== "undefined" && typeof console.log === "function") console.log(errLine);
        globalThis.text = output ? (output.text || "\u200B") : (originalText || "\u200B");
        return;
    } finally {
        if (hook === "output" && hasPriorFront) priorFront.outputHandled = true;
        // The host rejects empty Input/Output strings; empty Context instead
        // means "use the host context" and must retain that distinct behavior.
        if ((hook === "input" || hook === "output") && globalThis.text === "") {
            globalThis.text = hook === "input" ? " " : "\u200B";
        }
    }
}

// One bounded, structural output parser for active, passive, and no-NPC turns.
// It recognizes the private protocol, not ordinary words such as "task" or "forget".
function MindForgeParseOutput(raw) {
    "use strict";
    const result = { text: String(raw || ""), operations: [], removed: 0, truncated: 0, scaffolding: 0, ui: 0, code: 0 };
    const removeMeta = () => { result.scaffolding++; return ""; };
    let source = result.text
        .replace(/<!--mf-front:([a-f0-9]+)-->[\s\S]*?<!--\/mf-front:\1-->/g, removeMeta)
        .replace(/<!--mf-front:[a-f0-9]+-->[\s\S]*$/g, removeMeta)
        .replace(/<!--\/?mf-front:[a-f0-9]+-->/g, removeMeta)
        .replace(/<(system|think|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1[ \t]*(?:>|(?=\r?\n|$))/gi, removeMeta)
        .replace(/<(?:system|think|analysis|reasoning)\b[^>]*>[\s\S]*$/gi, removeMeta)
        .replace(/<\/(?:system|think|analysis|reasoning)[ \t]*>?/gi, removeMeta)
        .replace(/<\|im_start\|>(?:system|developer|user)\b[^\n]*\n[\s\S]*?(?:<\|im_end\|>|$)/gi, removeMeta)
        .replace(/<\|im_start\|>assistant\b[^\n]*\n?/gi, removeMeta)
        .replace(/<\|start_header_id\|>assistant<\|end_header_id\|>/gi, removeMeta)
        .replace(/<\|(?:im_end|eot_id|endoftext)\|>/gi, removeMeta)
        .replace(/<!--mf:[a-zA-Z0-9_]+-->|\u200B[\u200C\u200D]*\u200B?/g, "");

    // Technical fences are not narrative. Plain text/story fences are unwrapped.
    source = source.replace(/^[ \t]*```([^\n]*)\n([\s\S]*?)(?:^[ \t]*```[ \t]*(?=\r?$)|$(?![\s\S]))/gm, (whole, language, body) => {
        result.scaffolding++;
        if (/^(?:js|javascript|python|py|json|typescript)\b/i.test(language.trim()) ||
            /(?:^|\n)\s*(?:(?:const|let|var)\s+\w+\s*=|\w*(?:brain|state|memory)\s*=|(?:function|def)\s+\w+)/i.test(body)) { result.code++; return ""; }
        return body;
    });

    let technical = false;
    let brainBlock = false;
    source = source.split("\n").map(line => {
        const clean = line.trim();
        if (/^#\s+(?:.+ Brain Thoughts \((?:Active|Present)\)|[\w '-]+ private|World Memory):$/.test(clean)) {
            brainBlock = true;
            return removeMeta();
        }
        if (brainBlock && (!clean || /^-\s+\S/.test(clean))) return removeMeta();
        brainBlock = false;
        if (/^For [\w '-]+ only, (?:after the story (?:optionally )?append one line\b|start your response with one memory operation:)/.test(clean) ||
            /^Story: (?:first|second|third) person; player [\w '-]+\.$/.test(clean) ||
            clean === "Write all narration, dialogue and thoughts in English." ||
            /^Slots: relationship_\w+, goal_current, plan_next, secret_hidden; _state_current expires\.$/.test(clean) ||
            /^Private mind for [\w '-]+: private motives, loyalties, fears and plans guide actions, not player knowledge\.$/.test(clean) ||
            /^Priority: (?:write|warmup|relationship|goal|maintain|prune|none|create [\w '-]+'s first durable thought)\.$/.test(clean) ||
            clean === "Consider an unresolved motive or future plan.") return removeMeta();
        const compact = clean.replace(/[^A-Za-z]/g, "").toLowerCase();
        if (/^(?:waitingforinput|silence|continue|retry|erase|takeaturn)$/.test(compact) &&
            (/^(?:[A-Za-z]\s+){2,}/.test(clean) || /^Waiting\s+for\s+input\.*$/i.test(clean))) { result.ui++; return removeMeta(); }
        // UI widget IDs prove this is UI debris; preserve any story before it.
        line = line.replace(/(?:Waiting\s*for\s*input\.*\s*)?w_(?:pencil|wand|retry|backspace)[^\n]*$/gi, () => { result.ui++; return removeMeta(); });
        if (result.ui && /^waitingforinput$/.test(line.replace(/[^A-Za-z]/g, "").toLowerCase())) return removeMeta();
        if (/^\s*(?:<<\s*)?(?:[⏳✅⚠️]+\s*)?(?:Generating|Updating)\s+(?:Story Arc|NPC (?:brain|memory))\b/i.test(line)) return removeMeta();
        if (/^\s*(?:#{1,6}\s*)?(?:STRICT OUTPUT FORMAT|Story continues\.{3}|```)[ \t]*$/i.test(line) ||
            /^\s*(?:#{1,6}\s*)?(?:MindForge Thought Forge|MindForge NPC|strict output|output format|bracket operation|system instruction|configure mindforge)\b/i.test(line)) {
            technical = true;
            return removeMeta();
        }
        if (technical && (/^\s*You are [\w '-]+[.!]?\s*$/.test(line) ||
            /^\s*(?:Thought rules|Key rules|Valid forms only|Priority|Private mind|Private motives|Story prose must|Give the story priority|Start output immediately|Reuse matching keys)\b/.test(line))) return removeMeta();
        if (/^\s*(?:As an AI(?: language model)?|As a language model)\b/i.test(line)) return removeMeta();
        if (/^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|^\s*(?:function|def)\s+[A-Za-z_$][\w$]*\s*\(/.test(line) ||
            /^\s*\w*(?:_state|_brain|_memory|State|Brain|Memory)\s*=/.test(line) ||
            /^\s*(?:#{1,6}|\/\/)\s*(?:[-=]{3,}|.*(?:internal state|scene continuation|operation log|mindforge))/i.test(line)) { result.code++; return removeMeta(); }
        if (clean) technical = false;
        return line;
    }).join("\n");

    const keyPattern = "[A-Za-z_][A-Za-z0-9_]*(?:[ \\t]+[A-Za-z_][A-Za-z0-9_]*){0,3}(?:\\(\\d{1,3}\\))?";
    const signedHeader = new RegExp(`^([+=-])[ \\t]*(${keyPattern})[ \\t]*(?:([:=])[ \\t]*|(?=[\\])}\\r\\n]|$))`);
    const assignHeader = new RegExp(`^(${keyPattern})[ \\t]*([=:])[ \\t]*`);
    const deleteHeader = /^(?:delete|remove|forget)[ \t]+([a-z_][a-z0-9_]*(?:\(\d{1,3}\))?)[ \t]*(?=[\])}\r\n]|$)/;
    const cleanValue = value => value.trim().replace(/^([`"'“‘])([\s\S]*)[`"'”’]$/, "$2").replace(/\s+/g, " ").trim();
    const readHeader = (value, boundary, marked = false) => {
        const label = value.match(/^(?:[-=]+\s*)?memory[ _-]?operation[ \t]*[:=][ \t]*/i);
        if (label) {
            const inner = readHeader(value.slice(label[0].length), true, true);
            return inner && { ...inner, length: inner.length + label[0].length };
        }
        const signed = value.match(signedHeader);
        if (signed && (signed[1] === "-" || signed[3])) return {
            kind: signed[1] === "+" ? "set" : signed[1] === "-" ? "delete" : "rename",
            key: signed[2], length: signed[0].length, explicit: true
        };
        // An inline legacy operation needs a specific key and a quoted private
        // thought. Do not reinterpret ordinary equations or narrative asides.
        if (!boundary && !marked) {
            const inline = value.match(/^([a-z][a-z0-9]*_[a-z0-9_]+)[ \t]*=[ \t]*[`"“'](?:I|My)\b/);
            if (!inline) return null;
        }
        const del = value.match(deleteHeader);
        if (del) return { kind: "delete", key: del[1], length: del[0].length, explicit: true };
        const assign = value.match(assignHeader);
        if (!assign || !/^[a-z_][a-z0-9_ \t()]*$/.test(assign[1]) || assign[1].trim().length < 2) return null;
        const rest = value.slice(assign[0].length).trimStart();
        if (assign[2] === ":" && !marked && (!assign[1].includes("_") || !/^[`"']?(?:I|My)\b/.test(rest))) return null;
        if (!marked && !/[A-Za-z]/.test(rest)) return null;
        return { kind: "assign", key: assign[1], length: assign[0].length, explicit: marked };
    };
    const sentenceEnd = value => {
        const pattern = /[.!?](?:[`"'”’])?(?=[ \t]+|$)/g;
        let match;
        while ((match = pattern.exec(value))) {
            if (/(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr)|\d)$/.test(value.slice(0, match.index))) continue;
            if (value[match.index - 1] === "." || value[match.index + 1] === ".") continue;
            return match.index + match[0].length;
        }
        return -1;
    };
    const spans = [];
    const addOperation = (header, value, start, end, complete, repaired = false) => {
        const val = cleanValue(value);
        const valid = complete && header.key.length <= 64 &&
            (header.kind === "delete" || (val && val.length <= 220));
        spans.push({ start, end });
        result.removed++;
        if (!complete) result.truncated++;
        if (valid) result.operations.push({ type: header.kind, key: header.key, val, repaired });
    };

    const opens = /[\[({]/g;
    let opening;
    while ((opening = opens.exec(source))) {
        const start = opening.index;
        const previous = spans[spans.length - 1];
        const boundary = !source.slice(source.lastIndexOf("\n", start - 1) + 1, start).trim() ||
            Boolean(previous && !source.slice(previous.end, start).trim());
        const restStart = start + 1;
        const leading = source.slice(restStart).match(/^[ \t]*/)[0].length;
        const header = readHeader(source.slice(restStart + leading, restStart + leading + 350), boundary);
        if (!header) {
            // A cut-off final protocol header is hidden, but never made into a write.
            const tail = source.slice(restStart);
            if (/^[ \t]*[+=-][ \t]*[A-Za-z_0-9]*(?:\(\d*)?[ \t]*$/.test(tail)) {
                spans.push({ start, end: source.length });
                result.removed++;
                result.truncated++;
                break;
            }
            continue;
        }
        const headerEnd = restStart + leading + header.length;
        const valueStart = headerEnd + source.slice(headerEnd).match(/^\s*/)[0].length;
        const newline = source.indexOf("\n", valueStart);
        const lineEnd = newline === -1 ? source.length : newline;
        // A closed operation may wrap across lines. Keep recovery bounded, and
        // stop at a new operation/paragraph instead of borrowing its delimiter.
        const scanEnd = Math.min(source.length, valueStart + 600);
        let close = -1;
        let fallbackClose = -1;
        const first = source[valueStart];
        let quote = ({ '`': '`', '"': '"', "'": "'", '“': '”', '‘': '’' })[first] || "";
        const nested = [];
        for (let i = valueStart; i < scanEnd; i++) {
            const char = source[i];
            if (char === "\n" && /^[ \t\r]*\n/.test(source.slice(i + 1))) break;
            if (/[\[({]/.test(char) && readHeader(source.slice(i + 1, i + 351).trimStart(), true)) break;
            if (quote) {
                if (i > valueStart && char === quote && source[i - 1] !== "\\" &&
                    (quote !== "'" || /[\s\])}]/.test(source[i + 1] || " "))) quote = "";
                else if (/[\])}]/.test(char)) fallbackClose = i;
                continue;
            }
            if (/[\[({]/.test(char)) nested.push(char);
            else if (/[\])}]/.test(char)) {
                if (nested.length) nested.pop();
                else { close = i; break; }
            }
        }
        if (close === -1 && quote && fallbackClose !== -1 && fallbackClose < lineEnd) close = fallbackClose;
        if (close !== -1) {
            addOperation(header, source.slice(valueStart, close), start, close + 1, true, opening[0] !== ({ ']': '[', ')': '(', '}': '{' })[source[close]]);
            opens.lastIndex = close + 1;
        } else {
            const fragment = source.slice(valueStart, lineEnd);
            const end = sentenceEnd(fragment);
            const remaining = end < 0 ? "" : fragment.slice(end).trim();
            // Recover an old prefix-style operation only when prose clearly follows it.
            const recover = boundary && end > 0 && /^["“']?[A-Z][\s\S]*\s+\S/.test(remaining);
            const spanEnd = recover ? valueStart + end : lineEnd;
            addOperation(header, recover ? fragment.slice(0, end) : fragment, start, spanEnd, recover, true);
            opens.lastIndex = spanEnd;
        }
    }

    // Legacy loose operations are accepted only at line boundaries, never mid-prose.
    let offset = 0;
    for (const line of source.split("\n")) {
        const start = offset + line.length - line.trimStart().length;
        if (!spans.some(span => span.start <= start && start < span.end)) {
            const content = line.trimStart();
            const header = readHeader(content, true);
            if (header) {
                const value = content.slice(header.length);
                const end = sentenceEnd(value);
                const hasTail = end > 0 && value.slice(end).trim();
                const complete = header.kind === "delete" || (end > 0 && !value.slice(0, end).endsWith("..."));
                addOperation(header, end > 0 ? value.slice(0, end) : value,
                    start, hasTail ? start + header.length + end : offset + line.length, complete, true);
            }
        }
        offset += line.length + 1;
    }
    spans.sort((a, b) => a.start - b.start);
    let cursor = 0;
    let visible = "";
    for (const span of spans) {
        if (span.start < cursor) continue;
        visible += source.slice(cursor, span.start);
        cursor = span.end;
        if (visible.endsWith(" ") && source[cursor] === " ") cursor++;
    }
    visible += source.slice(cursor);
    // A model disclaimer can follow a removed prefix operation on the same line.
    visible = visible.split("\n").map(line => /^\s*(?:As an AI(?: language model)?|As a language model)\b/i.test(line) ? removeMeta() : line).join("\n");
    result.text = visible.replace(/\n[ \t]+(?=\n)/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return result;
}

function MindForgeCore(hook, parsedOutput, frontLease, sharedFront) {
    "use strict";

    // Validate AI Dungeon globals
    if (
        !globalThis.state || typeof state !== "object" || Array.isArray(state) ||
        !globalThis.info || typeof info !== "object" || Array.isArray(info) ||
        !Array.isArray(globalThis.storyCards) ||
        typeof addStoryCard !== "function" ||
        !Array.isArray(globalThis.history) ||
        typeof text !== "string"
    ) {
        globalThis.text = parsedOutput ? (parsedOutput.text || "\u200B") : (globalThis.text || " ");
        return;
    }

    // Initialize state namespace
    const MF = state.MindForge = state.MindForge || {};
    MF.agent = MF.agent || ""; // Currently triggered primary agent
    MF.hash = MF.hash || "";   // Hash of recent history to detect retries
    MF.ops = MF.ops || 0;     // Operation counter
    MF.labelSeq = MF.labelSeq || 0;
    MF.labels = MF.labels || {};
    MF.memory = MF.memory || {};
    MF.doctor = MF.doctor || { hash: "", turn: -1 };
    MF.health = MF.health || {};
    MF.scene = MF.scene || { agent: "", ttl: 0 };
    MF.memoryOnly = MF.memoryOnly || { agent: "", turn: -999 };
    MF.pendingMemory = MF.pendingMemory || { agent: "", hash: "", turn: -999 };
    MF.lastWrite = MF.lastWrite || {};

    const bumpHealth = (key) => {
        MF.health[key] = (MF.health[key] || 0) + 1;
    };

    const clampInt = (value, fallback, min, max) => {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(Math.max(n, min), max);
    };

    // Hash recent turns so retries do not apply the same mutation twice.
    const getHistoryHash = () => {
        let n = 0;
        const serialized = JSON.stringify(Number.isSafeInteger(info.actionCount)
            ? [info.actionCount, history.slice(-30)] : history.slice(-30));
        for (let i = 0; i < serialized.length; i++) {
            n = ((31 * n) + serialized.charCodeAt(i)) | 0;
        }
        return n.toString(16);
    };

    // History is a sliding window on the host; its length is not an adventure clock.
    const currentTurn = Number.isSafeInteger(info.actionCount) && info.actionCount >= 0
        ? info.actionCount : history.length;
    let protectedMemoryEnd = hook === "context" && Number.isSafeInteger(info.memoryLength) &&
        info.memoryLength > 0 && info.memoryLength <= text.length ? info.memoryLength : 0;

    const hashText = (src = "") => {
        let n = 0;
        for (let i = 0; i < src.length; i++) {
            n = ((31 * n) + src.charCodeAt(i)) | 0;
        }
        return Math.abs(n);
    };

    const cleanComparableKey = (key = "") => key.replace(/^_/, "").replace(/\(\d+\)$/, "").toLowerCase();
    const isCoreKey = (key = "") => cleanComparableKey(key).startsWith("core_");
    const isVolatileKey = (key = "") => key.startsWith("_");
    const sanitizeAgentName = (name = "") => String(name).trim().replace(/[^a-zA-Z0-9_]/g, "");
    const genericPlayerNames = new Set([
        "auto", "protagonist", "player", "character", "hero", "adventurer", "unknown",
        "name", "your name", "you", "yourself", "me", "myself", "someone", "in", "at", "on", "from"
    ]);
    const cleanPlayerName = (value = "") => {
        let clean = String(value || "")
            .replace(/\$\{[^}]*\}/g, "")
            .replace(/^(?:player\s+name|your\s+name|name)\s*[:?=]\s*/i, "")
            .replace(/^[\s"'`“”‘’()[\]{}<>]+|[\s"'`“”‘’()[\]{}<>]+$/g, "")
            .split(/[\n\r,.;!?]/)[0]
            .trim();
        clean = clean.replace(/\s+/g, " ");
        if (!/[A-Za-z]/.test(clean) || clean.length < 2 || clean.length > 40) return "";
        const words = clean.split(" ");
        if (words.length > 3) return "";
        const lower = clean.toLowerCase();
        if (genericPlayerNames.has(lower) || genericPlayerNames.has(words[0].toLowerCase())) return "";
        if (!/^[A-Za-z][A-Za-z0-9_' -]*$/.test(clean)) return "";
        return clean;
    };
    const isUnresolvedSetupValue = (value = "") => (
        /\$\{|\[[0-9]+\s*\/\s*[0-9]+\]|example:|what\s+(?:are|is|does)|player character name|important npc name/i
            .test(String(value || ""))
    );
    const escapeRegex = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const findSetupName = (kind) => {
        if (!Array.isArray(state.placeholders)) return "";
        const playerLabels = new Set([
            "your name", "player name", "player character name", "character name",
            "protagonist name", "what is your name", "what's your name"
        ]);
        const npcLabels = new Set([
            "main npc name", "primary npc name", "important npc name",
            "main character npc name", "main companion name",
            "what is the main npc's name", "what is your main npc's name"
        ]);
        const accepted = kind === "player" ? playerLabels : npcLabels;
        const found = new Map();
        for (const item of state.placeholders.slice(0, 100)) {
            if (!item || typeof item.question !== "string" || typeof item.answer !== "string") continue;
            const label = item.question.trim()
                .replace(/^\[\s*\d+\s*\/\s*\d+\s*\]\s*/, "")
                .replace(/([a-z])([A-Z])/g, "$1 $2")
                .replace(/[._]+/g, " ").replace(/[’]/g, "'")
                .replace(/[?:\s]+$/, "").replace(/\s+/g, " ").toLowerCase();
            if (!accepted.has(label)) continue;
            // Validate the whole answer rather than accepting the first line of
            // a description, unresolved placeholder, or instruction fragment.
            const answer = item.answer.trim().replace(/\s{2,}/g, " ");
            if (/[\r\n]/.test(item.answer) || !/^[A-Za-z][A-Za-z0-9_' -]*$/.test(answer)) continue;
            const name = cleanPlayerName(answer);
            if (name) found.set(name.toLowerCase(), name);
        }
        // Conflicting answers are ambiguous; never pick by array order.
        return found.size === 1 ? found.values().next().value : "";
    };
    const getScenarioScanText = () => {
        const historyText = history
            .slice(0, 8)
            .concat(history.slice(-8))
            .map(act => act && (act.text || act.rawText || ""))
            .filter(Boolean)
            .join("\n");
        const sources = hook === "context" ? [text, historyText] : [historyText, text];
        return [...new Set(sources.filter(Boolean))].join("\n").slice(0, 16000);
    };
    const stripSetupPlaceholders = (value = "") => String(value || "").replace(/\$\{[^}]*\}/g, "");
    const removeBlockClosingBrace = (line = "") => {
        const noPlaceholders = stripSetupPlaceholders(line);
        if (!/\}\s*$/.test(noPlaceholders)) return line;
        return line.replace(/\}\s*$/, "").trimEnd();
    };
    const extractScenarioBlocks = (srcText = "") => {
        const blocks = [];
        const lines = String(srcText || "").split(/\r?\n/);
        let active = null;

        const closeIfNeeded = (line) => {
            if (!active) return;
            active.lines.push(removeBlockClosingBrace(line));
            const noPlaceholders = stripSetupPlaceholders(line);
            if (/\}\s*$/.test(noPlaceholders)) {
                blocks.push({ header: active.header, body: active.lines.join("\n") });
                active = null;
            }
        };

        for (const line of lines) {
            if (!active) {
                const start = line.match(/^\s*\{\s*([A-Za-z][A-Za-z0-9 _'/-]{0,48})\s*:\s*(.*)$/);
                if (!start) continue;
                active = { header: start[1].trim(), lines: [] };
                if (start[2]) {
                    closeIfNeeded(start[2]);
                }
            } else {
                closeIfNeeded(line);
            }
        }
        return blocks;
    };
    const getNamedField = (body = "") => {
        const match = String(body || "").match(/(?:^|\n)\s*Name\s*:\s*([^\n\r]+)/i);
        if (!match || isUnresolvedSetupValue(match[1])) return "";
        return cleanPlayerName(match[1]);
    };
    const findScenarioPlayerNameInText = (srcText = "") => {
        const playerHeaders = /^(?:player|player character|protagonist|main character|you|user)$/i;
        for (const block of extractScenarioBlocks(srcText)) {
            if (!playerHeaders.test(block.header.trim())) continue;
            const name = getNamedField(block.body);
            if (name) return name;
        }
        return "";
    };
    const shouldAutoDetectPlayer = (value = "") => {
        const lower = String(value || "").trim().toLowerCase();
        return !lower || genericPlayerNames.has(lower) || lower.includes("${");
    };
    const findPlayerNameInInfo = () => {
        const visit = (obj, depth = 0, path = "") => {
            if (!obj || typeof obj !== "object" || depth > 2) return "";
            for (const key in obj) {
                const nextPath = path ? `${path}.${key}` : key;
                const value = obj[key];
                if (typeof value === "string" || typeof value === "number") {
                    if (/(?:^|\.|_)(?:player|character|protagonist|user|name)(?:$|\.|_)/i.test(nextPath)) {
                        const clean = cleanPlayerName(value);
                        if (clean) return clean;
                    }
                } else if (value && typeof value === "object" && !Array.isArray(value)) {
                    const nested = visit(value, depth + 1, nextPath);
                    if (nested) return nested;
                }
            }
            return "";
        };
        return visit(info);
    };
    const findPlayerNameInText = (srcText = "") => {
        const source = String(srcText || "").slice(0, 8000);
        const scenarioName = findScenarioPlayerNameInText(source);
        if (scenarioName) return scenarioName;
        const patterns = [
            /(?:^|\n)\s*(?:player\s+name|player\s+character\s+name|protagonist|your\s+name)\s*[:?=]\s*([A-Za-z][A-Za-z0-9_' -]{1,40})/i,
            /\b(?:your\s+name\s+is|you\s+are\s+named|you\s+play\s+as|call\s+yourself|call\s+me)\s+([A-Za-z][A-Za-z0-9_' -]{1,40})/i,
            /\byou\s+are\s+(?:a|an|the)?\s*[^.\n,;]{0,32}?\bnamed\s+([A-Za-z][A-Za-z0-9_' -]{1,40})/i,
            /\byou,\s+([A-Za-z][A-Za-z0-9_' -]{1,40}),\s+(?:are|were|have|stand|wake|enter|arrive)/i
        ];
        for (const pattern of patterns) {
            const match = source.match(pattern);
            if (match) {
                const clean = cleanPlayerName(match[1]);
                if (clean) return clean;
            }
        }
        return "";
    };
    const resolvePlayerName = (configuredName = "") => {
        const manualName = cleanPlayerName(configuredName);
        if (manualName && !shouldAutoDetectPlayer(configuredName)) {
            MF.playerName = manualName;
            MF.playerNameSource = "config";
            return manualName;
        }
        const setupName = findSetupName("player");
        if (setupName) {
            if (MF.playerName !== setupName) bumpHealth("playerNameDetections");
            MF.playerName = setupName;
            MF.playerNameSource = "placeholder";
            return setupName;
        }
        const cached = cleanPlayerName(MF.playerName);
        if (cached) return cached;
        const detected = findPlayerNameInInfo() || findPlayerNameInText(getScenarioScanText());
        if (detected) {
            if (MF.playerName !== detected) bumpHealth("playerNameDetections");
            MF.playerName = detected;
            MF.playerNameSource = "text-or-info";
            return detected;
        }
        return "protagonist";
    };
    const formatMemoryKey = (key = "") => {
        const raw = String(key || "").trim().replace(/\s+/g, "_");
        const volatile = raw.startsWith("_");
        const clean = raw
            .replace(/[.'`"“”‘’]+/g, "")
            .replace(/[^a-zA-Z0-9_()]/g, "_")
            .replace(/([a-z0-9])([A-Z])/g, (_, a, b) => `${a}_${b.toLowerCase()}`)
            .replace(/__+/g, "_")
            .replace(/^_+|_+$/g, "")
            .toLowerCase()
            .slice(0, 64);
        return clean ? `${volatile ? "_" : ""}${clean}` : "";
    };

    const getMemoryStore = (agentName) => {
        const cleanAgent = sanitizeAgentName(agentName);
        MF.memory[cleanAgent] = MF.memory[cleanAgent] || {};
        return MF.memory[cleanAgent];
    };

    const touchMemory = (agentName, key, reason = "seen") => {
        if (!agentName || !key) return;
        const store = getMemoryStore(agentName);
        const rec = store[key] = store[key] || {};
        rec.seen = (rec.seen || 0) + (reason === "seen" ? 1 : 0);
        rec.writes = (rec.writes || 0) + (reason === "write" ? 1 : 0);
        rec.turn = currentTurn;
        rec.reason = reason;
    };

    const forgetMemoryMeta = (agentName, baseKey) => {
        if (!agentName || !baseKey) return;
        const store = getMemoryStore(agentName);
        const target = cleanComparableKey(baseKey);
        for (const key in store) {
            if (cleanComparableKey(key) === target) {
                delete store[key];
            }
        }
    };

    const classifyMemoryKey = (key = "") => {
        const clean = cleanComparableKey(key);
        if (clean === "background") return "background";
        if (isCoreKey(key)) return "core";
        if (isVolatileKey(key)) return "volatile";
        if (/^(relationship|relation|bond|trust|attitude|opinion|feeling)_/.test(clean) || clean.includes("_relationship")) return "relationship";
        if (/^(goal|mission|objective|desire|want)_/.test(clean) || clean.includes("_goal")) return "goal";
        if (/^(plan|intent|strategy|next|future)_/.test(clean)) return "plan";
        if (/^(secret|fear|concern|worry|risk|threat)_/.test(clean)) return "secret";
        if (/^(memory|event|fact|lesson|promise)_/.test(clean)) return "memory";
        if (/^(mood|emotion|state|status)_/.test(clean)) return "state";
        return "normal";
    };

    const tierWeight = (tier) => ({
        core: 1000,
        relationship: 220,
        goal: 210,
        secret: 195,
        plan: 175,
        memory: 150,
        state: 135,
        volatile: 125,
        normal: 100,
        background: 90
    }[tier] || 100);

    const keyMentionedInText = (key, sourceText = "") => {
        const displayKey = cleanKeyForLLM(key);
        const textLower = sourceText.toLowerCase();
        try {
            return new RegExp("\\b" + displayKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(sourceText);
        } catch {
            return textLower.includes(displayKey.toLowerCase());
        }
    };

    const scoreThought = (agentName, key, value, sourceText = "", recentTags = []) => {
        const tier = classifyMemoryKey(key);
        const store = getMemoryStore(agentName);
        const meta = store[key] || {};
        let score = tierWeight(tier);
        const displayKey = cleanKeyForLLM(key);
        if (recentTags.includes(key) || recentTags.includes(displayKey)) score += 95;
        if (keyMentionedInText(key, sourceText)) score += 70;
        // Labels identify thoughts; their existence is not evidence of relevance.
        const sceneWords = new Set(String(sourceText).toLowerCase().match(/[a-z]{4,}/g) || []);
        const ignored = new Set(['that', 'this', 'with', 'from', 'have', 'will', 'they', 'their', 'must', 'would', 'could', 'should']);
        const thoughtWords = new Set(String(value).toLowerCase().match(/[a-z]{4,}/g) || []);
        let relevant = 0;
        for (const word of thoughtWords) if (!ignored.has(word) && sceneWords.has(word)) relevant++;
        score += Math.min(120, relevant * 30);
        if (typeof value === "string" && value.length > 180) score -= 15;
        if (Number.isInteger(meta.turn)) score += Math.max(0, 28 - Math.max(0, currentTurn - meta.turn));
        // Do not reward repeated exposure: it would permanently starve other thoughts.
        score += Math.min(28, (meta.writes || 0) * 7);
        return score;
    };

    const defaultConfigEntry = [
        "MindForge Configuration",
        "",
        "Adjust the values below. Keep the colon and space.",
        "",
        "Enabled: false",
        "Player Name: auto",
        "POV (1=1st, 2=2nd, 3=3rd): 2",
        "Model Profile (Stable/Balanced/Full): Balanced",
        "Memory Transport (Context/FrontMemory): Context",
        "Scenario Auto-Discovery: true",
        "Thought Chance (0-100): 60",
        "Half Thought Chance: true",
        "Max Brain Context (1-95): 18",
        "Context Guard Buffer (200-3000): 600",
        "Lookback Turns (1-20): 5",
        "Max Active NPCs (1-5): 2",
        "Pin Config Card: false",
        "Visual Indicator: true",
        "Volatile Decay (1-10): 3",
        "Use JSON Format: false",
        "ZWSP Thought Labels: true",
        "Brain Rotation: true",
        "Self Reflection Chance (0-100): 20",
        "Brain Steward: true",
        "Agentic Charter: true",
        "Auto Doctor: true",
        "Bootstrap Empty Brains: true",
        "World Memory: false",
        "World Cards: false",
        "Memory Slots: true",
        "Thought Quality Gate: true",
        "Max Brain Keys (3-20): 14",
        "Max Lore Keys (3-30): 8"
    ].join("\n");

    const configGuideText = [
        "// MindForge Quick Guide:",
        "// Public scenario setup:",
        "// MindForge starts disabled. Set Enabled: true in this card to start NPC memory.",
        "// 1) Add important NPC names below, one per line. Use commas for aliases.",
        "// Example: Elara, queen, the queen",
        "// 2) Player Name: auto reads recognized setup answers first, then resolved scenario text.",
        "// 3) Auto-Discovery selects one clear main NPC. Add other NPCs below it to enable their memories.",
        "// 4) Balanced is the recommended public default. Use Stable for small/cache models.",
        "// 5) Leave Auto Doctor and Agentic Charter on for hands-off NPC minds.",
        "// 6) World Memory is optional and disabled by default; enable it only when shared lore should grow automatically.",
        "// Language: English narration, dialogue, prompts, and memory notes.",
        "// Tip: A normal story card titled @Elara also registers Elara automatically.",
        "// MindForge handles brain repair, compaction, parser cleanup, and optional world memory automatically.",
        "// You can ignore commands during normal play."
    ].join("\n");

    const parseBrainMeta = (card) => {
        if (!card || typeof card.keys !== "string") return null;
        try {
            const meta = JSON.parse(card.keys);
            return meta && typeof meta === "object" && !Array.isArray(meta) ? meta : null;
        } catch {
            return null;
        }
    };

    // Resolve the created card independently of the host's return convention.
    // Some hosts return an index or no value even with { returnCard: true }.
    const createStoryCard = (keys, entry, type, title, description) => {
        const added = addStoryCard(keys, entry, type, title, description, { returnCard: true });
        const card = added && typeof added === "object" && storyCards.includes(added)
            ? added : storyCards.find(item => item && item.keys === keys);
        if (!card) throw new Error("MindForge could not create its story card");
        if (typeof card.title !== "string" || !card.title) card.title = title;
        if (typeof card.description !== "string" || !card.description) card.description = description;
        return card;
    };

    const repairBrainCard = (card, agentName) => {
        if (!card) return card;
        const meta = parseBrainMeta(card) || {};
        const cleanAgent = sanitizeAgentName(meta.agent || agentName);
        if (!cleanAgent) return card;

        let repaired = false;
        meta.agent = cleanAgent;
        const nextKeys = JSON.stringify(meta);
        if (card.keys !== nextKeys) {
            card.keys = nextKeys;
            repaired = true;
        }
        if (typeof card.entry !== "string") {
            const timeStr = new Date().toISOString().replace("T", " ").slice(0, 16);
            card.entry = `// MindForge Brain Card repaired @ ${timeStr} UTC\n// Operation Log:\n`;
            repaired = true;
        }
        if (typeof card.description !== "string") {
            card.description = "";
            repaired = true;
        }
        if (typeof card.title !== "string" || !card.title.trim()) {
            card.title = `${cleanAgent} Brain`;
            repaired = true;
        } else if (!card.title.toLowerCase().includes(cleanAgent.toLowerCase())) {
            card.title = `${cleanAgent} Brain`;
            repaired = true;
        }
        if (repaired) bumpHealth("brainRepairs");
        return card;
    };

    const hasConfigSetting = (entry, predicate) => entry
        .split("\n")
        .map(line => line.split(":")[0].trim().toLowerCase())
        .some(predicate);

    const migrateConfigCard = (card) => {
        if (!card) return;
        let migrated = false;
        const insertConfigGuide = (description) => {
            const lines = String(description || "").split("\n");
            const headerIdx = lines.findIndex(line => String(line || "").trim().toLowerCase().startsWith("npc names"));
            let insertAt = headerIdx === -1 ? lines.length : headerIdx + 1;
            while (insertAt < lines.length) {
                const clean = String(lines[insertAt] || "").trim();
                if (!clean) {
                    insertAt++;
                    continue;
                }
                if (clean.startsWith("//") || clean.startsWith(">")) break;
                insertAt++;
            }
            lines.splice(insertAt, 0, ...configGuideText.split("\n"));
            return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
        };
        const normalizeConfigGuide = (description) => {
            const guideLines = new Set(configGuideText.split("\n"));
            const lines = String(description || "")
                .split("\n")
                .filter(line => !guideLines.has(String(line || "").trimEnd()));
            return insertConfigGuide(lines.join("\n"));
        };

        if (typeof card.entry !== "string" || card.entry.trim() === "") {
            card.entry = defaultConfigEntry;
            migrated = true;
        } else {
            const missingLines = [];
            const addIfMissing = (line, predicate) => {
                if (!hasConfigSetting(card.entry, predicate)) {
                    missingLines.push(line);
                }
            };
            addIfMissing("Enabled: false", key => key === "enabled");
            addIfMissing("Player Name: auto", key => key.includes("player name"));
            addIfMissing("POV (1=1st, 2=2nd, 3=3rd): 2", key => key.includes("pov"));
            addIfMissing("Model Profile (Stable/Balanced/Full): Balanced", key => key.includes("model profile"));
            addIfMissing("Memory Transport (Context/FrontMemory): Context", key => key.includes("memory transport"));
            addIfMissing("Scenario Auto-Discovery: true", key => key.includes("scenario auto") || key.includes("auto-discovery") || key.includes("auto discovery"));
            addIfMissing("Thought Chance (0-100): 60", key => key.includes("thought chance") && !key.includes("half"));
            addIfMissing("Half Thought Chance: true", key => key.includes("half thought chance") || key.includes("half chance"));
            addIfMissing("Max Brain Context (1-95): 18", key => key.includes("max brain context") || key === "context");
            addIfMissing("Context Guard Buffer (200-3000): 600", key => key.includes("context guard"));
            addIfMissing("Lookback Turns (1-20): 5", key => key.includes("lookback"));
            addIfMissing("Max Active NPCs (1-5): 2", key => key.includes("max active"));
            addIfMissing("Pin Config Card: false", key => key.includes("pin config"));
            addIfMissing("Visual Indicator: true", key => key.includes("visual indicator"));
            addIfMissing("Volatile Decay (1-10): 3", key => key.includes("volatile decay"));
            addIfMissing("Use JSON Format: false", key => key.includes("use json format") || key.includes("json format"));
            addIfMissing("ZWSP Thought Labels: true", key => key.includes("zwsp") || key.includes("thought label"));
            addIfMissing("Brain Rotation: true", key => key.includes("brain rotation"));
            addIfMissing("Self Reflection Chance (0-100): 20", key => key.includes("self reflection"));
            addIfMissing("Brain Steward: true", key => key.includes("brain steward"));
            addIfMissing("Agentic Charter: true", key => key.includes("agentic charter"));
            addIfMissing("Auto Doctor: true", key => key.includes("auto doctor"));
            addIfMissing("Bootstrap Empty Brains: true", key => key.includes("bootstrap empty") || key.includes("empty brain"));
            addIfMissing("World Memory: false", key => key.includes("world memory") || key.includes("auto lore"));
            addIfMissing("World Cards: false", key => key.includes("world cards"));
            addIfMissing("Memory Slots: true", key => key.includes("memory slot"));
            addIfMissing("Thought Quality Gate: true", key => key.includes("quality gate"));
            addIfMissing("Max Brain Keys (3-20): 14", key => key.includes("max brain keys"));
            addIfMissing("Max Lore Keys (3-30): 8", key => key.includes("max lore keys"));
            if (missingLines.length) {
                card.entry = `${card.entry.trimEnd()}\n${missingLines.join("\n")}`;
                migrated = true;
            }
        }

        if (typeof card.description !== "string") {
            card.description = insertConfigGuide("NPC Names (first name followed by optional comma-separated aliases):\n");
            migrated = true;
        } else if (!card.description.toLowerCase().includes("npc names")) {
            card.description = insertConfigGuide(`NPC Names (first name followed by optional comma-separated aliases):\n${card.description.trim()}`);
            migrated = true;
        } else if (!card.description.includes("MindForge Quick Guide")) {
            card.description = insertConfigGuide(card.description);
            migrated = true;
        } else {
            const normalizedDescription = normalizeConfigGuide(card.description);
            if (normalizedDescription !== card.description.trimEnd()) {
                card.description = normalizedDescription;
                migrated = true;
            }
        }

        if (migrated) bumpHealth("configMigrations");
    };

    const getAutoNpcName = (card) => {
        if (!card || typeof card.title !== "string") return "";
        const title = card.title.trim();
        const keyText = typeof card.keys === "string" ? card.keys.toLowerCase() : "";
        const marked = title.startsWith("@") || keyText.includes("mindforge:npc") || keyText.includes("mf:npc");
        if (!marked) return "";
        const raw = title
            .replace(/^[@\s]*/, "")
            .replace(/\s*\[(?:mf|mindforge)[^\]]*\]\s*$/i, "")
            .replace(/\s+brain$/i, "");
        return sanitizeAgentName(raw);
    };

    // Find or create the story card that stores one NPC's brain.
    const getBrainCard = (agentName) => {
        const cleanAgent = sanitizeAgentName(agentName);
        if (!cleanAgent) return null;
        let card = storyCards.find(c => {
            if (!c || typeof c.keys !== "string") return false;
            try {
                const meta = JSON.parse(c.keys);
                return meta && meta.agent === cleanAgent;
            } catch {
                return false;
            }
        });

        if (!card) {
            const needle = `${cleanAgent} brain`.toLowerCase();
            card = storyCards.find(c => (
                c &&
                typeof c.title === "string" &&
                c.title.toLowerCase().includes(needle)
            ));
        }

        if (!card) {
            const timeStr = new Date().toISOString().replace("T", " ").slice(0, 16);
            card = createStoryCard(
                JSON.stringify({ agent: cleanAgent }),
                `// MindForge Brain Card initialized @ ${timeStr} UTC\n// Operation Log:\n`,
                "Brain",
                `🧩 ${agentName} Brain`,
                "",
                { returnCard: true }
            );
        }
        return repairBrainCard(card, cleanAgent);
    };

    // Entry is the player-facing operation log; Notes remain the source of truth.
    // Replace one owned status line instead of accumulating a log on every miss.
    const setBrainStatus = (card, message) => {
        if (!card) return;
        const entry = String(card.entry || "").split("\n")
            .filter(line => !line.startsWith("// MindForge Memory Status:")).join("\n").trim();
        card.entry = `// MindForge Memory Status: ${message}\n${entry}`;
    };

    const cleanDiscoveredName = (value = "") => {
        if (isUnresolvedSetupValue(value)) return "";
        const trimmed = String(value || "")
            .replace(/\b(?:arrives?|steps?|walks?|looks?|says?|asks?|replies?|answers?|stops?|turns?|reaches?|touches?|watches?|waits?|moves?|leans?|smiles?|frowns?|whispers?|shouts?|and|then|with)\b[\s\S]*$/i, "")
            .trim();
        return cleanPlayerName(trimmed);
    };

    const scoreNarrativeNpcUse = (name, sourceText) => {
        if (!name) return 0;
        const narrative = String(sourceText || "").replace(/["“][^"”]{0,300}["”]/g, " ");
        const regex = new RegExp(
            `\\b${escapeRegex(name)}\\s+(?:steps?|walks?|looks?|says?|asks?|replies?|answers?|stops?|turns?|reaches?|touches?|watches?|waits?|moves?|leans?|smiles?|frowns?|whispers?|shouts?)\\b`,
            "ig"
        );
        let count = 0;
        while (regex.exec(narrative) && count < 3) count++;
        return count * 20;
    };

    const hasAgentInConfig = (config, agentName) => (
        config.agents.some(a => a.name.toLowerCase() === agentName.toLowerCase())
    );

    const hasAgentLine = (description, agentName) => {
        const target = agentName.toLowerCase();
        for (const line of String(description || "").split("\n")) {
            const clean = line.trim();
            if (!clean || clean.startsWith("//") || clean.startsWith(">") || clean.toLowerCase().startsWith("npc names")) {
                continue;
            }
            const first = clean.split(",")[0].trim();
            if (sanitizeAgentName(first).toLowerCase() === target) return true;
        }
        return false;
    };

    const findAgentLineIndex = (lines, agentName) => {
        const target = agentName.toLowerCase();
        for (let i = 0; i < lines.length; i++) {
            const clean = String(lines[i] || "").trim();
            if (!clean || clean.startsWith("//") || clean.startsWith(">") || clean.toLowerCase().startsWith("npc names")) {
                continue;
            }
            const first = clean.split(",")[0].trim();
            if (sanitizeAgentName(first).toLowerCase() === target) return i;
        }
        return -1;
    };

    const upsertAgentLineInConfig = (description, agentName, lineText) => {
        const lines = String(description || "").split("\n");
        const existingIdx = findAgentLineIndex(lines, agentName);
        const existingLine = existingIdx === -1 ? lineText : lines.splice(existingIdx, 1)[0].trim();
        const headerIdx = lines.findIndex(line => String(line || "").trim().toLowerCase().startsWith("npc names"));
        let insertAt = headerIdx === -1 ? 0 : headerIdx + 1;

        while (insertAt < lines.length) {
            const clean = String(lines[insertAt] || "").trim();
            if (!clean) {
                insertAt++;
                continue;
            }
            if (clean.startsWith("//") || clean.startsWith(">")) break;
            if (clean.toLowerCase().startsWith("npc names")) {
                insertAt++;
                continue;
            }
            insertAt++;
        }

        lines.splice(insertAt, 0, existingLine || lineText);
        return {
            description: lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd(),
            added: existingIdx === -1
        };
    };

    const buildDiscoveredAgent = (rawName) => {
        const cleanName = cleanDiscoveredName(String(rawName || "").replace(/^(?:coach|captain|doctor|dr\.?|sir|lady|professor)\s+/i, ""));
        const canonical = sanitizeAgentName(cleanName.split(/\s+/)[0]);
        if (!canonical || genericPlayerNames.has(canonical.toLowerCase())) return null;
        const lowerRaw = cleanName.toLowerCase();
        const aliases = [...new Set([canonical.toLowerCase(), lowerRaw].filter(Boolean))];
        return {
            name: canonical,
            fullName: cleanName,
            aliases,
            line: [canonical, ...aliases.filter(alias => alias !== canonical.toLowerCase())].join(", ")
        };
    };

    const discoverScenarioAgents = (config, card) => {
        // Wait for Context so Plot Essentials can identify the main character
        // before a supporting character in the opening is mistaken for it.
        if (hook !== "context" || !config.scenarioDiscovery || !card) return;
        // Discovery fills one main-NPC slot. A later scene must not grow an
        // automatic cast or replace the established main character.
        if (MF.mainNpc || config.agents.length) return;
        if (storyCards.some(item => getAutoNpcName(item))) return;
        const firstAction = history.find(action => action && action.type === "start") ||
            history.find(action => action && (action.text || action.rawText));
        const opening = stripSetupPlaceholders(String(firstAction?.text || firstAction?.rawText || "")).slice(0, 12000);
        // Use each source once. The old first/last-history concatenation could
        // count a short opening twice and crowd Plot Essentials out of the scan.
        const contextSource = hook === "context" ? stripSetupPlaceholders(text).slice(0, 16000) : "";
        const source = [...new Set([contextSource, opening].filter(Boolean))].join("\n");
        const setupMain = findSetupName("main");
        if (!source.trim() && !setupMain) return;
        const unquoted = value => String(value).replace(/["“][^"”]{0,1200}["”]/g, " ");
        const narrative = unquoted(opening || contextSource);
        const evidenceText = unquoted(source);
        const candidates = [];
        const excluded = new Set([...genericPlayerNames, "she", "he", "they", "we", "it", "her", "his", "their", "our",
            "the", "then", "now", "there", "here", "everyone", "someone", "nobody", "nothing", "story", "name"]);
        const excludeName = name => {
            const agent = buildDiscoveredAgent(name);
            if (agent) for (const alias of agent.aliases) excluded.add(alias);
        };
        excludeName(config.player);
        const playerHeaders = /^(?:player|player character|protagonist|main character|you|user)$/i;
        const npcHeaders = /^(?:main npc|important npc|primary npc|npc|companion|ally|rival|antagonist|mentor|handler|inner presence|presence|love interest|partner|sidekick|supporting character)$/i;
        const blocks = extractScenarioBlocks(evidenceText);
        for (const block of blocks) {
            const name = getNamedField(block.body);
            if (name && !npcHeaders.test(block.header.trim())) excludeName(name);
        }
        const detectedPlayer = findPlayerNameInText(source);
        if (detectedPlayer) excludeName(detectedPlayer);
        // Character cards supply candidate identities, not registrations. Ignore
        // translation copies and disqualify known places/organizations as people.
        for (const item of storyCards) {
            if (!item || /^(?:character|translation|brain)$/i.test(item.type || "")) continue;
            if (item.title) excluded.add(item.title.trim().toLowerCase());
            for (const alias of String(item.keys || "").split(",")) {
                if (alias.trim()) excluded.add(alias.trim().toLowerCase());
            }
        }
        const addCandidate = (rawName, fromCard = false) => {
            const agent = buildDiscoveredAgent(rawName);
            if (!agent || excluded.has(agent.name.toLowerCase()) || excluded.has(agent.fullName.toLowerCase())) return null;
            const exact = candidates.find(item => item.agent.fullName.toLowerCase() === agent.fullName.toLowerCase());
            if (exact) return exact;
            if (!fromCard) {
                const matches = candidates.filter(item => item.agent.aliases.includes(agent.fullName.toLowerCase()));
                if (matches.length > 1) return null; // An ambiguous first name is not an identity.
                if (matches.length === 1) return matches[0];
            }
            if (candidates.length >= 64) return null;
            const item = { agent, hint: 0, primary: false, relationship: false, card: fromCard };
            candidates.push(item);
            return item;
        };
        for (const item of storyCards) {
            if (!item || String(item.type || "").toLowerCase() !== "character") continue;
            const candidate = addCandidate(item.title, true);
            if (!candidate) continue;
            for (const alias of String(item.keys || "").split(",")) {
                const clean = cleanPlayerName(alias);
                if (clean && /^[A-Z]/.test(clean) && !excluded.has(clean.toLowerCase()) &&
                    !candidate.agent.aliases.includes(clean.toLowerCase())) candidate.agent.aliases.push(clean.toLowerCase());
            }
        }
        const hint = (rawName, score, primary = false) => {
            const candidate = addCandidate(rawName);
            if (!candidate) return;
            candidate.hint = Math.max(candidate.hint, score);
            candidate.primary ||= primary;
        };
        if (setupMain) {
            const candidate = addCandidate(setupMain);
            if (candidate) {
                candidate.primary = true;
                candidate.setup = true;
            }
        }
        for (const block of blocks) {
            if (playerHeaders.test(block.header.trim()) || !npcHeaders.test(block.header.trim())) continue;
            const name = getNamedField(block.body);
            if (name) hint(name, 90, /^(?:main npc|primary npc)$/i.test(block.header.trim()));
        }
        const npcPatterns = [
            { regex: /\bthe person who finds you is\s+([A-Za-z][A-Za-z0-9_' -]{1,40})/ig, score: 80 },
            { regex: /\b(?:main|primary)\s+(?:npc|companion)\s+(?:name\s*)?(?:is|:)\s+([A-Za-z][A-Za-z0-9_' -]{1,40})/ig, score: 90, primary: true },
            { regex: /\bopen only when\s+([A-Za-z][A-Za-z0-9_' -]{1,40})\s+arrives?\b/ig, score: 50 }
        ];
        for (const item of npcPatterns) {
            let match;
            while ((match = item.regex.exec(evidenceText)) !== null) hint(match[1], item.score, item.primary);
        }
        const properName = "[A-Z][A-Za-z0-9_'-]*(?:[ \\t]+[A-Z][A-Za-z0-9_'-]*){0,2}";
        const relations = [
            new RegExp(`\\b[Yy]ou and (${properName})\\s+(?:grew up together|fell in love|are married|have been together|have known each other)\\b`, "g"),
            new RegExp(`\\b[Yy]our (?:partner|wife|husband|girlfriend|boyfriend|spouse|companion) (?:is|is named|is called) (${properName})(?=[.,;!\\n]|$)`, "g"),
            new RegExp(`\\b(${properName}) is your (?:partner|wife|husband|girlfriend|boyfriend|spouse|companion)\\b`, "g")
        ];
        for (const pattern of relations) {
            let match;
            while ((match = pattern.exec(evidenceText)) !== null) {
                const candidate = addCandidate(match[1]);
                if (candidate) candidate.relationship = true;
            }
        }
        // Seed ordinary prose only from named subjects, never all capitalized words.
        const verbs = "(?:is|was|has|had|gave|gives?|steps?|walks?|looks?|says?|asks?|replies?|answers?|turns?|watches?|waits?|moves?|leans?|smiles?|laughs?|frowns?|whispers?|shouts?|raises?|shrugs?|picks?|greets?|nods?|arrives?|leaves?|promises?)";
        const subjects = new RegExp(`(?:^|[.!?]\\s+|\\n)[ \\t]*(?:Then )?(${properName})\\s+${verbs}\\b`, "g");
        let subject;
        while ((subject = subjects.exec(narrative)) !== null) addCandidate(subject[1]);
        for (const candidate of candidates) {
            const aliases = candidate.agent.aliases.filter(alias => !candidates.some(other =>
                other !== candidate && other.agent.aliases.includes(alias)));
            const names = aliases.sort((a, b) => b.length - a.length).map(escapeRegex).join("|");
            const mentions = names ? new RegExp(`(?:^|[^A-Za-z0-9_])(?:${names})(?=$|[^A-Za-z0-9_])`, "gi") : null;
            const actions = names ? new RegExp(`(?:^|[^A-Za-z0-9_])(?:${names})\\s+${verbs}\\b`, "gi") : null;
            candidate.mentions = mentions ? (narrative.match(mentions) || []).length : 0;
            candidate.actions = actions ? (narrative.match(actions) || []).length : 0;
            candidate.score = (candidate.setup ? 600 : candidate.primary ? 300 : candidate.hint) + (candidate.relationship ? 80 : 0) +
                Math.min(12, candidate.mentions) * 4 + Math.min(6, candidate.actions) * 10;
        }
        const totalMentions = candidates.reduce((sum, item) => sum + item.mentions, 0);
        const ranked = candidates.filter(item => item.primary || item.hint >= 80 ||
            (item.hint >= 50 && item.actions > 0) ||
            (hook === "context" && ((item.relationship && item.mentions >= 1 && item.actions > 0) ||
                (item.mentions >= 5 && item.actions >= 3 && item.mentions >= totalMentions * 0.55))))
            .sort((a, b) => Number(b.primary) - Number(a.primary) || b.score - a.score);
        const winner = ranked[0];
        if (!winner || (ranked[1] && winner.primary === ranked[1].primary && winner.score - ranked[1].score < 25)) return;
        const agent = winner.agent;
        // Two people sharing a first name require the full identity as trigger.
        if (candidates.some(other => other !== winner && other.agent.name === agent.name)) {
            agent.aliases = agent.aliases.filter(alias => alias !== agent.name.toLowerCase());
            agent.name = sanitizeAgentName(agent.fullName);
        }
        const line = [agent.name, ...agent.aliases.filter(alias => alias !== agent.name.toLowerCase())].join(", ");
        const placed = upsertAgentLineInConfig(card.description, agent.name, line);
        card.description = placed.description;
        config.agents.push({ name: agent.name, aliases: agent.aliases });
        if (config.enabled) getBrainCard(agent.name);
        MF.mainNpc = {
            name: agent.name,
            reason: winner.setup ? "placeholder" : winner.primary ? "explicit" : winner.relationship ? "relationship-and-opening" : winner.hint ? "opening-introduction" : "opening-focus"
        };
        if (placed.added) bumpHealth("scenarioDiscoveries");
    };

    const getWorldCard = () => {
        let card = storyCards.find(c => c && typeof c.keys === "string" && c.keys.trim().toLowerCase() === "mindforge_world");
        if (!card) {
            const timeStr = new Date().toISOString().replace("T", " ").slice(0, 16);
            card = createStoryCard(
                "mindforge_world",
                `// MindForge World Memory initialized @ ${timeStr} UTC\n// Operation Log:\n`,
                "World",
                "MindForge World Memory",
                "",
                { returnCard: true }
            );
        }
        if (typeof card.entry !== "string") {
            card.entry = "// MindForge World Memory repaired\n// Operation Log:\n";
            bumpHealth("worldRepairs");
        }
        if (typeof card.description !== "string") {
            card.description = "";
            bumpHealth("worldRepairs");
        }
        if (typeof card.title !== "string" || !card.title.trim()) {
            card.title = "MindForge World Memory";
            bumpHealth("worldRepairs");
        }
        return card;
    };

    const getWorldKey = (name = "") => formatMemoryKey(String(name || "")
        .replace(/^(the|a|an)\s+/i, "")
        .replace(/\s+(of|the|and)$/i, "")
        .replace(/\s+/g, "_")
    );

    const worldNameIn = (source, name) => name && new RegExp(
        `(?:^|[^\\p{L}\\p{N}_])${escapeRegex(name)}(?=$|[^\\p{L}\\p{N}_])`, "iu"
    ).test(source);

    const worldFacts = (value, key) => String(value || "").split(/\s+\|\s+/)
        .map(fact => {
            const colon = fact.indexOf(":");
            // Read the old "Entity: sentence" format without repeating the name.
            return colon > 0 && getWorldKey(fact.slice(0, colon)) === key ? fact.slice(colon + 1).trim() : fact.trim();
        }).filter(Boolean);

    const getWorldMeta = () => {
        if (!MF.worldMeta || typeof MF.worldMeta !== "object" || Array.isArray(MF.worldMeta)) MF.worldMeta = {};
        return MF.worldMeta;
    };

    const extractLoreCandidates = (srcText = "", config = {}) => {
        if (!config.autoLore) return [];
        const source = String(srcText || "")
            .replace(/<SYSTEM>[\s\S]*?<\/SYSTEM>/g, " ")
            .replace(/<!--mf:[a-zA-Z0-9_]+-->/g, " ")
            .replace(/\u200B[\u200C\u200D]+\u200B/g, " ")
            .replace(/\[[+=-][^\]]+\]/g, " ");
        const banned = new Set([
            "recent", "story", "mindforge", "brain", "thoughts", "active", "present",
            "system", "continue", "configuration", "enabled", "player", "true", "false",
            "today", "tomorrow", "yesterday", "later", "meanwhile", "suddenly", "perhaps", "however",
            String(config.player || "protagonist").toLowerCase()
        ]);
        for (const agent of config.agents || []) {
            banned.add(agent.name.toLowerCase());
            for (const alias of agent.aliases || []) banned.add(String(alias).toLowerCase());
        }

        const known = getWorldMeta();
        const out = [];
        const seen = new Set();
        const sentences = source.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
        const nameRegex = /\b(?:the\s+)?[A-Z][a-zA-Z0-9']+(?:(?:\s+(?:of|the|and)\s+|\s+)[A-Z][a-zA-Z0-9']+){0,3}/g;
        for (const sentence of sentences) {
            if (sentence.length < 18 || sentence.length > 220 || !/[.!?]$/.test(sentence)) continue;
            // Public observations only: do not turn quoted, hypothetical or private
            // beliefs into facts on a world card.
            if (/["“”`]|^(?:If|Maybe|Perhaps|Suppose|Imagine)\b|\b(?:might|could|would|rumou?rs?|thinks?|believes?|suspects?|imagines?|dreams?|claims?)\b/i.test(sentence)) continue;
            nameRegex.lastIndex = 0;
            let match;
            while ((match = nameRegex.exec(sentence)) !== null) {
                const name = match[0].trim().replace(/^(?:the|a|an|at|in|near|inside|outside|from|beyond|through)\s+/i, "").replace(/\s+/g, " ");
                const lower = name.toLowerCase();
                if (lower.length < 4 || banned.has(lower)) continue;
                if (/^(he|she|they|you|i|we|it)$/i.test(name)) continue;
                const key = getWorldKey(name);
                if (!key || key.length < 4 || name.split(" ").some(word => banned.has(word.toLowerCase()))) continue;
                const prior = sentence.slice(0, match.index);
                const multiword = name.split(" ").filter(word => /^[A-Z]/.test(word)).length >= 2;
                if (!multiword && !known[key] && !/\b(?:at|in|to|from|near|inside|within|through)\s+(?:the\s+)?$/i.test(prior)) continue;
                const id = `${key}:${sentence}`;
                if (seen.has(id)) continue;
                seen.add(id);
                out.push({ key, name, sentence });
                if (out.length >= 8) return out;
            }
        }
        return out;
    };

    const compactWorldMemory = (world, maxKeys = 8) => {
        const keys = Object.keys(world).filter(k => k !== "background");
        if (keys.length <= maxKeys) return world;
        const meta = getWorldMeta();
        const ranked = [...keys].sort((a, b) => (meta[b]?.turn || 0) - (meta[a]?.turn || 0) || keys.indexOf(b) - keys.indexOf(a));
        const keep = new Set(ranked.slice(0, Math.max(1, maxKeys - 1)));
        const merge = keys.filter(key => !keep.has(key));
        const parts = [
            ...(world.background ? world.background.split(/\s+\|\s+/) : []),
            ...merge.flatMap(key => worldFacts(world[key], key).map(fact => `${meta[key]?.name || key.replace(/_/g, " ")}: ${fact}`))
        ];
        const retained = [];
        let size = 0;
        for (let i = parts.length - 1; i >= 0; i--) {
            if (size + parts[i].length + (retained.length ? 3 : 0) > 1600) continue;
            retained.unshift(parts[i]);
            size += parts[i].length + (retained.length > 1 ? 3 : 0);
        }
        for (const key of merge) { delete world[key]; delete meta[key]; }
        if (retained.length) world.background = retained.join(" | ");
        else delete world.background;
        bumpHealth("worldCompacts");
        return world;
    };

    const serializeWorld = (world, config = {}) => {
        compactWorldMemory(world, config.maxLoreKeys || 8);
        const lines = [];
        for (const key in world) {
            lines.push(`${key}: ${world[key]}`);
        }
        return lines.join("\n");
    };

    const updateWorldMemory = (srcText = "", config = {}, phase = "") => {
        if (!config.autoLore || !isUsableNarrative(srcText)) return;
        const candidates = extractLoreCandidates(srcText, config);
        if (candidates.length === 0) return;
        const card = getWorldCard();
        const world = deserializeBrain(card.description);
        const meta = getWorldMeta();
        const turnHash = getHistoryHash();
        let changed = false;
        for (const item of candidates) {
            const record = meta[item.key] = meta[item.key] || { name: item.name, mentions: 0 };
            if (record.hash !== turnHash) {
                record.mentions = Math.min(999, (record.mentions || 0) + 1);
                record.hash = turnHash;
                record.turn = currentTurn;
            }
            const facts = worldFacts(world[item.key], item.key);
            if (facts.some(fact => normalizeThought(fact) === normalizeThought(item.sentence))) continue;
            // Chronological observations, never a fabricated merged summary. Keep
            // the three most recent distinct complete facts for each entity.
            const value = [...facts, item.sentence].slice(-3).join(" | ");
            if (world[item.key] === value) continue;
            world[item.key] = value;
            changed = true;
        }
        if (changed) {
            card.description = serializeWorld(world, config);
            MF.health.worldWrites = (MF.health.worldWrites || 0) + 1;
            const logMsg = `// ${phase || "auto"} world memory update\n${[...new Set(candidates.map(item => item.key))].join(", ")}`;
            card.entry = `${card.entry.trim()}\n\n${logMsg}`.trim();
            if (card.entry.length > 2200) card.entry = "// Bounded World Operation Log:\n" + card.entry.split("\n\n").slice(-8).join("\n\n");
        }
        for (const key of Object.keys(meta)) if (!Object.prototype.hasOwnProperty.call(world, key)) delete meta[key];
        syncWorldCards(config, world);
    };

    const getWorldContext = (srcText = "", config = {}, hostContext = "", budget = 600) => {
        if (!config.autoLore || budget < 32) return "";
        const card = storyCards.find(c => c && typeof c.keys === "string" && c.keys.trim().toLowerCase() === "mindforge_world");
        if (!card || typeof card.description !== "string" || !card.description.trim()) return "";
        const world = deserializeBrain(card.description);
        const meta = getWorldMeta();
        const candidates = [];
        for (const key of Object.keys(world).filter(key => key !== "background")) {
            const name = meta[key]?.name || key.replace(/_/g, " ");
            if (worldNameIn(srcText, name) || worldNameIn(srcText, key)) candidates.push({ key, facts: worldFacts(world[key], key), turn: meta[key]?.turn || 0 });
        }
        for (const item of String(world.background || "").split(/\s+\|\s+/)) {
            const colon = item.indexOf(":");
            if (colon < 1 || !worldNameIn(srcText, item.slice(0, colon))) continue;
            const key = getWorldKey(item.slice(0, colon));
            if (!Object.prototype.hasOwnProperty.call(world, key)) candidates.push({ key, facts: [item.slice(colon + 1).trim()], turn: -1 });
        }
        candidates.sort((a, b) => b.turn - a.turn);
        const lines = ["# World Memory:"];
        const existing = normalizeThought(hostContext);
        for (const item of candidates.slice(0, Math.min(config.maxLoreKeys || 8, 4))) {
            const facts = item.facts.filter(fact => !existing.includes(normalizeThought(fact)));
            const kept = [];
            for (let i = facts.length - 1; i >= 0; i--) {
                const trial = [...kept, facts[i]];
                const line = `- ${item.key}: ${trial.map((fact, index) => `${index ? "earlier: " : ""}${fact}`).join(" | ")}`;
                if ([...lines, line].join("\n").length <= budget) kept.push(facts[i]);
            }
            if (kept.length) lines.push(`- ${item.key}: ${kept.map((fact, index) => `${index ? "earlier: " : ""}${fact}`).join(" | ")}`);
        }
        return lines.length > 1 ? lines.join("\n") : "";
    };

    const syncWorldCards = (config, suppliedWorld) => {
        const active = config.enabled && config.autoLore && config.worldCards;
        const source = storyCards.find(card => card && card.keys === "mindforge_world");
        const world = suppliedWorld || deserializeBrain(source?.description || "");
        const meta = getWorldMeta();
        const marker = /^\/\/ MindForge World Card: ([a-z0-9_]+)\n\/\/ Snapshot: ([a-f0-9]+)/;
        const signature = card => hashText(JSON.stringify([card.keys, card.entry, card.title, card.type])).toString(16);
        const stamp = (card, key) => { card.description = `// MindForge World Card: ${key}\n// Snapshot: ${signature(card)}\n// Public observations, oldest first. Editing this card pauses automatic updates.`; };
        const managed = new Map();
        for (const card of storyCards) {
            const match = card && String(card.description || "").match(marker);
            if (!match) continue;
            managed.set(match[1], card);
            if (match[2] !== signature(card)) continue; // Creator edits take precedence.
            if ((!active || !world[match[1]]) && card.keys) {
                card.keys = "";
                stamp(card, match[1]);
            }
        }
        if (!active) return;
        for (const key of Object.keys(world).filter(key => key !== "background")) {
            const record = meta[key];
            if (!record || record.mentions < 2 || !record.name) continue;
            let card = managed.get(key);
            if (card && card.description.match(marker)?.[2] !== signature(card)) continue;
            if (!card && storyCards.some(other => other && (
                String(other.title || "").trim().toLowerCase() === record.name.toLowerCase() ||
                String(other.keys || "").split(",").some(trigger => trigger.trim().toLowerCase() === record.name.toLowerCase())
            ))) continue;
            const entry = `Public observations (oldest first):\n${worldFacts(world[key], key).join("\n")}`;
            if (!card) {
                card = createStoryCard(record.name, entry, "World", record.name, "");
                bumpHealth("worldCardsCreated");
            } else if (card.entry === entry && card.keys === record.name) continue;
            card.keys = record.name;
            card.entry = entry;
            stamp(card, key);
        }
    };

    // Read the configuration story card, creating it on first run.
    const parseConfig = () => {
        const config = {
            enabled: false,
            player: "auto",
            pov: 2,
            chance: 60,
            halfChance: true,
            contextPct: 18,
            lookback: 5,
            pin: false,
            indicator: true,
            decay: 3,
            json: false,
            profile: "balanced",
            transport: "context",
            scenarioDiscovery: true,
            guardBuffer: 600,
            maxAgents: 2,
            zwspLabels: true,
            rotation: true,
            reflectionChance: 20,
            steward: true,
            agenticCharter: true,
            autoDoctor: true,
            bootstrap: true,
            autoLore: false,
            worldCards: false,
            memorySlots: true,
            qualityGate: true,
            maxBrainKeys: 14,
            maxLoreKeys: 8,
            agents: []
        };

        let card = MindForgeConfigCard();
        if (!card) {
            card = createStoryCard(
                "mindforge_config",
                defaultConfigEntry,
                "class",
                "🧩 Configure MindForge",
                "NPC Names (first name followed by optional comma-separated aliases):\n",
                { returnCard: true }
            );
        }
        migrateConfigCard(card);

        // Parse Entry settings
        const lines = (card.entry || "").split("\n");
        for (const line of lines) {
            const parts = line.split(":");
            if (parts.length < 2) continue;
            const key = parts[0].trim().toLowerCase();
            const val = parts[1].trim();

            if (key === "enabled") config.enabled = val.toLowerCase() === "true";
            else if (key.includes("player name")) config.player = val || "protagonist";
            else if (key.includes("pov")) config.pov = clampInt(val, 2, 1, 3);
            else if (key.includes("model profile")) config.profile = ["stable", "balanced", "full"].includes(val.toLowerCase()) ? val.toLowerCase() : "balanced";
            else if (key.includes("memory transport")) config.transport = val.toLowerCase() === "frontmemory" ? "frontmemory" : "context";
            else if (key.includes("scenario auto") || key.includes("auto-discovery") || key.includes("auto discovery")) config.scenarioDiscovery = val.toLowerCase() !== "false";
            else if (key.includes("thought chance") && !key.includes("half")) config.chance = clampInt(val, 60, 0, 100);
            else if (key.includes("half thought chance") || key.includes("half chance")) config.halfChance = val.toLowerCase() === "true";
            else if (key.includes("max brain context") || key === "context") config.contextPct = clampInt(val, 25, 1, 95);
            else if (key.includes("context guard")) config.guardBuffer = clampInt(val, 600, 200, 3000);
            else if (key.includes("lookback")) config.lookback = clampInt(val, 5, 1, 20);
            else if (key.includes("max active")) config.maxAgents = clampInt(val, 3, 1, 5);
            else if (key.includes("pin config")) config.pin = val.toLowerCase() === "true";
            else if (key.includes("visual indicator")) {
                const lowerVal = val.toLowerCase();
                if (lowerVal === "false") {
                    config.indicator = false;
                } else if (lowerVal === "true") {
                    config.indicator = true;
                } else {
                    config.indicator = val;
                }
            }
            else if (key.includes("volatile decay")) config.decay = clampInt(val, 3, 1, 10);
            else if (key.includes("use json format") || key.includes("json format")) config.json = val.toLowerCase() === "true";
            else if (key.includes("zwsp") || key.includes("thought label")) config.zwspLabels = val.toLowerCase() !== "false";
            else if (key.includes("brain rotation")) config.rotation = val.toLowerCase() !== "false";
            else if (key.includes("self reflection")) config.reflectionChance = clampInt(val, 20, 0, 100);
            else if (key.includes("brain steward")) config.steward = val.toLowerCase() !== "false";
            else if (key.includes("agentic charter")) config.agenticCharter = val.toLowerCase() !== "false";
            else if (key.includes("auto doctor")) config.autoDoctor = val.toLowerCase() !== "false";
            else if (key.includes("bootstrap empty") || key.includes("empty brain")) config.bootstrap = val.toLowerCase() !== "false";
            else if (key.includes("world memory") || key.includes("auto lore")) config.autoLore = val.toLowerCase() !== "false";
            else if (key.includes("world cards")) config.worldCards = val.toLowerCase() === "true";
            else if (key.includes("memory slot")) config.memorySlots = val.toLowerCase() !== "false";
            else if (key.includes("quality gate")) config.qualityGate = val.toLowerCase() !== "false";
            else if (key.includes("max brain keys")) config.maxBrainKeys = clampInt(val, 14, 3, 20);
            else if (key.includes("max lore keys")) config.maxLoreKeys = clampInt(val, 8, 3, 30);
        }
        config.player = resolvePlayerName(config.player);

        if (config.profile === "stable") {
            config.chance = Math.min(config.chance, 35);
            config.contextPct = Math.min(config.contextPct, 14);
            config.maxAgents = Math.min(config.maxAgents, 1);
            config.reflectionChance = 0;
            config.maxBrainKeys = Math.min(config.maxBrainKeys, 8);
        } else if (config.profile === "full") {
            config.maxAgents = Math.max(config.maxAgents, 3);
            config.maxBrainKeys = Math.max(config.maxBrainKeys, 14);
        }

        // Parse Description NPC Names and Aliases
        const descLines = (card.description || "").split("\n");
        for (const line of descLines) {
            const clean = line.trim();
            if (clean === "" || clean.toLowerCase().startsWith("npc names") || clean.startsWith("//") || clean.startsWith(">")) {
                continue;
            }
            const parts = clean.split(",").map(p => p.trim()).filter(Boolean);
            if (parts.length > 0) {
                const name = parts[0].replace(/[^a-zA-Z0-9_]/g, "");
                if (name) {
                    const aliases = parts.map(p => p.toLowerCase());
                    if (!config.agents.some(a => a.name === name)) {
                        config.agents.push({ name, aliases });
                    }
                }
            }
        }
        // Scan for existing Brain cards to register them as agents
        const seenBrainAgents = {};
        for (const c of storyCards) {
            if (c && typeof c.keys === "string" && c.keys.includes('"agent"')) {
                try {
                    const meta = JSON.parse(c.keys);
                    if (meta && typeof meta.agent === "string") {
                        const name = sanitizeAgentName(meta.agent);
                        if (!name) continue;
                        if (config.enabled) repairBrainCard(c, name);
                        if (seenBrainAgents[name] && seenBrainAgents[name] !== c) {
                            if (!config.enabled) continue;
                            meta.agent = name;
                            meta.enabled = false;
                            meta.duplicate = true;
                            c.keys = JSON.stringify(meta);
                            if (typeof c.title === "string" && !c.title.includes("(disabled duplicate)")) {
                                c.title = `${c.title} (disabled duplicate)`;
                            }
                            bumpHealth("brainRepairs");
                            continue;
                        }
                        seenBrainAgents[name] = c;
                        if (!config.agents.some(a => a.name === name)) {
                            config.agents.push({ name, aliases: [name.toLowerCase()] });
                        }
                    }
                } catch {}
            }
        }

        // Auto-detect shorthand and marker cards, then create brain cards silently.
        for (const c of storyCards) {
            const name = getAutoNpcName(c);
            if (name) {
                if (config.enabled && c.title.trim().startsWith("@")) {
                    c.title = name; // Clean up the title by stripping the '@'
                }
                // Pre-create brain card immediately to persist its registration.
                if (config.enabled) getBrainCard(name);
                if (!config.agents.some(a => a.name === name)) {
                    config.agents.push({ name, aliases: [name.toLowerCase()] });
                }
            }
        }

        // Explicit registrations (config, existing brains, and marked cards)
        // are authoritative. Discovery can fill only an otherwise empty cast.
        discoverScenarioAgents(config, card);
        return { config, card };
    };

    // Remove the active marker from a story card title.
    const deindicate = (card) => {
        if (!card || typeof card.title !== "string") return;
        const idx = card.title.indexOf("\u200B");
        if (idx !== -1) {
            card.title = card.title.slice(idx + 1).trim();
        }
    };

    // Clear active markers from all story card titles.
    const deindicateAll = () => {
        for (const card of storyCards) {
            deindicate(card);
        }
    };

    // Last non-empty player/model action.
    const getPrevAction = () => {
        for (let i = history.length - 1; i >= 0; i--) {
            const act = history[i];
            if (act) {
                const txt = act.text || act.rawText || "";
                if (txt && !/^[\u200B-\u200D\s]*$/.test(txt)) {
                    return act;
                }
            }
        }
        return null;
    };

    // Parse brain card notes in JSON or simple key/value format.
    const deserializeBrain = (descText) => {
        const brain = {};
        if (!descText) return brain;

        const trimmed = descText.trim();
        if (trimmed.startsWith("{")) {
            try {
                const obj = JSON.parse(trimmed);
                if (obj && typeof obj === "object" && !Array.isArray(obj)) {
                    for (const k in obj) {
                        if (typeof obj[k] === "string") brain[k] = obj[k];
                    }
                    return brain;
                }
            } catch {
                // Robust regex fallback recovery for malformed JSON
                const kvRegex = /"([^"\\]*(?:\\.[^"\\]*)*)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g;
                let match;
                let foundAny = false;
                while ((match = kvRegex.exec(trimmed)) !== null) {
                    const key = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim().replace(/[^a-zA-Z0-9_()]/g, "");
                    const val = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
                    if (key && val) {
                        brain[key] = val;
                        foundAny = true;
                    }
                }
                if (foundAny) return brain;
            }
        }

        const lines = descText.split("\n");
        for (const line of lines) {
            const clean = line.trim();
            if (clean === "" || clean.startsWith("//") || clean.startsWith("#")) continue;

            const colonIdx = clean.indexOf(":");
            if (colonIdx === -1) continue;

            const key = clean.slice(0, colonIdx).trim().replace(/[^a-zA-Z0-9_()]/g, "");
            const val = clean.slice(colonIdx + 1).trim();
            if (key && val) brain[key] = val;
        }
        return brain;
    };

    // Remove a key by base name, ignoring volatile decay counters.
    const removeFromBrain = (brain, baseKey, options = {}) => {
        let deleted = false;
        const cleanBase = cleanComparableKey(baseKey);
        for (const key in brain) {
            if (!options.allowCore && isCoreKey(key)) continue;
            const currentClean = cleanComparableKey(key);
            if (currentClean === cleanBase) {
                delete brain[key];
                deleted = true;
            }
        }
        return deleted;
    };

    const compactDuplicateBrain = (brain, agentName = "") => {
        const seen = {};
        let modified = false;
        for (const key of Object.keys(brain)) {
            if (key === "background" || isCoreKey(key) || isVolatileKey(key)) continue;
            const normalized = normalizeThought(brain[key]);
            if (!normalized || normalized.length < 24) continue;
            if (seen[normalized]) {
                const currentScore = scoreThought(agentName, key, brain[key]);
                const keptScore = scoreThought(agentName, seen[normalized], brain[seen[normalized]]);
                const dropKey = currentScore <= keptScore ? key : seen[normalized];
                if (dropKey === seen[normalized]) {
                    seen[normalized] = key;
                }
                delete brain[dropKey];
                removeLabelsForKey(agentName, dropKey);
                forgetMemoryMeta(agentName, dropKey);
                modified = true;
            } else {
                seen[normalized] = key;
            }
        }
        if (modified) bumpHealth("smartMerges");
        return brain;
    };

    // Fold weak non-core thoughts into background when the brain gets noisy.
    const consolidateBrain = (brain, maxKeys = 6, agentName = "") => {
        compactDuplicateBrain(brain, agentName);
        const keys = Object.keys(brain).filter(k => k !== "background" && !isVolatileKey(k) && !isCoreKey(k));
        if (keys.length <= maxKeys) return brain;

        const scored = keys
            .map((key, order) => ({ key, order, score: scoreThought(agentName, key, brain[key]) }))
            .sort((a, b) => (b.score - a.score) || (a.order - b.order));
        const keep = new Set(scored.slice(0, Math.max(1, maxKeys - 1)).map(item => item.key));
        const keysToMerge = keys.filter(key => !keep.has(key));

        if (keysToMerge.length === 0) return brain;

        let backgroundText = brain.background ? brain.background + "; " : "";
        const mergedParts = [];
        for (const k of keysToMerge) {
            mergedParts.push(`${cleanKeyForLLM(k)} is ${brain[k]}`);
            delete brain[k];
            removeLabelsForKey(agentName, k);
            forgetMemoryMeta(agentName, k);
        }
        backgroundText += mergedParts.join("; ");
        brain.background = backgroundText.slice(-1200);
        bumpHealth("smartPrunes");
        return brain;
    };

    // Write brain notes back in the selected storage format.
    const serializeBrain = (brain, agentName = "") => {
        const maxKeys = config ? (config.maxBrainKeys || 6) : 6;
        consolidateBrain(brain, maxKeys, agentName);
        if (config && config.json) {
            return JSON.stringify(brain, null, 2);
        }
        const lines = [];
        for (const key in brain) {
            lines.push(`${key}: ${brain[key]}`);
        }
        return lines.join("\n");
    };

    const normalizeThought = (value = "") => String(value)
        .normalize("NFC")
        .toLowerCase()
        .replace(/^\s*\d+\s*(?:[-=]*>|→)\s*/, "")
        .replace(/[’‘]/g, "'")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\.$/, "");

    const isDuplicateThought = (brain, newKey, newValue, agentName = "") => {
        const normalized = normalizeThought(newValue);
        if (!normalized) return false;
        for (const key in brain) {
            if (cleanComparableKey(key) === cleanComparableKey(newKey) && isVolatileKey(newKey)) continue;
            if (key === "background") continue;
            // Similar wording can express opposite beliefs, different actors or amounts.
            // Only discard a duplicate when the complete normalized claim matches.
            const existing = normalizePrivateThoughtPerspective(agentName, stripThoughtIndex(brain[key]));
            if (normalizeThought(existing) === normalized) return true;
        }
        return false;
    };

    const getAgentMeta = (agentName, fallback = {}) => {
        const meta = parseBrainMeta(getBrainCard(agentName)) || {};
        // Inherited settings are resolved on each turn, never persisted as overrides.
        const chanceLimit = fallback.runtimeProfile === "guarded" ? 20
            : fallback.runtimeProfile === "conservative" ? 40
            : fallback.profile === "stable" ? 35 : 100;
        const budgetLimit = fallback.runtimeProfile === "guarded" || fallback.profile === "stable" ? 14
            : fallback.runtimeProfile === "conservative" ? 20 : 95;
        return {
            ...meta,
            agent: agentName,
            enabled: meta.enabled !== false,
            budget: Math.min(budgetLimit, clampInt(meta.budget ?? meta.context, fallback.contextPct ?? 18, 1, 95)),
            chance: Math.min(chanceLimit, clampInt(meta.chance, fallback.chance ?? 60, 0, 100))
        };
    };

    // Scan recent turns for NPC names and aliases.
    const detectTriggers = (config, pendingInput = "") => {
        if (!config.agents || config.agents.length === 0) return [];

        const commonLowercaseNames = new Set([
            "may", "will", "mark", "rose", "hope", "faith", "grace", "summer", "autumn",
            "april", "june", "august", "chase", "grant", "raven", "sage", "joy"
        ]);
        const isAsciiLetter = (code) => (65 <= code && code <= 90) || (97 <= code && code <= 122);
        const requiresCapital = (agent, alias) => (
            alias === agent.name.toLowerCase() &&
            /[A-Z]/.test(agent.name) &&
            (alias.length <= 4 || commonLowercaseNames.has(alias))
        );
        const findAlias = (source, alias, strictCapital) => {
            const lower = source.toLowerCase();
            for (let idx = lower.lastIndexOf(alias); idx !== -1; idx = idx > 0 ? lower.lastIndexOf(alias, idx - 1) : -1) {
                const before = idx > 0 ? lower.charCodeAt(idx - 1) : 0;
                const after = idx + alias.length < lower.length ? lower.charCodeAt(idx + alias.length) : 0;
                if (isAsciiLetter(before) || isAsciiLetter(after)) continue;
                if (strictCapital && source[idx] !== source[idx].toUpperCase()) continue;
                return idx;
            }
            return -1;
        };

        const lookback = config.lookback || 5;
        // Use the same bounded name window in Input and Context. The pending
        // player action takes one slot, just as it does once added to history.
        const scan = lookback * 3;
        const actions = pendingInput ? [...history.slice(-(scan - 1)), { text: pendingInput }] : history;
        const startIdx = Math.max(0, actions.length - scan);
        const foundAgents = [];

        for (let i = actions.length - 1; i >= startIdx; i--) {
            const action = actions[i];
            if (!action) continue;
            const actionText = action.text || action.rawText || "";
            if (typeof actionText !== "string" || actionText.trim() === "") continue;

            const lines = actionText.split("\n");
            const cleanLines = [];
            for (const line of lines) {
                if (line.includes(">>>") || line.includes("<<<")) continue;
                cleanLines.push(line);
            }
            const source = cleanLines.join("\n");
            const foundInTurn = [];

            for (const agent of config.agents) {
                let latest = -1;
                for (const alias of agent.aliases) {
                    const aliasLower = alias.toLowerCase();
                    const idx = findAlias(source, aliasLower, requiresCapital(agent, aliasLower));
                    latest = Math.max(latest, idx);
                }
                if (latest !== -1) foundInTurn.push({ name: agent.name, idx: latest });
            }

            if (foundInTurn.length > 0) {
                foundInTurn.sort((a, b) => b.idx - a.idx);
                for (const item of foundInTurn) {
                    if (!foundAgents.includes(item.name)) {
                        foundAgents.push(item.name);
                    }
                }
            }
        }
        return foundAgents.slice(0, config.maxAgents || 3);
    };

    const recentHistoryMentionsAgent = (config, agentName) => {
        const agent = (config.agents || []).find(a => a.name.toLowerCase() === String(agentName || "").toLowerCase());
        if (!agent) return false;
        const lookback = config.lookback || 5;
        const source = history
            .slice(Math.max(0, history.length - lookback))
            .map(action => action && (action.text || action.rawText || ""))
            .filter(Boolean)
            .join("\n")
            .split("\n")
            .filter(line => !line.includes(">>>") && !line.includes("<<<"))
            .join("\n");
        for (const alias of agent.aliases || []) {
            try {
                if (new RegExp(`\\b${escapeRegex(alias)}\\b`, "i").test(source)) return true;
            } catch {
                if (source.toLowerCase().includes(String(alias || "").toLowerCase())) return true;
            }
        }
        return false;
    };

    // Read legacy HTML memory tags from older outputs.
    const scanMemoryTags = (srcText, limit = 5) => {
        const keys = [];
        const regex = /<!--mf:([a-zA-Z0-9_]+)-->/g;
        let match;
        while ((match = regex.exec(srcText)) !== null) {
            keys.push(match[1]);
        }
        return [...new Set(keys.reverse())].slice(0, limit);
    };

    // Decrement temporary memories stored as _key(n).
    const decayVolatileMemories = (brain, isRetry, decayTurns = 3) => {
        if (isRetry) return { brain, modified: false };
        let modified = false;
        for (const key in brain) {
            if (key.startsWith("_")) {
                const match = key.match(/^_(.+)\((\d+)\)$/);
                if (match) {
                    const baseKey = match[1];
                    const turns = parseInt(match[2]) - 1;
                    const val = brain[key];
                    delete brain[key];
                    if (turns > 0) {
                        brain[`_${baseKey}(${turns})`] = val;
                    }
                    modified = true;
                } else {
                    const val = brain[key];
                    delete brain[key];
                    const nextTurns = decayTurns - 1;
                    if (nextTurns > 0) {
                        brain[`_${key.slice(1)}(${nextTurns})`] = val;
                    }
                    modified = true;
                }
            }
        }
        return { brain, modified };
    };

    // Hide storage-only key syntax before injecting thoughts.
    const cleanKeyForLLM = (key) => {
        let clean = key;
        if (clean.startsWith("_")) {
            clean = clean.slice(1);
        }
        const parenIdx = clean.indexOf("(");
        if (parenIdx !== -1) {
            clean = clean.slice(0, parenIdx);
        }
        return clean;
    };

    const encodeLabel = (label) => {
        let n = Math.max(0, parseInt(label, 10) || 0);
        let bits = "";
        do {
            bits = `${(n & 1) ? "\u200D" : "\u200C"}${bits}`;
            n >>>= 1;
        } while (n > 0);
        return `\u200B${bits}\u200B`;
    };

    const getLabelStore = (agentName) => {
        MF.labels[agentName] = MF.labels[agentName] || {};
        return MF.labels[agentName];
    };

    const ensureThoughtLabel = (agentName, key) => {
        const labels = getLabelStore(agentName);
        if (!Number.isInteger(labels[key])) {
            MF.labelSeq++;
            labels[key] = MF.labelSeq;
        }
        return labels[key];
    };

    const removeLabelsForKey = (agentName, baseKey) => {
        const labels = getLabelStore(agentName);
        const target = cleanComparableKey(baseKey);
        for (const key in labels) {
            if (cleanComparableKey(key) === target) {
                delete labels[key];
            }
        }
    };

    const moveLabelForKey = (agentName, oldKey, newKey) => {
        const labels = getLabelStore(agentName);
        const label = labels[oldKey];
        removeLabelsForKey(agentName, newKey);
        if (Number.isInteger(label)) {
            labels[newKey] = label;
            delete labels[oldKey];
            return label;
        }
        return ensureThoughtLabel(agentName, newKey);
    };

    const decodeThoughtLabels = (srcText, activeAgents) => {
        const labelMap = new Map();
        for (const agentName of activeAgents || []) {
            const labels = MF.labels[agentName] || {};
            for (const key in labels) {
                labelMap.set(labels[key], key);
            }
        }

        const keys = [];
        const textWithLabels = srcText.replace(/\u200B([\u200C\u200D]+)\u200B/g, (match, encoded) => {
            let n = 0;
            for (const char of encoded) {
                n = (n << 1) | (char === "\u200D" ? 1 : 0);
            }
            const key = labelMap.get(n);
            if (!key) return "";
            keys.push(key);
            return `[${n}]`;
        });

        return { text: textWithLabels, keys: [...new Set(keys)] };
    };

    const allocateBudgets = (total, count) => {
        if (count <= 1) return [total];
        const primary = Math.max(120, Math.floor(total * 0.5));
        const remaining = Math.max(0, total - primary);
        const present = Math.max(80, Math.floor(remaining / (count - 1)));
        return [primary, ...Array(count - 1).fill(present)];
    };

    const rotateArray = (items, seed) => {
        if (!items.length) return items;
        const offset = seed % items.length;
        return [...items.slice(offset), ...items.slice(0, offset)];
    };

    const rankThoughtsForContext = (agentName, brain, sourceText, recentTags, seed, useRotation) => {
        const scored = Object.keys(brain).map((key, order) => {
            const tier = classifyMemoryKey(key);
            return {
                key,
                val: brain[key],
                tier,
                order,
                score: scoreThought(agentName, key, brain[key], sourceText, recentTags)
            };
        });
        const pinned = scored
            .filter(item => item.tier !== "normal" || item.score >= 135)
            .sort((a, b) => (b.score - a.score) || (a.order - b.order));
        const regular = scored
            .filter(item => item.tier === "normal" && item.score < 135)
            .sort((a, b) => a.order - b.order);
        return [...pinned, ...(useRotation ? rotateArray(regular, seed) : regular)];
    };

    const prepareFrontMemory = (config) => {
        MF.frontMemory = null;
        MF.frontStatus = "context";
        if (config.transport !== "frontmemory") return;
        const memory = state.memory;
        if (memory !== undefined && (!memory || typeof memory !== "object" || Array.isArray(memory))) {
            MF.frontStatus = "unavailable";
            return;
        }
        const existing = memory?.frontMemory;
        if (existing !== undefined && typeof existing !== "string") {
            MF.frontStatus = "unavailable";
            return;
        }
        if (existing && existing.includes("<!--mf-front:")) {
            MF.frontStatus = "conflict";
            return;
        }
        let names = detectTriggers(config, text).filter(name => getAgentMeta(name, config).enabled);
        if (MF.scene.ttl > 0 && names.includes(MF.scene.agent)) {
            names = [MF.scene.agent, ...names.filter(name => name !== MF.scene.agent)];
        }
        const agent = names[0];
        const card = agent && storyCards.find(item => parseBrainMeta(item)?.agent === agent);
        if (!card) { MF.frontStatus = "no-memory"; return; }
        const brain = deserializeBrain(card.description);
        const stats = MF.contextStats;
        // Input has no maxChars. Use a small initial cap, then the last observed
        // spare room; Context still verifies the actual assembled input.
        const priorRoom = Number.isFinite(stats?.maxChars) && Number.isFinite(stats?.inputChars)
            ? Math.max(0, stats.maxChars - stats.inputChars + (stats.frontMemoryChars || 0) - 160) : 320;
        const cap = Math.min(600, priorRoom);
        const id = hashText(`${getHistoryHash()}:${agent}:front`).toString(16);
        const open = `<!--mf-front:${id}-->`;
        const close = `<!--/mf-front:${id}-->`;
        const header = `# ${agent} private:`;
        const render = items => `${open}\n${header}\n${items.map(item => `- ${cleanKeyForLLM(item.key)}: ${item.value}`).join("\n")}\n${close}`;
        const scene = `${history.slice(-3).map(action => action?.text || "").join("\n")}\n${text}`;
        const items = [];
        const ranked = rankThoughtsForContext(agent, brain, scene, [], hashText(id), config.rotation);
        for (const item of ranked) {
            // Volatile state may expire at Context; never stage that in a field
            // that the host can assemble before decay has run.
            if (isVolatileKey(item.key)) continue;
            const value = stripThoughtIndex(item.val);
            if (!value || /[\r\n]|<!--\/?mf-front:/.test(value)) continue;
            const candidate = { key: item.key, value };
            if (render([...items, candidate]).length <= cap) items.push(candidate);
        }
        if (!items.length) { MF.frontStatus = "no-room"; return; }
        const frame = render(items);
        const separator = existing ? "\n\n" : "";
        const lease = {
            version: 1, agent, turn: currentTurn, frame, open, close, separator, items,
            hadFront: !!memory && Object.prototype.hasOwnProperty.call(memory, "frontMemory"),
            createdMemory: memory === undefined, delivered: false, outputHandled: false
        };
        // Do not assign state.memory wholesale: preserve authorsNote/context and
        // every other script's fields, including frontMemory's existing text.
        if (memory === undefined) state.memory = {};
        state.memory.frontMemory = `${existing || ""}${separator}${frame}`;
        MF.frontMemory = lease;
        MF.frontStatus = "prepared";
    };

    const getBrainStats = (brain) => {
        const keys = Object.keys(brain);
        const normalKeys = keys.filter(k => k !== "background" && !isVolatileKey(k) && !isCoreKey(k));
        const tiers = {};
        for (const key of keys) {
            const tier = classifyMemoryKey(key);
            tiers[tier] = (tiers[tier] || 0) + 1;
        }
        return { keys, normalKeys, tiers };
    };

    const getLastWriteAge = (agentName) => {
        const turn = MF.lastWrite && MF.lastWrite[agentName];
        return Number.isInteger(turn) ? Math.max(0, currentTurn - turn) : Infinity;
    };

    const getSlotGuidance = (agentName, config) => {
        if (!config.memorySlots) return "";
        const playerKey = formatMemoryKey(config.player || "player");
        return `Slots: relationship_${playerKey}, goal_current, plan_next, secret_hidden; _state_current expires.`;
    };

    const getAgenticCharter = (agentName, config) => {
        if (!config.agenticCharter) return "";
        return `Private mind for ${agentName}: private motives, loyalties, fears and plans guide actions, not player knowledge.`;
    };

    const chooseBrainTask = (agentName, brain, config, pressure) => {
        if (!config.steward) {
            return { kind: "write", label: "write one useful thought", forcePassive: false };
        }
        const stats = getBrainStats(brain);
        if (stats.keys.length === 0 && pressure <= 0.92) {
            return { kind: "bootstrap", label: `create ${agentName}'s first durable thought`, forcePassive: false, forceChance: true };
        }
        if (pressure > 0.92 || config.runtimeProfile === "guarded") {
            return { kind: "none", label: "skip memory operation because context pressure is high", forcePassive: true };
        }
        if (stats.normalKeys.length > (config.maxBrainKeys || 14)) {
            return { kind: "prune", label: "delete or replace the weakest non-core thought", forcePassive: false };
        }
        if ((stats.tiers.relationship || 0) === 0 && stats.keys.length >= 2) {
            return { kind: "relationship", label: "update a relationship or attitude slot if the scene supports it", forcePassive: false };
        }
        if ((stats.tiers.goal || 0) === 0 && stats.keys.length >= 2) {
            return { kind: "goal", label: "update the current goal or next plan if the scene supports it", forcePassive: false };
        }
        if (config.profile === "full") {
            return { kind: "maintain", label: "choose write, update, rename, or delete based on what improves the brain most", forcePassive: false };
        }
        return { kind: "write", label: "write or update one non-duplicate thought", forcePassive: false };
    };

    const getContextLimit = (config) => {
        const max = Number.isFinite(info.maxChars) ? Math.floor(info.maxChars) : 0;
        if (max <= 0) return 0;
        return max - Math.min(config.guardBuffer || 600, Math.floor(max * 0.1));
    };

    const memoryPrefixLength = (source) => Math.min(protectedMemoryEnd, source.length);

    const removeOwnedFront = (owned) => {
        // Some host layouts count frontMemory in memoryLength. Removing only
        // our data must not invalidate protection of the remaining host memory.
        if (owned.start < protectedMemoryEnd) {
            protectedMemoryEnd -= Math.min(owned.end, protectedMemoryEnd) - owned.start;
        }
        return owned.text;
    };

    const frontBoundary = (source) => {
        let boundary = source.length;
        const protectedEnd = memoryPrefixLength(source);
        // The shared field may be plain text without a section heading. Protect
        // its surviving foreign content as well as our framed memory block.
        for (const value of [sharedFront, state.memory?.frontMemory, frontLease?.open]) {
            if (typeof value !== "string" || !value) continue;
            const index = source.indexOf(value, protectedEnd);
            if (index >= 0) boundary = Math.min(boundary, index);
        }
        return boundary;
    };

    const storyRegion = (source) => {
        const protectedEnd = memoryPrefixLength(source);
        // A heading inside the host's memory is not a safe place to trim story.
        const header = /(?:^|\n)Recent Story:[ \t]*\r?\n?/.exec(source.slice(protectedEnd));
        if (!header && !protectedEnd) return { start: 0, end: 0, length: 0 };
        const start = header ? protectedEnd + header.index + header[0].length : protectedEnd;
        const next = /(?:^|\n)(?:Memories:|World Lore:|Plot Essentials:|Story Summary:|AI Instructions:|\[Author's note:|<!--mf-front:)/.exec(source.slice(start));
        const end = Math.max(start, Math.min(next ? start + next.index : source.length, frontBoundary(source)));
        return { start, end, length: end - start };
    };

    const trimOldStory = (source, count) => {
        const region = storyRegion(source);
        const remove = Math.min(Math.max(0, count), region.length);
        return source.slice(0, region.start) + source.slice(region.start + remove);
    };

    const contextBudget = (source, config, cacheMode) => {
        const max = Number.isFinite(info.maxChars) ? Math.max(0, Math.floor(info.maxChars)) : source.length;
        const limit = cacheMode ? Math.max(0, max - 160) : getContextLimit(config);
        let base = source;
        const protectedChars = memoryPrefixLength(source);
        const protectedTailChars = source.length - frontBoundary(source);
        if (protectedChars + protectedTailChars > max) {
            // The host itself supplied a protected prefix larger than its limit.
            // Do not destroy that prefix to make room for our own additions.
            return { base, available: 0, limit, max, protectedChars, hostOverBudget: true };
        }
        // Repair an already oversized host input independently of our additions.
        // Normal additions may only displace old Recent Story, never host rules.
        if (!cacheMode && base.length > max) {
            base = trimOldStory(base, base.length - max);
            if (base.length > max) {
                const tailLength = base.length - frontBoundary(base);
                const head = protectedChars || Math.min(Math.floor(max / 2), max - tailLength);
                base = base.slice(0, head) + (max > head ? base.slice(-(max - head)) : "");
            }
        }
        const region = storyRegion(base);
        const keep = Math.min(region.length, Math.max(160, Math.min(2000, Math.floor(limit * 0.5))));
        const removable = cacheMode ? 0 : Math.min(Math.max(0, region.length - keep), Math.floor(limit * 0.25));
        const available = Math.max(0, limit - base.length + removable);
        return { base, available, limit, max, protectedChars, hostOverBudget: source.length > max };
    };

    const hasDirectDialogPressure = () => {
        const prev = getPrevAction();
        const source = `${prev?.text || prev?.rawText || ""}\n${text || ""}`;
        return /[?"]|(?:\bask(?:s|ed|ing)?\b|\btell(?:s|ing)?\b|\bsay(?:s|ing)?\b|\bspeak(?:s|ing)?\b|\brepl(?:y|ies|ied)\b)/i.test(source);
    };

    const applyAdaptiveProfile = (config) => {
        const next = { ...config, agents: config.agents };
        const failures = (MF.health.emptyOutputs || 0) + (MF.health.skippedCommits || 0) + (MF.health.memoryOnlyOutputs || 0) + ((MF.health.errors || 0) * 2);
        const pressures = (MF.health.contextGuards || 0) + ((MF.health.loadSheds || 0) * 2);
        const hash = getHistoryHash();
        const adaptive = MF.adaptive = MF.adaptive || { hash, failures: 0, pressures: 0, failureScore: 0, pressureScore: 0 };
        const newTurn = hook === 'context' && adaptive.hash !== hash;
        adaptive.failureScore = Math.max(0, adaptive.failureScore - (newTurn ? 1 : 0)) + Math.max(0, failures - adaptive.failures);
        adaptive.pressureScore = Math.max(0, adaptive.pressureScore - (newTurn ? 1 : 0)) + Math.max(0, pressures - adaptive.pressures);
        adaptive.failures = failures;
        adaptive.pressures = pressures;
        if (hook === 'context') adaptive.hash = hash;
        const { failureScore, pressureScore } = adaptive;
        let mode = config.profile;

        if (failureScore >= 5 || pressureScore >= 6) {
            mode = "guarded";
            next.chance = Math.min(next.chance, 20);
            next.contextPct = Math.min(next.contextPct, 14);
            next.maxAgents = Math.min(next.maxAgents, 1);
            next.reflectionChance = 0;
        } else if (failureScore >= 3 || pressureScore >= 3) {
            mode = "conservative";
            next.chance = Math.min(next.chance, 40);
            next.contextPct = Math.min(next.contextPct, 20);
            next.maxAgents = Math.min(next.maxAgents, 2);
            next.reflectionChance = Math.min(next.reflectionChance, 10);
        }

        if (MF.adaptiveMode !== mode) {
            MF.adaptiveMode = mode;
            if (mode !== config.profile) {
                bumpHealth("adaptiveShifts");
            }
        }
        next.runtimeProfile = mode;
        return next;
    };

    const isUsableNarrative = (value) => {
        const clean = String(value || "")
            .replace(/<!--mf:[a-zA-Z0-9_]+-->/g, "")
            .replace(/\u200B[\u200C\u200D]+\u200B/g, "")
            .trim();
        // Cleanup has already removed protocol scaffolding. Short replies,
        // apologies and in-character refusals are valid story, too.
        return /[\p{L}\p{N}]/u.test(clean);
    };

    const compactSpacedLetters = (value = "") => String(value || "")
        .replace(/(?:\b[A-Za-z]\b[\s.?!'`"-]*){3,}/g, match => match.replace(/[^A-Za-z0-9]+/g, ""))
        .replace(/[^a-zA-Z0-9]+/g, "")
        .toLowerCase();

    const isUiChromeLeakLine = (line = "") => {
        const clean = String(line || "").replace(/[\u200B-\u200D]/g, "").trim();
        if (!clean) return false;
        const lower = clean.toLowerCase();
        const compact = compactSpacedLetters(clean);
        const isSpacedWord = /^\s*(?:[A-Za-z]\s+){2,}[A-Za-z][.!?]*\s*$/.test(clean);
        if (/(?:waiting\s*for\s*input|w_pencil|w_wand|w_retry|w_backspace|take\s*a\s*turn)/i.test(clean)) return true;
        if (compact.includes("waitingforinput")) return true;
        if (compact.includes("wpenciltakeaturn") || compact.includes("wwandcontinue") || compact.includes("wretryretry") || compact.includes("wbackspaceerase")) return true;
        if (isSpacedWord && /^(?:silence|continue|retry|erase|takeaturn)$/.test(compact)) return true;
        return false;
    };

    const stripUiChromeLeaks = (srcText = "") => {
        const lines = String(srcText || "").split("\n");
        const kept = [];
        let removed = 0;
        for (const line of lines) {
            if (isUiChromeLeakLine(line)) {
                removed++;
                continue;
            }
            kept.push(line);
        }
        return { text: kept.join("\n").trim(), removed };
    };

    const isCodeDebugLeakLine = (line = "") => {
        const clean = String(line || "").replace(/[\u200B-\u200D]/g, "").trim();
        if (!clean) return false;
        const lower = clean.toLowerCase();
        if (/^```/.test(clean)) return true;
        if (/^#{1,6}\s*(?:[-=]{3,}|.*(?:brain|internal state|scene continuation|memory operation|operation log|mindforge))/i.test(clean)) return true;
        if (/^(?:\/\/|#)\s*(?:[-=]{3,}|.*(?:brain|internal state|scene continuation|memory operation|operation log|mindforge))/i.test(clean)) return true;
        if (/^[-=]{5,}$/.test(clean)) return true;
        if (/^(?:import\s+[a-zA-Z_][\w.]*(?:\s*,\s*[a-zA-Z_][\w.]*)*|from\s+[a-zA-Z_][\w.]*\s+import\b)/.test(clean)) return true;
        if (/^(?:const|let|var)\s+[a-zA-Z_$][\w$]*\s*=/.test(clean)) return true;
        if (/^(?:function|def|class)\s+[a-zA-Z_$][\w$]*\b/.test(clean)) return true;
        if (/^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)?\s*=\s*#?\s*$/.test(clean)) return true;
        if (/^[a-zA-Z_$][\w$]*(?:_state|_brain|_memory|State|Brain|Memory)\s*=/.test(clean)) return true;
        if (/^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)?\s*=\s*(?:#|\{|\[|new\s+|function\b)/.test(clean)) return true;
        if (/^(?:brain|memory|internal state|scene continuation)\s*[:=]/i.test(clean)) return true;
        if (lower.includes("internal state") && lower.includes("brain")) return true;
        if (lower.includes("scene continuation") && /^#|^\/\//.test(clean)) return true;
        return false;
    };

    const stripCodeDebugLeaks = (srcText = "") => {
        const lines = String(srcText || "").split("\n");
        const kept = [];
        let removed = 0;
        let droppingFence = false;
        for (const line of lines) {
            const clean = String(line || "").trim();
            if (/^```/.test(clean)) {
                droppingFence = !droppingFence;
                removed++;
                continue;
            }
            if (droppingFence) {
                removed++;
                continue;
            }
            if (isCodeDebugLeakLine(line)) {
                removed++;
                continue;
            }
            kept.push(line);
        }
        return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
    };

    const isMemoryOperationLeakLine = (line = "") => {
        const clean = String(line || "").replace(/[\u200B-\u200D]/g, "").trim();
        if (!clean) return false;
        return /(?:^|[-=:\s])memory[ _-]?operation\s*[:=]/i.test(clean) || /^[-=]{1,}\s*memory[ _-]?operation\b/i.test(clean);
    };

    const stripMemoryOperationLeaks = (srcText = "") => {
        const lines = String(srcText || "").split("\n");
        const kept = [];
        let removed = 0;
        for (const line of lines) {
            if (isMemoryOperationLeakLine(line)) {
                removed++;
                continue;
            }
            kept.push(line);
        }
        return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
    };

    const isNarrativeMemoryLeak = (agentName, value = "") => {
        const clean = String(value || "").replace(/\s+/g, " ").trim();
        if (!clean) return false;
        const agent = sanitizeAgentName(agentName);
        const actor = agent ? `(?:${escapeRegex(agent)}|she|he|they)` : "(?:she|he|they)";
        if (agent && new RegExp(`^${escapeRegex(agent)}\\s+observes\\s*:`, "i").test(clean)) return true;
        if (agent && new RegExp(`^${escapeRegex(agent)}\\s+goes\\s+rigid\\b`, "i").test(clean)) return true;
        return new RegExp(`,\\s*["'\u201c\u201d]?\\s*${actor}\\s+(?:says?|asks?|echoes?|replies?|answers?|whispers?|shouts?)\\b`, "i").test(clean);
    };

    const observerVerbPattern = "(?:watch(?:es|ed)?|saw|see(?:s)?|notice(?:s|d)?|observe(?:s|d)?|look(?:s|ed)?\\s+(?:at|into|toward))";
    const privateBodyNounPattern = "(?:arms?|body|breath|chest|eyes?|face|fingers?|gaze|hands?|head|heart|jaw|lips|mouth|posture|pulse|shoulders?|stance|step|throat|voice)";

    const toFirstPersonVerb = (verb = "") => {
        const lower = String(verb || "").toLowerCase();
        const irregular = {
            am: "am",
            are: "am",
            does: "do",
            goes: "go",
            has: "have",
            is: "am",
            says: "say",
            was: "was",
            were: "was"
        };
        if (irregular[lower]) return irregular[lower];
        if (lower.endsWith("ies") && lower.length > 4) return `${lower.slice(0, -3)}y`;
        if (lower.endsWith("ches") || lower.endsWith("shes") || lower.endsWith("sses") || lower.endsWith("xes") || lower.endsWith("zes")) return lower.slice(0, -2);
        if (lower.endsWith("s") && lower.length > 3) return lower.slice(0, -1);
        return lower;
    };

    const fixFirstPersonGrammar = (value = "") => String(value || "")
        .replace(/\bI\s+doesn[’']?t\b/ig, "I don't")
        .replace(/\bI\s+does\s+not\b/ig, "I do not")
        .replace(/\bI\s+isn[’']?t\b/ig, "I am not")
        .replace(/\bI\s+is\b/ig, "I am")
        .replace(/\bI\s+aren[’']?t\b/ig, "I am not")
        .replace(/\bI\s+are\b/ig, "I am")
        .replace(/\bI\s+wasn[’']?t\b/ig, "I was not")
        .replace(/\bI\s+weren[’']?t\b/ig, "I was not")
        .replace(/\bI\s+were\b/ig, "I was")
        .replace(/\bI\s+hasn[’']?t\b/ig, "I have not")
        .replace(/\bI\s+has\b/ig, "I have")
        .replace(/\bI\s+hadn[’']?t\b/ig, "I had not")
        .replace(/\bI\s+goes\b/ig, "I go")
        .replace(/\bI\s+says\b/ig, "I say")
        .replace(/\bI\s+asks\b/ig, "I ask")
        .replace(/\bI\s+looks\b/ig, "I look")
        .replace(/\bI\s+watches\b/ig, "I watch")
        .replace(/\bI\s+keeps\b/ig, "I keep")
        .replace(/\bI\s+stays\b/ig, "I stay")
        .replace(/\bI\s+stands\b/ig, "I stand")
        .replace(/\bI\s+steps\b/ig, "I step")
        .replace(/\bI\s+stops\b/ig, "I stop")
        .replace(/\bI\s+moves\b/ig, "I move")
        .replace(/\bI\s+takes\b/ig, "I take")
        .replace(/\bI\s+touches\b/ig, "I touch")
        .replace(/\bI\s+reaches\b/ig, "I reach")
        .replace(/\bI\s+pulls\b/ig, "I pull")
        .replace(/\bI\s+holds\b/ig, "I hold")
        .replace(/\bI\s+knows\b/ig, "I know")
        .replace(/\bI\s+thinks\b/ig, "I think")
        .replace(/\bI\s+feels\b/ig, "I feel")
        .replace(/\bI\s+wants\b/ig, "I want")
        .replace(/\bI\s+needs\b/ig, "I need")
        .replace(/\bI\s+refuses\b/ig, "I refuse")
        .replace(/\bI\s+hesitates\b/ig, "I hesitate")
        .replace(/\bI\s+flinches\b/ig, "I flinch")
        .replace(/\bI\s+remembers\b/ig, "I remember")
        .replace(/\bI\s+notices\b/ig, "I notice")
        .replace(/\bI\s+realizes\b/ig, "I realize")
        .replace(/\bI\s+believes\b/ig, "I believe")
        .replace(/\bI\s+tries\b/ig, "I try")
        .replace(/\bI\s+carries\b/ig, "I carry")
        .replace(/\bI\s+worries\b/ig, "I worry")
        .replace(/\bI\s+studies\b/ig, "I study")
        .replace(/\bI\s+measures\b/ig, "I measure")
        .replace(/\bI\s+tracks\b/ig, "I track")
        .replace(/\bI\s+(?:do not|don't)\s+steps\b/ig, "I don't step")
        .replace(/\bI\s+(?:do not|don't)\s+moves\b/ig, "I don't move")
        .replace(/\bI\s+(?:do not|don't)\s+looks\b/ig, "I don't look")
        .replace(/\s+/g, " ")
        .trim();

    const normalizePrivateThoughtPerspective = (agentName, value = "", config = {}) => {
        const agent = sanitizeAgentName(agentName);
        let normalized = String(value || "").replace(/\s+/g, " ").trim();
        if (agent) {
            // A named subject establishes ownership; she/he/their can be someone
            // else. Preserve all other actors, possessives and quoted speech.
            normalized = normalized.replace(new RegExp(`^${escapeRegex(agent)}\\s+([A-Za-z]+)\\b`, "i"),
                (_, verb) => `I ${toFirstPersonVerb(verb)}`);
        }
        return fixFirstPersonGrammar(normalized);
    };

    const stripThoughtIndex = (value = "") => String(value || "")
        .replace(/^\s*\d+\s*(?:→|[-=]*>)\s*/, "")
        .trim();

    const cleanOperationValueLiteral = (value = "") => String(value || "")
        .trim()
        .replace(/^[-=]{1,}\s*memory[ _-]?operation\s*[:=]\s*/i, "")
        .replace(/^memory[ _-]?operation\s*[:=]\s*/i, "")
        .replace(/\s*=[-=]{1,}\s*$/g, "")
        .replace(/^`([\s\S]*)`$/g, "$1")
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
        .replace(/[\u200B-\u200D]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const isWeakMemoryKey = (key = "") => {
        const clean = cleanComparableKey(key);
        return /^(?:memory_operation|memory_operation_.+|memory_recent|recent_memory|recent_event|current_memory|current_thought|new_thought|thought|note|notes?|temp|temporary|placeholder|scene|event|thing|stuff)$/i.test(clean);
    };

    const hasTemplateThoughtPrefix = (value = "") => /^(?:I\s+need\s+to\s+remember\s+this|I\s+need\s+to\s+understand\s+where\s+I\s+stand\s+with\s+[^:]{1,80}|I\s+need\s+the\s+truth\s+from\s+[^:]{1,80}|I\s+need\s+an\s+answer\s+to\s+this\s+question|I\s+feel\s+[^:]{1,40}\s+as\s+this\s+unfolds)\s*:/i.test(String(value || "").trim());

    const isQualityThought = (agentName, key, value, brain, config) => {
        if (!config.qualityGate) return true;
        const cleanKey = cleanComparableKey(key);
        const val = stripThoughtIndex(value);
        const lower = val.toLowerCase();
        if (/memory[ _-]?operation/i.test(cleanKey) || /memory[ _-]?operation/i.test(val)) return false;
        if (/[-=]{1,}\s*$/.test(val) || /(?:^|\s)[+\-=]\s*[a-zA-Z0-9_]{2,}\s*:\s*/.test(val)) return false;
        if (!cleanKey || /^(?:key|any_key|key_name|example_key|thought|memory|note|temp|placeholder)$/.test(cleanKey)) return false;
        if (isWeakMemoryKey(key)) return false;
        if (!/[a-z]/i.test(val) || val.length < 8 || val.length > 220) return false;
        if (hasTemplateThoughtPrefix(val)) return false;
        if (/\bI\s+(?:doesn[’']?t|does\s+not|does|is|are|has|goes|says|asks|looks|keeps|stays|steps|knows|thinks|feels|wants|needs|refuses)\b/i.test(val)) return false;
        if (isCodeDebugLeakLine(val)) return false;
        const sentenceMarks = (val.match(/[.!?](?:\s|$)/g) || []).length;
        if (sentenceMarks > 2) return false;
        if (/^(?:as an ai|as a language model|sorry\b|i am unable|i'm unable)\b/i.test(val)) return false;
        if (/\b(?:cannot|can't)\s+comply\b/i.test(val)) return false;
        if (/(?:strict output|output format|bracket operation|story continues|mindforge npc|system instruction)/i.test(val)) return false;
        if (/\byou\s+(?:feel|decide|choose|think|want|will|must|remember)\b/i.test(val)) return false;
        if (!isCoreKey(key) && isNarrativeMemoryLeak(agentName, val)) return false;
        const agentLower = String(agentName || "").toLowerCase();
        const playerLower = String(config.player || "protagonist").toLowerCase();
        if (agentLower && lower.includes(`you are ${agentLower}`)) return false;
        if (playerLower && lower.includes(`you are ${playerLower}`)) return false;
        return true;
    };

    const buildFallbackMemoryOp = (agentName, storyText = "", config = {}) => {
        // A fallback may record an explicit commitment, never infer a motive from
        // body language, unattributed dialogue, or an ambiguous pronoun.
        const agent = sanitizeAgentName(agentName);
        if (!agent) return null;
        const actor = escapeRegex(agent);
        const verbs = { promises: "promise", promised: "promised", vows: "vow", vowed: "vowed", plans: "plan", planned: "planned", intends: "intend", intended: "intended" };
        const pattern = new RegExp(`^${actor}\\s+(promises|promised|vows|vowed|plans|planned|intends|intended)\\s+(.+)[.]$`);
        const names = new Set([config.player, ...(config.agents || []).map(item => item.name)]);
        const ignored = new Set(["the", "and", "that", "will", "would", "until", "with", "from", "before", "after", "must"]);
        for (const sentence of String(storyText || "").split(/(?<=[.!?])\s+|\n+/)) {
            const match = sentence.trim().match(pattern);
            if (!match) continue;
            let complement = match[2];
            // Explicitly repeated actor is safe to convert; she/he/they is not.
            complement = complement.replace(new RegExp(`\\bthat ${actor} (will|would)\\b`), "that I $1");
            if (/\b(?:she|he|they|her|his|their|him|them|you|your|we|our)\b|["“”`]/i.test(complement)) continue;
            const promise = /^(?:promise|vow)/.test(match[1]);
            const validComplement = /^(?:not )?to\s+\S/.test(complement) ||
                (promise && /^that I (?:will|would)\s+\S/.test(complement)) ||
                (promise && [...names].some(name => name && name !== agent && (
                    complement.startsWith(`${name} to `) || complement.startsWith(`${name} that I will `) || complement.startsWith(`${name} that I would `)
                )));
            if (!validComplement) continue;
            const val = `I ${verbs[match[1]]} ${complement}.`;
            if (val.length > 220) continue;
            const terms = (complement.toLowerCase().match(/[a-z]{3,}/g) || [])
                .filter(word => !ignored.has(word) && ![...names].some(name => String(name || "").toLowerCase() === word));
            if (!terms.length) continue;
            const key = formatMemoryKey(`${promise ? "promise" : "plan"}_${[...new Set(terms)].slice(0, 2).join("_")}`);
            return { type: "set", key, val, tagKey: key, fallback: true };
        }
        return null;
    };

    const cleanupAgentRuntimeMeta = (agentName, brain) => {
        let modified = false;
        const exists = (baseKey) => {
            const target = cleanComparableKey(baseKey);
            for (const key in brain) {
                if (cleanComparableKey(key) === target) return true;
            }
            return false;
        };

        const labels = getLabelStore(agentName);
        for (const key in labels) {
            if (!exists(key)) {
                delete labels[key];
                modified = true;
            }
        }

        const store = getMemoryStore(agentName);
        for (const key in store) {
            if (!exists(key)) {
                delete store[key];
                modified = true;
            }
        }
        return modified;
    };

    const runAutoDoctor = (config, phase = "") => {
        if (!config.autoDoctor) return;

        const currentHash = getHistoryHash();
        if (phase !== "output" && MF.doctor.hash === currentHash && MF.doctor.turn === currentTurn) return;
        MF.doctor.hash = currentHash;
        MF.doctor.turn = currentTurn;
        bumpHealth("autoDoctorRuns");

        const seenAgents = {};
        let repairs = 0;
        let compacts = 0;
        let metaCleanups = 0;
        let duplicates = 0;

        for (const card of storyCards) {
            if (!card || typeof card.keys !== "string" || !card.keys.includes("\"agent\"")) continue;
            const meta = parseBrainMeta(card);
            const agentName = sanitizeAgentName(meta && meta.agent);
            if (!agentName) continue;

            const beforeKeys = card.keys;
            const beforeEntry = typeof card.entry === "string" ? card.entry : "";
            const beforeTitle = typeof card.title === "string" ? card.title : "";
            const beforeDescription = typeof card.description === "string" ? card.description : "";

            repairBrainCard(card, agentName);
            if (card.keys !== beforeKeys || card.entry !== beforeEntry || card.title !== beforeTitle || card.description !== beforeDescription) {
                repairs++;
            }

            const nextMeta = parseBrainMeta(card) || {};
            if (seenAgents[agentName] && seenAgents[agentName] !== card) {
                nextMeta.agent = agentName;
                nextMeta.enabled = false;
                nextMeta.duplicate = true;
                card.keys = JSON.stringify(nextMeta);
                if (typeof card.title === "string" && !card.title.includes("(disabled duplicate)")) {
                    card.title = `${card.title} (disabled duplicate)`;
                }
                duplicates++;
                continue;
            }
            seenAgents[agentName] = card;

            const brain = deserializeBrain(card.description);
            if (cleanupAgentRuntimeMeta(agentName, brain)) {
                metaCleanups++;
            }

            const stats = getBrainStats(brain);
            const tooManyKeys = stats.normalKeys.length > (config.maxBrainKeys + 2);
            const tooLarge = (card.description || "").length > Math.max(1800, Math.floor((config.contextPct / 100) * Math.max(4000, info.maxChars || 4000)));
            if (tooManyKeys || tooLarge) {
                const before = card.description;
                card.description = serializeBrain(brain, agentName);
                if (card.description !== before) compacts++;
            }
        }

        if (repairs) MF.health.autoDoctorRepairs = (MF.health.autoDoctorRepairs || 0) + repairs;
        if (compacts) MF.health.autoDoctorCompacts = (MF.health.autoDoctorCompacts || 0) + compacts;
        if (metaCleanups) MF.health.autoDoctorMetaCleanups = (MF.health.autoDoctorMetaCleanups || 0) + metaCleanups;
        if (duplicates) MF.health.autoDoctorDuplicates = (MF.health.autoDoctorDuplicates || 0) + duplicates;

        if (config.autoLore) {
            const worldCard = storyCards.find(c => c && typeof c.keys === "string" && c.keys.trim().toLowerCase() === "mindforge_world");
            if (worldCard && typeof worldCard.description === "string") {
                const world = deserializeBrain(worldCard.description);
                const before = worldCard.description;
                worldCard.description = serializeWorld(world, config);
                if (worldCard.description !== before) {
                    MF.health.autoDoctorWorldCompacts = (MF.health.autoDoctorWorldCompacts || 0) + 1;
                }
            }
        }
    };

    // ==================== HOOK ROUTING ====================

    let { config } = parseConfig();
    // Disabling automation deactivates untouched managed triggers on the next hook.
    if (config.worldCards || storyCards.some(card => card && String(card.description || "").startsWith("// MindForge World Card:"))) syncWorldCards(config);

    if (!config.enabled) {
        const cleanPendingTask = hook === "output" && ((MF.delivery?.task && !MF.delivery.consumed) ||
            (frontLease?.delivered && !frontLease.outputHandled));
        const originalContext = text;
        const owned = hook === "context" ? MindForgeFrontRange(text, frontLease) : null;
        if (owned) text = removeOwnedFront(owned);
        if (frontLease && hook !== "output") frontLease.delivered = false;
        MF.agent = "";
        MF.scene = { agent: "", ttl: 0 };
        MF.pendingMemory = { agent: "", hash: "", turn: -999 };
        MF.delivery = { hash: getHistoryHash(), agent: "", task: false, consumed: true };
        if (hook === "context") {
            MF.contextStats = {
                mode: "disabled", inputChars: originalContext.length, returnedChars: text.length,
                addedChars: 0, removedChars: originalContext.length - text.length, memoryChars: 0,
                frontMemoryChars: 0, frontMemoryStatus: owned ? "stale" : "disabled",
                task: false, taskOrder: "none", compact: false, prefixPreserved: text.startsWith(originalContext), englishRequested: false
            };
        }
        if (cleanPendingTask && parsedOutput) text = parsedOutput.text || "\u200B";
        return;
    }
    config = applyAdaptiveProfile(config);
    runAutoDoctor(config, hook);

    // 1. INPUT HOOK: Handle player OOC commands
    if (hook === "input") {
        if (text) {
            const cmd = text.trim();
            if (cmd.startsWith("/mf") || cmd.startsWith("/brain") || cmd.startsWith("/mindforge")) {
                const parts = cmd.split(" ").map(p => p.trim()).filter(Boolean);
                const sub = parts[1] ? parts[1].toLowerCase() : "";
                let outputMsg = "";

                if (!parts[1] || sub === "list" || sub === "status") {
                    outputMsg = `🧩 [MindForge System Status]\n\n`;
                    outputMsg += `Configuration:\n`;
                    outputMsg += `- Enabled: ${config.enabled}\n`;
                    outputMsg += `- Player Name: ${config.player}\n`;
                    outputMsg += `- Language: English\n`;
                    outputMsg += `- Model Profile: ${config.profile}\n`;
                    outputMsg += `- Memory Transport: ${config.transport}\n`;
                    outputMsg += `- Runtime Profile: ${config.runtimeProfile || config.profile}\n`;
                    outputMsg += `- Scenario Auto-Discovery: ${config.scenarioDiscovery}\n`;
                    outputMsg += `- Thought Chance: ${config.chance}%\n`;
                    outputMsg += `- Brain Context: ${config.contextPct}%\n`;
                    outputMsg += `- Lookback Turns: ${config.lookback}\n`;
                    outputMsg += `- Max Active NPCs: ${config.maxAgents}\n`;
                    outputMsg += `- Brain Steward: ${config.steward}\n`;
                    outputMsg += `- Agentic Charter: ${config.agenticCharter}\n`;
                    outputMsg += `- Auto Doctor: ${config.autoDoctor}\n`;
                    outputMsg += `- Bootstrap Empty Brains: ${config.bootstrap}\n`;
                    outputMsg += `- World Memory: ${config.autoLore}\n`;
                    outputMsg += `- World Cards: ${config.worldCards}\n`;
                    outputMsg += `- Memory Slots: ${config.memorySlots}\n`;
                    outputMsg += `- Thought Quality Gate: ${config.qualityGate}\n`;
                    outputMsg += `- Max Brain Keys: ${config.maxBrainKeys}\n`;
                    outputMsg += `- Max Lore Keys: ${config.maxLoreKeys}\n\n`;
                    outputMsg += `Health:\n`;
                    outputMsg += `- Context Guards: ${MF.health.contextGuards || 0}\n`;
                    outputMsg += `- Load Sheds: ${MF.health.loadSheds || 0}\n`;
                    outputMsg += `- Scene Locks: ${MF.health.sceneLocks || 0}\n`;
                    outputMsg += `- Empty Outputs: ${MF.health.emptyOutputs || 0}\n`;
                    outputMsg += `- UI Leak Skips: ${MF.health.uiLeakSkips || 0}\n`;
                    outputMsg += `- Memory-Only Outputs: ${MF.health.memoryOnlyOutputs || 0}\n`;
                    outputMsg += `- Memory-Only Cooldowns: ${MF.health.memoryOnlyCooldowns || 0}\n`;
                    outputMsg += `- Skipped Commits: ${MF.health.skippedCommits || 0}\n`;
                    outputMsg += `- Quality Skips: ${MF.health.qualitySkips || 0}\n`;
                    outputMsg += `- Thought Quality Skips: ${MF.health.thoughtQualitySkips || 0}\n`;
                    outputMsg += `- Fallback Memory Writes: ${MF.health.fallbackMemoryWrites || 0}\n`;
                    outputMsg += `- Duplicate Skips: ${MF.health.duplicateSkips || 0}\n`;
                    outputMsg += `- Core Memory Skips: ${MF.health.coreSkips || 0}\n`;
                    outputMsg += `- Smart Prunes: ${MF.health.smartPrunes || 0}\n`;
                    outputMsg += `- Smart Merges: ${MF.health.smartMerges || 0}\n`;
                    outputMsg += `- Auto Doctor Runs: ${MF.health.autoDoctorRuns || 0}\n`;
                    outputMsg += `- Auto Doctor Repairs: ${MF.health.autoDoctorRepairs || 0}\n`;
                    outputMsg += `- Auto Doctor Compacts: ${MF.health.autoDoctorCompacts || 0}\n`;
                    outputMsg += `- Bootstrap Prompts: ${MF.health.bootstrapPrompts || 0}\n`;
                    outputMsg += `- Unfilled Tasks: ${MF.health.unfilledTasks || 0}\n`;
                    outputMsg += `- Scenario Discoveries: ${MF.health.scenarioDiscoveries || 0}\n`;
                    outputMsg += `- World Writes: ${MF.health.worldWrites || 0}\n`;
                    outputMsg += `- World Compacts: ${MF.health.worldCompacts || 0}\n`;
                    outputMsg += `- Parser Normalizations: ${MF.health.parserNormalizations || 0}\n`;
                    outputMsg += `- Parser Multi-Ops: ${MF.health.parserMultiOps || 0}\n`;
                    outputMsg += `- Config Migrations: ${MF.health.configMigrations || 0}\n`;
                    outputMsg += `- Brain Repairs: ${MF.health.brainRepairs || 0}\n`;
                    outputMsg += `- Adaptive Shifts: ${MF.health.adaptiveShifts || 0}\n`;
                    outputMsg += `- Runtime Errors: ${MF.health.errors || 0}\n\n`;
                    if (MF.lastMemoryResult) {
                        const last = MF.lastMemoryResult;
                        outputMsg += `Last Memory Result:\n- NPC: ${last.agent || "none"}\n- Result: ${last.reason}\n`;
                        outputMsg += `- Parsed Operations: ${last.parsedOperations}\n- Stored Thoughts: ${last.storedKeys}\n`;
                        outputMsg += `- Turn Match: ${last.hashMatches}\n- Read thoughts in the brain card's Notes/Description.\n\n`;
                    }
                    outputMsg += `NPC Agents:\n`;

                    if (config.agents.length === 0) {
                        outputMsg += `  (No NPCs configured)\n`;
                    } else {
                        for (const agent of config.agents) {
                            const brainCard = getBrainCard(agent.name);
                            const brain = deserializeBrain(brainCard.description);
                            const keys = Object.keys(brain);
                            outputMsg += `- ${agent.name} (Aliases: ${agent.aliases.slice(1).join(", ") || "none"})\n`;
                            if (keys.length === 0) {
                                outputMsg += `  * Brain is empty\n`;
                            } else {
                                for (const k of keys) {
                                    outputMsg += `  * ${k}: ${brain[k]}\n`;
                                }
                            }
                        }
                    }
                    outputMsg += `\n(Type anything and press Submit to resume game. Use 'Undo' if you want to clear this output from history.)`;
                } else if (sub === "set") {
                    const agentNameInput = parts[2];
                    const keyInput = parts[3];
                    const valInput = parts.slice(4).join(" ");
                    const agent = config.agents.find(a => a.name.toLowerCase() === (agentNameInput || "").toLowerCase());

                    if (!agent) {
                        outputMsg = `❌ Agent not found: "${agentNameInput}".`;
                    } else if (!keyInput || !valInput) {
                        outputMsg = `❌ Invalid syntax. Use: /mf set <agent> <key> <value>`;
                    } else {
                        const brainCard = getBrainCard(agent.name);
                        const brain = deserializeBrain(brainCard.description);
                        removeFromBrain(brain, keyInput);
                        brain[keyInput] = valInput;
                        touchMemory(agent.name, keyInput, "write");
                        brainCard.description = serializeBrain(brain, agent.name);
                        outputMsg = `✅ Set [${keyInput}] to "${valInput}" in ${agent.name}'s brain.`;
                    }
                } else if (sub === "forget") {
                    const agentNameInput = parts[2];
                    const keyInput = parts[3];
                    const agent = config.agents.find(a => a.name.toLowerCase() === (agentNameInput || "").toLowerCase());

                    if (!agent) {
                        outputMsg = `❌ Agent not found: "${agentNameInput}".`;
                    } else if (!keyInput) {
                        outputMsg = `❌ Invalid syntax. Use: /mf forget <agent> <key>`;
                    } else {
                        const brainCard = getBrainCard(agent.name);
                        const brain = deserializeBrain(brainCard.description);
                        const deleted = removeFromBrain(brain, keyInput);
                        if (deleted) {
                            forgetMemoryMeta(agent.name, keyInput);
                            brainCard.description = serializeBrain(brain, agent.name);
                            outputMsg = `✅ Forgot key [${keyInput}] from ${agent.name}'s brain.`;
                        } else {
                            outputMsg = `❌ Key [${keyInput}] not found in ${agent.name}'s brain.`;
                        }
                    }
                } else if (sub === "rename") {
                    const agentNameInput = parts[2];
                    const newKeyInput = parts[3];
                    const oldKeyInput = parts[4];
                    const agent = config.agents.find(a => a.name.toLowerCase() === (agentNameInput || "").toLowerCase());

                    if (!agent) {
                        outputMsg = `❌ Agent not found: "${agentNameInput}".`;
                    } else if (!newKeyInput || !oldKeyInput) {
                        outputMsg = `❌ Invalid syntax. Use: /mf rename <agent> <new_key> <old_key>`;
                    } else {
                        const brainCard = getBrainCard(agent.name);
                        const brain = deserializeBrain(brainCard.description);

                        let actualOldKey = null;
                        let foundVal = null;
                        const cleanOld = oldKeyInput.replace(/^\_/, "").replace(/\(\d+\)$/, "").toLowerCase();
                        for (const k in brain) {
                            const currentClean = k.replace(/^\_/, "").replace(/\(\d+\)$/, "").toLowerCase();
                            if (currentClean === cleanOld) {
                                foundVal = brain[k];
                                actualOldKey = k;
                                break;
                            }
                        }

                        if (actualOldKey) {
                            removeFromBrain(brain, newKeyInput);
                            brain[newKeyInput] = foundVal;
                            delete brain[actualOldKey];
                            touchMemory(agent.name, newKeyInput, "write");
                            forgetMemoryMeta(agent.name, actualOldKey);
                            brainCard.description = serializeBrain(brain, agent.name);
                            outputMsg = `✅ Renamed key [${actualOldKey}] to [${newKeyInput}] in ${agent.name}'s brain.`;
                        } else {
                            outputMsg = `❌ Key [${oldKeyInput}] not found in ${agent.name}'s brain.`;
                        }
                    }
                } else if (sub === "clear") {
                    const agentNameInput = parts[2];
                    const agent = config.agents.find(a => a.name.toLowerCase() === (agentNameInput || "").toLowerCase());

                    if (!agent) {
                        outputMsg = `❌ Agent not found: "${agentNameInput}".`;
                    } else {
                        const brainCard = getBrainCard(agent.name);
                        MF.memory[agent.name] = {};
                        brainCard.description = serializeBrain({}, agent.name);
                        outputMsg = `✅ Cleared all thoughts from ${agent.name}'s brain.`;
                    }
                } else if (sub === "help") {
                    outputMsg = `🧩 [MindForge Commands Help]\n\n`;
                    outputMsg += `OOC Commands:\n`;
                    outputMsg += `- /mf status : Show configuration and active agents.\n`;
                    outputMsg += `- /mf <agent> : Show specific agent's brain card.\n`;
                    outputMsg += `- /mf set <agent> <key> <value> : Set memory key to value.\n`;
                    outputMsg += `- /mf forget <agent> <key> : Delete memory key.\n`;
                    outputMsg += `- /mf rename <agent> <new_key> <old_key> : Rename memory key.\n`;
                    outputMsg += `- /mf clear <agent> : Clear all memories for agent.\n`;
                    outputMsg += `\n(Type anything and press Submit to resume game.)`;
                } else {
                    const agent = config.agents.find(a => a.name.toLowerCase() === parts[1].toLowerCase());
                    if (agent) {
                        const brainCard = getBrainCard(agent.name);
                        outputMsg = `🧩 [MindForge: ${agent.name} Brain Card]\n\n`;
                        outputMsg += `Description (Thoughts):\n${brainCard.description || "(Empty)"}\n\n`;
                        outputMsg += `Operation Log:\n${brainCard.entry || "(Empty)"}\n`;
                    } else {
                        outputMsg = `❌ Unknown command or NPC: "${parts[1]}". Use "/mf help" or "/mf status" for options.`;
                    }
                }

                text = outputMsg;
                return;
            }
        }

        if (history.length === 0 && text) {
            text = text.trimEnd() + "\n\n";
        }
        prepareFrontMemory(config);
        return;
    }

    // 2. CONTEXT HOOK: Multi-NPC thoughts injection and decay
    if (hook === "context") {
        const originalContext = text;
        const cacheMode = info.useCacheEfficient === true;
        const routed = detectTriggers(config).filter(name => getAgentMeta(name, config).enabled);
        const expectedPrimary = MF.scene.ttl > 0 && routed.includes(MF.scene.agent) ? MF.scene.agent : routed[0];
        const owned = MindForgeFrontRange(originalContext, frontLease);
        const profileCap = config.profile === "stable" ? 600 : config.profile === "full" ? 1800 : 1000;
        const frontCap = Math.min(profileCap, Math.max(320, Math.floor(config.contextPct / 100 * originalContext.length)));
        const frontCard = frontLease && storyCards.find(item => parseBrainMeta(item)?.agent === frontLease.agent);
        const frontBrain = frontCard ? deserializeBrain(frontCard.description) : {};
        const frontAge = frontLease ? currentTurn - frontLease.turn : Infinity;
        const frontValid = config.transport === "frontmemory" && owned?.exact &&
            frontAge >= 0 && frontAge <= 1 && frontLease.agent === expectedPrimary &&
            frontLease.frame.length <= frontCap &&
            (!Number.isFinite(info.maxChars) || originalContext.length <= info.maxChars) &&
            Array.isArray(frontLease.items) && frontLease.items.length > 0 && frontLease.items.every(item =>
                item && typeof item.key === "string" && !isVolatileKey(item.key) &&
                typeof frontBrain[item.key] === "string" && stripThoughtIndex(frontBrain[item.key]) === item.value);
        const frontDelivered = frontValid ? frontLease : null;
        const frontMemoryChars = frontDelivered ? frontLease.frame.length : 0;
        if (frontLease) frontLease.delivered = Boolean(frontDelivered);
        MF.frontStatus = frontDelivered ? "delivered" : owned ? "stale" : frontLease ? "not-in-context" : MF.frontStatus || "context";
        if (owned && !frontDelivered) text = removeOwnedFront(owned);
        const allocation = contextBudget(text, config, cacheMode);
        let base = allocation.base;
        const suffixRoom = allocation.available;
        const englishRule = "Write all narration, dialogue and thoughts in English.";
        const hasEnglishRule = base.split(/\r?\n/).some(line => line.trim() === englishRule);
        const turnHash = getHistoryHash();
        MF.contextTurn = MF.contextTurn || { hash: "", decayed: {}, seen: {} };
        if (MF.contextTurn.hash !== turnHash) MF.contextTurn = { hash: turnHash, decayed: {}, seen: {} };
        MF.agent = "";
        MF.pendingMemory = { agent: "", hash: "", turn: -999 };
        MF.delivery = { hash: turnHash, agent: "", task: false, consumed: false };
        const finishContext = (parts, task = false, memoryChars = 0, compact = false) => {
            const suffix = parts.filter(Boolean).map(part => `\n\n${part}`).join("");
            if (!cacheMode && suffix) {
                base = trimOldStory(base, Math.max(0, base.length + suffix.length - allocation.limit));
            }
            text = base + suffix;
            const removedChars = Math.max(0, originalContext.length - base.length);
            if (removedChars && !MF.contextTurn.guarded) {
                bumpHealth("contextGuards");
                MF.contextTurn.guarded = true;
            }
            MF.contextStats = {
                mode: cacheMode ? "cache" : "standard", available: suffixRoom,
                transport: config.transport, maxChars: allocation.max,
                inputChars: originalContext.length, addedChars: suffix.length, removedChars,
                returnedChars: text.length, memoryChars, task, taskOrder: task ? "memory-first" : "none", compact,
                frontMemoryChars, frontMemoryStatus: MF.frontStatus,
                protectedMemoryChars: allocation.protectedChars, hostOverBudget: allocation.hostOverBudget,
                prefixPreserved: text.startsWith(originalContext),
                englishRequested: text.includes(englishRule)
            };
        };

        // Auto-pin config card if enabled
        if (config.pin) {
            let confCard = storyCards.find(c => c && (
                (c.title && c.title.trim().toLowerCase().includes("configure mindforge")) ||
                (typeof c.keys === "string" && c.keys.trim().toLowerCase().includes("mindforge_config"))
            ));
            if (confCard) {
                const idx = storyCards.indexOf(confCard);
                if (idx > 0) {
                    storyCards.splice(idx, 1);
                    storyCards.unshift(confCard);
                }
            }
        }

        let activeAgents = routed;
        if (MF.scene.agent && activeAgents.includes(MF.scene.agent) && activeAgents[0] !== MF.scene.agent && MF.scene.ttl > 0) {
            activeAgents = [MF.scene.agent, ...activeAgents.filter(name => name !== MF.scene.agent)];
            if (!MF.contextTurn.routed) {
                MF.scene.ttl--;
                bumpHealth("sceneLocks");
            }
        }
        activeAgents = activeAgents.slice(0, config.maxAgents);
        const pressure = suffixRoom < 200 ? 1 : suffixRoom < 500 ? 0.8 : 0;
        if (pressure > 0.92 && activeAgents.length > 1) {
            activeAgents = activeAgents.slice(0, 1);
            if (!MF.contextTurn.routed) bumpHealth("loadSheds");
        } else if (pressure > 0.78 && activeAgents.length > 2) {
            activeAgents = activeAgents.slice(0, 2);
            if (!MF.contextTurn.routed) bumpHealth("loadSheds");
        }

        if (activeAgents.length === 0) {
            MF.scene = { agent: "", ttl: 0 };
            deindicateAll(); // Strip all indicators since no NPC is active
            const parts = !hasEnglishRule && englishRule.length + 2 <= suffixRoom ? [englishRule] : [];
            const used = parts.reduce((sum, part) => sum + part.length + 2, 0);
            const world = getWorldContext(base, config, base, Math.min(600, suffixRoom - used - 2));
            if (world) parts.push(world);
            finishContext(parts);
            return;
        }

        const protectedPrefix = base.slice(0, allocation.protectedChars);
        const tailStart = Math.max(allocation.protectedChars, frontBoundary(base));
        const protectedTail = base.slice(tailStart);
        const decodedLabels = decodeThoughtLabels(base.slice(allocation.protectedChars, tailStart), activeAgents);
        if (!cacheMode) base = protectedPrefix + decodedLabels.text.replace(/<!--mf:[a-zA-Z0-9_]+-->/g, "") + protectedTail;

        const primaryAgent = activeAgents[0];
        const primaryMeta = getAgentMeta(primaryAgent, config);
        if (MF.scene.agent !== primaryAgent) MF.scene = { agent: primaryAgent, ttl: 2 };
        MF.contextTurn.routed = true;
        MF.agent = primaryAgent; // Output hook will handle command updates for this primary agent

        // Apply visual indicator
        if (config.indicator) {
            deindicateAll();
            const primaryCard = getBrainCard(primaryAgent);
            if (primaryCard) {
                const sym = typeof config.indicator === "string" ? config.indicator : "🧩";
                primaryCard.title = `${sym}\u200B ${primaryCard.title}`;
            }
        } else {
            deindicateAll();
        }

        const contextSegments = [];
        const maxBrainChars = Math.min(profileCap, Math.max(320, Math.floor((config.contextPct / 100) * base.length)));
        const budgets = allocateBudgets(maxBrainChars, activeAgents.length);
        const isRetry = MF.hash === turnHash;
        let primarySteward = null;
        let hasStoredMemory = false;
        let hasStoredCore = false;
        const region = storyRegion(base);
        const sceneText = region.length ? base.slice(Math.max(region.start, region.end - 2400), region.end) : base.slice(-2400);

        for (let idx = 0; idx < activeAgents.length; idx++) {
            const agentName = activeAgents[idx];
            const isPrimary = idx === 0;
            const agentMeta = getAgentMeta(agentName, config);
            const budgetScale = Math.min(2, Math.max(0.25, agentMeta.budget / Math.max(1, config.contextPct)));
            const budget = Math.max(80, Math.floor((budgets[idx] || 120) * budgetScale));

            const brainCard = getBrainCard(agentName);
            let brain = deserializeBrain(brainCard.description);

            // Apply turn-based decay on active/present NPC
            const { brain: decayedBrain, modified } = decayVolatileMemories(brain, isRetry || MF.contextTurn.decayed[agentName], config.decay);
            MF.contextTurn.decayed[agentName] = true;
            if (modified) {
                brain = decayedBrain;
                brainCard.description = serializeBrain(brain, agentName);
            }

            if (isPrimary) {
                hasStoredMemory = Object.keys(brain).length > 0;
                hasStoredCore = Object.keys(brain).some(isCoreKey);
                primarySteward = chooseBrainTask(agentName, brain, config, pressure);
                const stats = getBrainStats(brain);
                const sparseBrain = stats.keys.length > 0 && stats.keys.length < Math.min(4, config.maxBrainKeys || 14);
                if (sparseBrain && getLastWriteAge(agentName) >= 2 && pressure <= 0.78) {
                    primarySteward = {
                        kind: "warmup",
                        label: `add another useful ${agentName} thought before settling into normal rotation`,
                        forcePassive: false,
                        forceChance: true
                    };
                }
            }

            // Rank durable, relevant, and recently-used thoughts before rotating filler.
            const recentTags = [...scanMemoryTags(base, 5), ...decodedLabels.keys];
            let brainStr = "";
            const selected = [];
            const rotationSeed = hashText(`${turnHash}:${agentName}:${Object.keys(brain).join("|")}`);
            const allThoughts = rankThoughtsForContext(agentName, brain, sceneText, recentTags, rotationSeed, config.rotation);
            for (const tObj of allThoughts) {
                if (frontDelivered?.agent === agentName && frontDelivered.items.some(item => item.key === tObj.key)) continue;
                const displayKey = cleanKeyForLLM(tObj.key);
                const label = (MF.labels[agentName] || {})[tObj.key];
                const labelSuffix = Number.isInteger(label) ? ` [${label}]` : "";
                const line = `- ${displayKey}: ${stripThoughtIndex(tObj.val)}${labelSuffix}\n`;
                if (brainStr.length + line.length > budget) continue;
                brainStr += line;
                selected.push({ key: tObj.key, value: stripThoughtIndex(tObj.val), line: line.trimEnd() });
            }

            if (brainStr) {
                const status = isPrimary ? "Active" : "Present";
                const ownershipName = agentName.toLowerCase().endsWith("s") ? `${agentName}'` : `${agentName}'s`;
                contextSegments.push({
                    primary: isPrimary,
                    agentName, selected,
                    text: `\n# ${ownershipName} Brain Thoughts (${status}):\n${brainStr}`
                });
            }
        }

        // Apply turn-based thought chance reduction on player turns
        const lastAct = getPrevAction();
        const isPlayerAction = lastAct && (lastAct.type === "do" || lastAct.type === "say" || lastAct.type === "story");
        const memoryOnlyAge = MF.memoryOnly && Number.isInteger(MF.memoryOnly.turn)
            ? currentTurn - MF.memoryOnly.turn
            : Infinity;
        const recentMemoryOnlyOutput = (
            MF.memoryOnly &&
            MF.memoryOnly.agent === primaryAgent &&
            memoryOnlyAge >= 0 &&
            memoryOnlyAge <= 2
        );
        let finalChance = (isPlayerAction && config.halfChance) ? (primaryMeta.chance / 2) : primaryMeta.chance;
        if (pressure > 0.92) {
            finalChance = 0;
        } else if (pressure > 0.78) {
            finalChance = Math.min(finalChance, 20);
        }
        if (primarySteward && primarySteward.forceChance && config.bootstrap && pressure <= 0.78 && !recentMemoryOnlyOutput) {
            finalChance = 100;
            bumpHealth("bootstrapPrompts");
        }
        if (primarySteward && primarySteward.forcePassive) {
            finalChance = 0;
        }
        if (recentMemoryOnlyOutput) {
            finalChance = 0;
            bumpHealth("memoryOnlyCooldowns");
        }
        MF.contextTurn.roll ??= Math.random();
        const triggerChance = (finalChance / 100) > MF.contextTurn.roll;
        let parts = [];
        let used = 0;
        const addPart = value => {
            if (!value || used + value.length + 2 > suffixRoom) return false;
            parts.push(value);
            used += value.length + 2;
            return true;
        };
        const pov = config.pov === 1 ? "first person" : config.pov === 3 ? "third person" : "second person";
        const povRule = `Story: ${pov}; player ${config.player}.`;
        const forms = hasStoredMemory ? "[+specific_key: I ...] | [-old_key] | [=new_key: old_key]" : "[+specific_key: I ...]";
        const task = `For ${primaryAgent} only, start your response with one memory operation: ${forms}. Replace the example with one short grounded first-person thought; name other people explicitly.${hasStoredMemory ? " Reuse keys; protect core_*." : ""} Then continue the story in ${pov}; leave ${config.player}'s choices and dialogue to the player. Both parts are required. No labels/code.`;
        let blocks = [];
        let memoryChars = 0;
        let hasPrimaryMemory = false;
        let hasPrimaryCore = false;
        const packMemory = compact => {
            blocks = [];
            memoryChars = frontMemoryChars;
            hasPrimaryMemory = !!frontDelivered;
            hasPrimaryCore = !!frontDelivered && frontDelivered.items.some(item => isCoreKey(item.key));
            for (const segment of contextSegments) {
                const header = compact ? `# ${segment.agentName} private:` : segment.text.trim().split("\n")[0];
                const render = item => compact ? `- ${item.value}` : item.line;
                const kept = [];
                for (const item of segment.selected) {
                    const candidate = [header, ...kept.map(render), render(item)].join("\n");
                    if (used + 2 + candidate.length <= suffixRoom && memoryChars + 2 + candidate.length <= maxBrainChars) kept.push(item);
                }
                if (!kept.length) continue;
                const block = [header, ...kept.map(render)].join("\n");
                blocks.push({ primary: segment.primary, agentName: segment.agentName, kept, text: block });
                used += 2 + block.length;
                memoryChars += 2 + block.length;
                if (segment.primary) {
                    hasPrimaryMemory = true;
                    hasPrimaryCore ||= kept.some(item => isCoreKey(item.key));
                }
            }
            blocks.sort((a, b) => Number(a.primary) - Number(b.primary));
            parts.push(...blocks.map(block => block.text));
        };
        if (!hasEnglishRule) addPart(englishRule);
        packMemory(false);
        const canWrite = !isRetry && triggerChance && (hasEnglishRule || parts.includes(englishRule)) &&
            (!hasStoredMemory || hasPrimaryMemory) && (!hasStoredCore || hasPrimaryCore);
        const taskFits = canWrite && used + povRule.length + task.length + 4 <= suffixRoom;
        if (taskFits) {
            addPart(povRule);
            // Reserve the complete task before optional guidance; append it last.
            used += task.length + 2;
        } else {
            // Read-only turns need values, not editing keys or a maintenance charter.
            // Keep the ownership header and every selected sentence verbatim.
            parts = [];
            used = 0;
            if (!hasEnglishRule) addPart(englishRule);
            packMemory(true);
            addPart(povRule);
        }
        const deliveredBlocks = frontDelivered
            ? [...blocks, { agentName: frontDelivered.agent, kept: frontDelivered.items }] : blocks;
        for (const block of deliveredBlocks) {
            for (const item of block.kept) {
                const id = `${block.agentName}:${item.key}`;
                if (!MF.contextTurn.seen[id]) {
                    touchMemory(block.agentName, item.key, "seen");
                    MF.contextTurn.seen[id] = true;
                }
            }
        }
        if (taskFits) {
            MF.pendingMemory = { agent: primaryAgent, hash: turnHash, turn: currentTurn };
            if (config.profile !== "stable") {
                addPart(getSlotGuidance(primaryAgent, config));
                if (config.steward && primarySteward) {
                    addPart(`Priority: ${primarySteward.kind === "bootstrap" ? primarySteward.label : primarySteward.kind}.`);
                }
            }
            const reflect = config.reflectionChance > 0 && !hasDirectDialogPressure() &&
                hashText(`${turnHash}:reflection`) % 100 < config.reflectionChance;
            if (reflect) addPart("Consider an unresolved motive or future plan.");
        }
        if (taskFits) addPart(getAgenticCharter(primaryAgent, config));
        addPart(getWorldContext(sceneText, config, base, Math.min(600, suffixRoom - used - 2)));
        if (taskFits) parts.push(task);
        MF.delivery = { hash: turnHash, agent: primaryAgent, task: Boolean(taskFits), consumed: false };
        finishContext(parts, Boolean(taskFits), memoryChars, !taskFits);
        setBrainStatus(getBrainCard(primaryAgent), taskFits
            ? "Task included; awaiting Output. Read stored thoughts in Notes/Description."
            : "Read-only turn; no write task included. Read stored thoughts in Notes/Description.");

        return;
    }

    // 3. OUTPUT HOOK: Clean once, then apply at most one authorized memory change.
    if (hook === "output") {
        const agentName = MF.agent;
        const request = MF.pendingMemory;
        const delivery = MF.delivery;
        const currentHash = getHistoryHash();
        const isRetry = MF.hash === currentHash;
        MF.agent = "";
        const parsed = parsedOutput || MindForgeParseOutput(text);
        text = parsed.text;
        if (parsed.removed) bumpHealth("memoryOperationLeakSkips");
        if (parsed.truncated) bumpHealth("truncatedOperations");
        if (parsed.scaffolding) bumpHealth("scaffoldingSkips");
        if (parsed.ui) MF.health.uiLeakSkips = (MF.health.uiLeakSkips || 0) + parsed.ui;
        if (parsed.code) MF.health.codeLeakSkips = (MF.health.codeLeakSkips || 0) + parsed.code;
        if (parsed.operations.length > 1) bumpHealth("parserMultiOps");
        if (parsed.operations.some(op => op.repaired)) bumpHealth("parserLooseOps");
        // World lore is independent of an NPC receiving a write task this turn.
        if (config.autoLore && MF.worldHash !== currentHash && isUsableNarrative(text)) {
            updateWorldMemory(text, config, "output");
            MF.worldHash = currentHash;
        }
        const authorized = agentName && !isRetry && delivery && (
            delivery.task && delivery.hash === currentHash && delivery.agent === agentName && !delivery.consumed
        );
        const consumed = Boolean(delivery?.consumed);
        const resultMessages = {
            saved: "Saved", "no-operation": "No memory operation returned",
            "incomplete-operation": "Incomplete operation; not saved", "invalid-operation": "Invalid operation; not saved",
            "scaffolding-only": "Only prompt/code wrappers found; not saved", "quality-rejected": "Quality filter rejected the thought",
            duplicate: "Duplicate thought; existing Notes retained", "core-protected": "Core memory protected",
            "no-change": "Operation made no change", "no-narrative": "Output was not usable story or a complete memory-only reply",
            "turn-mismatch": "Context/Output turn mismatch; not saved", "no-task": "No write task was included",
            "already-consumed": "Task already consumed; not saved again", retry: "Retry; not saved again",
            "agent-mismatch": "Task/NPC mismatch; not saved"
        };
        const recordResult = (reason, card = null) => {
            const target = agentName || delivery?.agent || "";
            card ||= storyCards.find(item => parseBrainMeta(item)?.agent === target);
            const storedKeys = Object.keys(deserializeBrain(card?.description || "")).length;
            MF.lastMemoryResult = {
                agent: target, reason, turn: currentTurn, authorized: Boolean(authorized),
                hashMatches: Boolean(delivery && delivery.hash === currentHash),
                parsedOperations: parsed.operations.length, truncated: parsed.truncated,
                key: String(parsed.operations[0]?.key || "").slice(0, 64),
                cardId: card?.id ?? null, storedKeys, notesChars: card?.description?.length || 0
            };
            setBrainStatus(card, `${resultMessages[reason] || reason}. Stored thoughts: ${storedKeys}. Read Notes/Description.`);
        };
        if (delivery) delivery.consumed = true;
        if (!authorized) {
            if (parsed.operations.length) bumpHealth(isRetry ? "retrySkips" : "undeliveredSkips");
            recordResult(consumed ? "already-consumed" : isRetry ? "retry" : !delivery?.task ? "no-task"
                : delivery.hash !== currentHash ? "turn-mismatch" : "agent-mismatch");
            if (!text) { bumpHealth("emptyOutputs"); text = "\u200B"; }
            return;
        }

        const brainCard = getBrainCard(agentName);
        const brain = deserializeBrain(brainCard.description);
        const candidate = parsed.operations[0];
        let pendingOp = null;
        let resultReason = parsed.truncated ? "incomplete-operation" : parsed.removed ? "invalid-operation"
            : parsed.scaffolding ? "scaffolding-only" : "no-operation";
        if (candidate) {
            let key = formatMemoryKey(candidate.key);
            const val = cleanOperationValueLiteral(candidate.val);
            const oldKey = Object.keys(brain).find(k => cleanComparableKey(k) === cleanComparableKey(formatMemoryKey(val)));
            const type = candidate.type === "assign" ? (oldKey && !/\s/.test(val) ? "rename" : "set") : candidate.type;
            if (type !== "delete" && key.startsWith("_") && !key.includes("(")) key += `(${config.decay})`;
            if (key && type === "set" && val) pendingOp = { type, key, val, tagKey: cleanKeyForLLM(key), hash: currentHash };
            else if (key && type === "delete") pendingOp = { type, key, hash: currentHash };
            else if (key && type === "rename" && oldKey) pendingOp = { type, key, oldKey, val: brain[oldKey], hash: currentHash };
        }
        let prefixText = "";
        const hasNarrative = isUsableNarrative(text);
        if (!pendingOp && !parsed.removed && !parsed.scaffolding && hasNarrative && request && request.agent === agentName && request.hash === currentHash) {
            pendingOp = buildFallbackMemoryOp(agentName, text, config);
            if (pendingOp) {
                pendingOp.hash = currentHash;
            }
        }
        const memoryOnlyOutput = !!(pendingOp && !hasNarrative && text === "" && !parsed.scaffolding && !parsed.truncated);
        if (pendingOp && !hasNarrative && text === "") {
            MF.memoryOnly = { agent: agentName, turn: currentTurn };
            bumpHealth("memoryOnlyOutputs");
        }

        if (pendingOp && (hasNarrative || memoryOnlyOutput)) {
            let logMsg = "";
            MF.ops++;

            if (pendingOp.type === "set") {
                let setOp = {
                    ...pendingOp,
                    val: normalizePrivateThoughtPerspective(agentName, pendingOp.val, config)
                };
                let commitSet = true;
                if (!isQualityThought(agentName, setOp.key, setOp.val, brain, config)) {
                    bumpHealth("thoughtQualitySkips");
                    bumpHealth("qualitySkips");
                    commitSet = false;
                    resultReason = "quality-rejected";
                } else if (isDuplicateThought(brain, setOp.key, setOp.val, agentName)) {
                    bumpHealth("duplicateSkips");
                    commitSet = false;
                    resultReason = "duplicate";
                }

                if (!commitSet) {
                    MF.ops--;
                } else {
                    removeFromBrain(brain, setOp.key, { allowCore: true });
                    removeLabelsForKey(agentName, setOp.key);
                    const storedThought = `${MF.ops} → ${stripThoughtIndex(setOp.val)}`;
                    brain[setOp.key] = storedThought;
                    touchMemory(agentName, setOp.key, "write");
                    const label = ensureThoughtLabel(agentName, setOp.key);
                    if (hasNarrative) {
                        prefixText = config.zwspLabels ? encodeLabel(label) : `<!--mf:${setOp.tagKey}-->`;
                    }
                    logMsg = `// operation ${MF.ops}
${agentName.toLowerCase()}.${setOp.key} = ${JSON.stringify(storedThought)};`;
                    if (setOp.fallback) {
                        bumpHealth("fallbackMemoryWrites");
                    }
                }
            } else if (pendingOp.type === "delete") {
                if (isCoreKey(pendingOp.key)) {
                    resultReason = "core-protected";
                    bumpHealth("coreSkips");
                    MF.ops--;
                } else {
                    const deleted = removeFromBrain(brain, pendingOp.key);
                    removeLabelsForKey(agentName, pendingOp.key);
                    forgetMemoryMeta(agentName, pendingOp.key);
                    if (deleted) {
                        logMsg = `// operation ${MF.ops}\ndelete ${agentName.toLowerCase()}.${pendingOp.key};`;
                    } else {
                        resultReason = "no-change";
                        MF.ops--;
                    }
                }
            } else if (pendingOp.type === "rename") {
                if (pendingOp.oldKey === pendingOp.key) {
                    resultReason = "no-change";
                    MF.ops--;
                } else if (isCoreKey(pendingOp.oldKey) || isCoreKey(pendingOp.key)) {
                    resultReason = "core-protected";
                    bumpHealth("coreSkips");
                    MF.ops--;
                } else {
                    removeFromBrain(brain, pendingOp.key);
                    const label = moveLabelForKey(agentName, pendingOp.oldKey, pendingOp.key);
                    brain[pendingOp.key] = pendingOp.val;
                    delete brain[pendingOp.oldKey];
                    touchMemory(agentName, pendingOp.key, "write");
                    forgetMemoryMeta(agentName, pendingOp.oldKey);
                    logMsg = `// operation ${MF.ops}\nrename ${agentName.toLowerCase()}.${pendingOp.oldKey} -> ${pendingOp.key};`;
                    if (Number.isInteger(label)) {
                        // Keep the association stable after a key rename.
                        getLabelStore(agentName)[pendingOp.key] = label;
                    }
                }
            }

            if (logMsg) {
                MF.hash = pendingOp.hash;
                MF.lastWrite[agentName] = currentTurn;
                if (MF.pendingMemory && MF.pendingMemory.agent === agentName) {
                    MF.pendingMemory = { agent: "", hash: "", turn: -999 };
                }
                brainCard.entry = `${brainCard.entry.trim()}\n\n${logMsg}`.trim();
                if (brainCard.entry.length > 2500) {
                    brainCard.entry = "// Bounded Operation Log:\n" + brainCard.entry.split("\n\n").slice(-10).join("\n\n");
                }
                brainCard.description = serializeBrain(brain, agentName);
                resultReason = "saved";
            }
        } else if (pendingOp) {
            resultReason = "no-narrative";
            bumpHealth("skippedCommits");
            bumpHealth("qualitySkips");
        } else if (delivery && delivery.task) {
            // Context included a task, but Output supplied no usable operation.
            bumpHealth("unfilledTasks");
        }
        recordResult(resultReason, brainCard);

        if (text === "" && memoryOnlyOutput) {
            text = "...";
        } else if (text === "") {
            bumpHealth("emptyOutputs");
            text = "\u200B";
        }

        if (prefixText) {
            text = `${prefixText}${text}`;
        }

        return;
    }
}

globalThis.MindForge = MindForge;
