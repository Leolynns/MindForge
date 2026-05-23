/**
 * MindForge Core Library
 * A lightweight, highly optimized, and robust agentic NPC memory script for AI Dungeon.
 */
function MindForge(hook) {
    "use strict";
    try {
        return MindForgeCore(hook);
    } catch (error) {
        if (globalThis.state && typeof state === "object" && !Array.isArray(state)) {
            const MF = state.MindForge = state.MindForge || {};
            MF.agent = "";
            MF.health = MF.health || {};
            MF.health.errors = (MF.health.errors || 0) + 1;
            MF.health.lastError = String(error && error.message ? error.message : error).slice(0, 180);
        }
        globalThis.text = (typeof globalThis.text === "string" && globalThis.text.trim()) ? globalThis.text : "\u200B";
        return;
    }
}

function MindForgeCore(hook) {
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
        globalThis.text ||= " ";
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
        const serialized = JSON.stringify(history.slice(-30));
        for (let i = 0; i < serialized.length; i++) {
            n = ((31 * n) + serialized.charCodeAt(i)) | 0;
        }
        return n.toString(16);
    };

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
    const getScenarioScanText = () => {
        const historyText = history
            .slice(0, 8)
            .concat(history.slice(-8))
            .map(act => act && (act.text || act.rawText || ""))
            .filter(Boolean)
            .join("\n");
        return `${historyText}\n${text || ""}`.slice(0, 16000);
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
            return manualName;
        }
        const cached = cleanPlayerName(MF.playerName);
        if (cached) return cached;
        const detected = findPlayerNameInInfo() || findPlayerNameInText(getScenarioScanText());
        if (detected) {
            if (MF.playerName !== detected) bumpHealth("playerNameDetections");
            MF.playerName = detected;
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
        rec.turn = history.length;
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
        if (Number.isInteger((MF.labels[agentName] || {})[key])) score += 35;
        if (typeof value === "string" && value.length > 180) score -= 15;
        if (Number.isInteger(meta.turn)) score += Math.max(0, 28 - Math.max(0, history.length - meta.turn));
        score += Math.min(36, (meta.seen || 0) * 4);
        score += Math.min(28, (meta.writes || 0) * 7);
        return score;
    };

    const defaultConfigEntry = [
        "MindForge Configuration",
        "",
        "Adjust the values below. Keep the colon and space.",
        "",
        "Enabled: true",
        "Player Name: auto",
        "POV (1=1st, 2=2nd, 3=3rd): 2",
        "Model Profile (Stable/Balanced/Full): Balanced",
        "Scenario Auto-Discovery: true",
        "Thought Chance (0-100): 60",
        "Half Thought Chance: true",
        "Max Brain Context (1-95): 25",
        "Context Guard Buffer (200-3000): 600",
        "Lookback Turns (1-20): 5",
        "Max Active NPCs (1-5): 3",
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
        "Memory Slots: true",
        "Thought Quality Gate: true",
        "Max Brain Keys (3-20): 6",
        "Max Lore Keys (3-30): 8"
    ].join("\n");

    const configGuideText = [
        "// MindForge Quick Guide:",
        "// Public scenario setup:",
        "// 1) Add important NPC names below, one per line. Use commas for aliases.",
        "// Example: Elara, queen, the queen",
        "// 2) Player Name: auto can read resolved setup text like ${Your name?} when the scenario reveals it.",
        "// 3) Scenario Auto-Discovery can add clear main NPCs from resolved opening/Plot Essentials text.",
        "// 4) Balanced is the recommended public default. Use Stable for small/cache models.",
        "// 5) Leave Auto Doctor and Agentic Charter on for hands-off NPC minds.",
        "// 6) World Memory is optional and disabled by default; enable it only when shared lore should grow automatically.",
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
            addIfMissing("Enabled: true", key => key.includes("enabled"));
            addIfMissing("Player Name: auto", key => key.includes("player name"));
            addIfMissing("POV (1=1st, 2=2nd, 3=3rd): 2", key => key.includes("pov"));
            addIfMissing("Model Profile (Stable/Balanced/Full): Balanced", key => key.includes("model profile"));
            addIfMissing("Scenario Auto-Discovery: true", key => key.includes("scenario auto") || key.includes("auto-discovery") || key.includes("auto discovery"));
            addIfMissing("Thought Chance (0-100): 60", key => key.includes("thought chance") && !key.includes("half"));
            addIfMissing("Half Thought Chance: true", key => key.includes("half thought chance") || key.includes("half chance"));
            addIfMissing("Max Brain Context (1-95): 25", key => key.includes("max brain context") || key === "context");
            addIfMissing("Context Guard Buffer (200-3000): 600", key => key.includes("context guard"));
            addIfMissing("Lookback Turns (1-20): 5", key => key.includes("lookback"));
            addIfMissing("Max Active NPCs (1-5): 3", key => key.includes("max active"));
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
            addIfMissing("Memory Slots: true", key => key.includes("memory slot"));
            addIfMissing("Thought Quality Gate: true", key => key.includes("quality gate"));
            addIfMissing("Max Brain Keys (3-20): 6", key => key.includes("max brain keys"));
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
            card = addStoryCard(
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
        const cleanName = cleanDiscoveredName(rawName);
        const canonical = sanitizeAgentName(cleanName);
        if (!canonical || genericPlayerNames.has(canonical.toLowerCase())) return null;
        const aliases = [];
        const lowerRaw = cleanName.toLowerCase();
        if (lowerRaw && lowerRaw !== canonical.toLowerCase()) aliases.push(lowerRaw);
        const words = lowerRaw.split(/\s+/).filter(Boolean);
        if (words.length > 1) aliases.push(words[words.length - 1]);
        const uniqueAliases = aliases.filter((item, idx, arr) => item && arr.indexOf(item) === idx);
        return {
            name: canonical,
            aliases: [canonical.toLowerCase(), ...uniqueAliases],
            line: [canonical, ...uniqueAliases].join(", ")
        };
    };

    const discoverScenarioAgents = (config, card) => {
        if (!config.scenarioDiscovery || !card) return;
        const source = getScenarioScanText();
        if (!source.trim()) return;

        const candidates = {};
        const addCandidate = (rawName, npcScore = 0, playerScore = 0, strongNpc = false) => {
            const cleanName = cleanDiscoveredName(rawName);
            if (!cleanName) return;
            const key = cleanName.toLowerCase();
            const candidate = candidates[key] = candidates[key] || {
                rawName: cleanName,
                npcScore: 0,
                playerScore: 0,
                strongNpc: false
            };
            candidate.npcScore += npcScore;
            candidate.playerScore += playerScore;
            candidate.strongNpc = candidate.strongNpc || strongNpc;
        };

        const playerHeaders = /^(?:player|player character|protagonist|main character|you|user)$/i;
        const npcHeaders = /^(?:main npc|important npc|primary npc|npc|companion|ally|rival|antagonist|mentor|handler|inner presence|presence|love interest|partner|sidekick|supporting character)$/i;
        const nonNpcHeaders = /^(?:core|setting|rules|world|location|place|item|object|weapon|system|theme|tone|author'?s note|faction|lore|background|plot|premise)$/i;

        for (const block of extractScenarioBlocks(source)) {
            const name = getNamedField(block.body);
            if (!name) continue;
            const header = block.header.trim();
            if (playerHeaders.test(header)) {
                addCandidate(name, 0, 100, false);
            } else if (npcHeaders.test(header)) {
                addCandidate(name, 90, 0, true);
            } else if (!nonNpcHeaders.test(header)) {
                addCandidate(name, 10, 0, false);
            }
        }

        const npcPatterns = [
            { regex: /\bthe person who finds you is\s+([A-Za-z][A-Za-z0-9_' -]{1,40})/ig, score: 80, strong: true },
            { regex: /\b(?:main|important|primary)\s+(?:npc|character|person|companion)\s+(?:name\s*)?(?:is|:)\s+([A-Za-z][A-Za-z0-9_' -]{1,40})/ig, score: 80, strong: true },
            { regex: /\bopen only when\s+([A-Za-z][A-Za-z0-9_' -]{1,40})\s+arrives?\b/ig, score: 50, strong: true }
        ];
        for (const item of npcPatterns) {
            let match;
            while ((match = item.regex.exec(source)) !== null) {
                addCandidate(match[1], item.score, 0, item.strong);
            }
        }

        const playerPatterns = [
            /\byour name is\s+([A-Za-z][A-Za-z0-9_' -]{1,40})/ig,
            /(?:^|\n)\s*(?:player\s+name|player\s+character\s+name|protagonist|your\s+name)\s*[:?=]\s*([A-Za-z][A-Za-z0-9_' -]{1,40})/ig
        ];
        for (const pattern of playerPatterns) {
            let match;
            while ((match = pattern.exec(source)) !== null) {
                addCandidate(match[1], 0, 90, false);
            }
        }

        for (const key in candidates) {
            const candidate = candidates[key];
            candidate.npcScore += scoreNarrativeNpcUse(candidate.rawName, source);
        }

        for (const key in candidates) {
            const candidate = candidates[key];
            const agent = buildDiscoveredAgent(candidate.rawName);
            if (!agent) continue;
            if (agent.name.toLowerCase() === sanitizeAgentName(config.player).toLowerCase()) continue;
            if (candidate.npcScore < candidate.playerScore + 35) continue;
            if (!(candidate.npcScore >= 90 || (candidate.strongNpc && candidate.npcScore >= 70))) continue;

            if (!hasAgentInConfig(config, agent.name)) {
                config.agents.push({ name: agent.name, aliases: agent.aliases });
            }
            const placedLine = upsertAgentLineInConfig(card.description, agent.name, agent.line);
            if (placedLine.description !== String(card.description || "").trimEnd()) {
                card.description = placedLine.description;
            }
            getBrainCard(agent.name);
            if (placedLine.added) {
                bumpHealth("scenarioDiscoveries");
            }
        }
    };

    const getWorldCard = () => {
        let card = storyCards.find(c => c && typeof c.keys === "string" && c.keys.trim().toLowerCase() === "mindforge_world");
        if (!card) {
            const timeStr = new Date().toISOString().replace("T", " ").slice(0, 16);
            card = addStoryCard(
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
            String(config.player || "protagonist").toLowerCase()
        ]);
        for (const agent of config.agents || []) {
            banned.add(agent.name.toLowerCase());
            for (const alias of agent.aliases || []) banned.add(String(alias).toLowerCase());
        }

        const out = [];
        const seen = new Set();
        const sentences = source.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
        const nameRegex = /\b(?:the\s+)?[A-Z][a-zA-Z0-9']+(?:(?:\s+(?:of|the|and)\s+|\s+)[A-Z][a-zA-Z0-9']+){0,3}/g;
        for (const sentence of sentences) {
            if (sentence.length < 18 || sentence.length > 260) continue;
            let match;
            while ((match = nameRegex.exec(sentence)) !== null) {
                const name = match[0].trim().replace(/\s+/g, " ");
                const lower = name.toLowerCase().replace(/^the\s+/, "");
                if (lower.length < 4 || banned.has(lower)) continue;
                if (/^(he|she|they|you|i|we|it)$/i.test(name)) continue;
                const key = getWorldKey(name);
                if (!key || seen.has(key) || key.length < 4) continue;
                seen.add(key);
                out.push({ key, name, sentence: sentence.slice(0, 220) });
                if (out.length >= 4) return out;
            }
        }
        return out;
    };

    const compactWorldMemory = (world, maxKeys = 8) => {
        const keys = Object.keys(world).filter(k => k !== "background");
        if (keys.length <= maxKeys) return world;
        const keep = new Set(keys.slice(-Math.max(1, maxKeys - 1)));
        const merge = keys.filter(key => !keep.has(key));
        const parts = merge.map(key => `${key} is ${world[key]}`);
        for (const key of merge) delete world[key];
        world.background = `${world.background ? `${world.background}; ` : ""}${parts.join("; ")}`.slice(-1600);
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
        let changed = false;
        for (const item of candidates) {
            const value = `${item.name}: ${item.sentence}`;
            if (world[item.key] === value) continue;
            world[item.key] = value;
            changed = true;
        }
        if (!changed) return;
        card.description = serializeWorld(world, config);
        MF.health.worldWrites = (MF.health.worldWrites || 0) + 1;
        const logMsg = `// ${phase || "auto"} world memory update\n${candidates.map(item => `world.${item.key} = ${JSON.stringify(world[item.key])};`).join("\n")}`;
        card.entry = `${card.entry.trim()}\n\n${logMsg}`.trim();
        if (card.entry.length > 2200) {
            card.entry = "// Bounded World Operation Log:\n" + card.entry.split("\n\n").slice(-8).join("\n\n");
        }
    };

    const getWorldContext = (srcText = "", config = {}) => {
        if (!config.autoLore) return "";
        const card = storyCards.find(c => c && typeof c.keys === "string" && c.keys.trim().toLowerCase() === "mindforge_world");
        if (!card || typeof card.description !== "string" || !card.description.trim()) return "";
        const world = deserializeBrain(card.description);
        const sourceLower = String(srcText || "").toLowerCase();
        const lines = [];
        for (const key of Object.keys(world)) {
            if (key === "background") continue;
            const displayKey = cleanKeyForLLM(key).replace(/_(?:of|the|and)$/i, "");
            if (sourceLower.includes(displayKey.replace(/_/g, " ").toLowerCase()) || sourceLower.includes(displayKey.toLowerCase())) {
                lines.push(`- ${displayKey}: ${world[key]}`);
            }
            if (lines.length >= Math.min(config.maxLoreKeys || 8, 4)) break;
        }
        if (!lines.length && world.background) {
            lines.push(`- background: ${world.background}`);
        }
        return lines.length ? `\n# World Memory:\n${lines.join("\n")}\n` : "";
    };

    // Read the configuration story card, creating it on first run.
    const parseConfig = () => {
        const config = {
            enabled: true,
            player: "auto",
            pov: 2,
            chance: 60,
            halfChance: true,
            contextPct: 25,
            lookback: 5,
            pin: false,
            indicator: true,
            decay: 3,
            json: false,
            profile: "balanced",
            scenarioDiscovery: true,
            guardBuffer: 600,
            maxAgents: 3,
            zwspLabels: true,
            rotation: true,
            reflectionChance: 20,
            steward: true,
            agenticCharter: true,
            autoDoctor: true,
            bootstrap: true,
            autoLore: false,
            memorySlots: true,
            qualityGate: true,
            maxBrainKeys: 6,
            maxLoreKeys: 8,
            agents: []
        };

        let card = storyCards.find(c => c && (
            (c.title && c.title.trim().toLowerCase().includes("configure mindforge")) ||
            (typeof c.keys === "string" && c.keys.trim().toLowerCase().includes("mindforge_config"))
        ));
        if (!card) {
            card = addStoryCard(
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

            if (key.includes("enabled")) config.enabled = val.toLowerCase() === "true";
            else if (key.includes("player name")) config.player = val || "protagonist";
            else if (key.includes("pov")) config.pov = clampInt(val, 2, 1, 3);
            else if (key.includes("model profile")) config.profile = ["stable", "balanced", "full"].includes(val.toLowerCase()) ? val.toLowerCase() : "balanced";
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
            else if (key.includes("memory slot")) config.memorySlots = val.toLowerCase() !== "false";
            else if (key.includes("quality gate")) config.qualityGate = val.toLowerCase() !== "false";
            else if (key.includes("max brain keys")) config.maxBrainKeys = clampInt(val, 6, 3, 20);
            else if (key.includes("max lore keys")) config.maxLoreKeys = clampInt(val, 8, 3, 30);
        }
        config.player = resolvePlayerName(config.player);

        if (config.profile === "stable") {
            config.chance = Math.min(config.chance, 35);
            config.contextPct = Math.min(config.contextPct, 18);
            config.maxAgents = Math.min(config.maxAgents, 1);
            config.reflectionChance = 0;
            config.maxBrainKeys = Math.min(config.maxBrainKeys, 5);
        } else if (config.profile === "full") {
            config.maxAgents = Math.max(config.maxAgents, 3);
            config.maxBrainKeys = Math.max(config.maxBrainKeys, 8);
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
        discoverScenarioAgents(config, card);

        // Scan for existing Brain cards to register them as agents
        const seenBrainAgents = {};
        for (const c of storyCards) {
            if (c && typeof c.keys === "string" && c.keys.includes('"agent"')) {
                try {
                    const meta = JSON.parse(c.keys);
                    if (meta && typeof meta.agent === "string") {
                        const name = sanitizeAgentName(meta.agent);
                        if (!name) continue;
                        repairBrainCard(c, name);
                        if (seenBrainAgents[name] && seenBrainAgents[name] !== c) {
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
                if (c.title.trim().startsWith("@")) {
                    c.title = name; // Clean up the title by stripping the '@'
                }
                // Pre-create brain card immediately to persist its registration.
                getBrainCard(name);
                if (!config.agents.some(a => a.name === name)) {
                    config.agents.push({ name, aliases: [name.toLowerCase()] });
                }
            }
        }

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

    const normalizeThought = (value = "") => value
        .toLowerCase()
        .replace(/\d+\s*[-=]*>\s*/g, "")
        .replace(/[^a-z0-9\s]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const isDuplicateThought = (brain, newKey, newValue) => {
        const normalized = normalizeThought(newValue);
        if (normalized.length < 24) return false;
        const newWords = new Set(normalized.split(" ").filter(word => word.length > 2));
        for (const key in brain) {
            if (cleanComparableKey(key) === cleanComparableKey(newKey)) continue;
            if (key === "background") continue;
            const existing = normalizeThought(brain[key]);
            if (!existing) continue;
            if (existing.includes(normalized) || normalized.includes(existing)) {
                return true;
            }
            const existingWords = new Set(existing.split(" ").filter(word => word.length > 2));
            if (newWords.size < 4 || existingWords.size < 4) continue;
            let overlap = 0;
            for (const word of newWords) {
                if (existingWords.has(word)) overlap++;
            }
            const score = overlap / Math.min(newWords.size, existingWords.size);
            if (score >= 0.78) return true;
        }
        return false;
    };

    const getAgentMeta = (agentName, fallback = {}) => {
        const brainCard = getBrainCard(agentName);
        let meta = {};
        if (typeof brainCard.keys === "string") {
            try {
                meta = JSON.parse(brainCard.keys) || {};
            } catch {}
        }
        meta.agent = agentName;
        meta.enabled = meta.enabled !== false;
        meta.budget = clampInt(meta.budget ?? meta.context ?? fallback.contextPct, fallback.contextPct || 25, 1, 95);
        meta.chance = clampInt(meta.chance ?? fallback.chance, fallback.chance || 60, 0, 100);
        brainCard.keys = JSON.stringify(meta);
        return meta;
    };

    // Scan recent turns for NPC names and aliases.
    const detectTriggers = (config) => {
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
            for (let idx = lower.indexOf(alias); idx !== -1; idx = lower.indexOf(alias, idx + 1)) {
                const before = idx > 0 ? lower.charCodeAt(idx - 1) : 0;
                const after = idx + alias.length < lower.length ? lower.charCodeAt(idx + alias.length) : 0;
                if (isAsciiLetter(before) || isAsciiLetter(after)) continue;
                if (strictCapital && source[idx] !== source[idx].toUpperCase()) continue;
                return idx;
            }
            return -1;
        };

        const lookback = config.lookback || 5;
        const startIdx = Math.max(0, history.length - lookback);
        const foundAgents = [];

        for (let i = history.length - 1; i >= startIdx; i--) {
            const action = history[i];
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
                for (const alias of agent.aliases) {
                    const aliasLower = alias.toLowerCase();
                    const idx = findAlias(source, aliasLower, requiresCapital(agent, aliasLower));
                    if (idx !== -1) {
                        foundInTurn.push({ name: agent.name, idx });
                        break;
                    }
                }
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
        return Number.isInteger(turn) ? Math.max(0, history.length - turn) : Infinity;
    };

    const getSlotGuidance = (agentName, config) => {
        if (!config.memorySlots) return "";
        return [
            `Prefer useful durable slots when relevant: relationship_${formatMemoryKey(config.player || "player")}, goal_current, plan_next, secret_hidden.`,
            `Use _state_current for temporary emotion or posture; it decays automatically.`,
            `Use core_* only for durable identity facts about ${agentName}; never use core_* for temporary observations.`
        ].join("\n");
    };

    const getAgenticCharter = (agentName, config) => {
        if (!config.agenticCharter) return "";
        return [
            `Private mind for ${agentName}:`,
            `- treat ${agentName} as a continuous agent with private motives, loyalties, fears, and unfinished plans.`,
            "- let memory shape subtext: what they notice, hide, trust, avoid, want, or decide next.",
            "- preserve identity, relationships, goals, secrets, and plans before surface observations.",
            "- update an existing key when it is the same idea with sharper current information.",
            "- delete or replace stale low-value thoughts when the brain is crowded.",
            "- keep the hidden memory operation small and invisible; continue the story as lived action, not analysis."
        ].join("\n");
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
        if (stats.normalKeys.length > (config.maxBrainKeys || 6)) {
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
        return Math.max(400, max - Math.min(config.guardBuffer || 600, Math.floor(max * 0.6)));
    };

    const applyContextGuard = (srcText, config) => {
        const marker = "<|mindforge|>";
        const limit = getContextLimit(config);
        if (!limit || srcText.length <= limit) {
            return srcText.replace(marker, "");
        }

        bumpHealth("contextGuards");
        let guarded = srcText;
        let excess = guarded.length - limit;
        const recentNeedle = "Recent Story:";
        const recentIdx = guarded.indexOf(recentNeedle);
        const markerIdx = guarded.indexOf(marker);
        const protectedStart = markerIdx === -1 ? guarded.length : markerIdx;

        if (recentIdx !== -1 && recentIdx < protectedStart) {
            const storyStart = recentIdx + recentNeedle.length;
            const storyLength = protectedStart - storyStart;
            const keepRecent = Math.min(2000, Math.floor(limit * 0.45));
            const remove = Math.min(
                excess,
                Math.floor(storyLength * 0.85),
                Math.max(0, storyLength - keepRecent)
            );
            if (remove > 0) {
                guarded = `${guarded.slice(0, storyStart)}${guarded.slice(storyStart + remove)}`;
                excess -= remove;
            }
        }

        if (excess > 0) {
            const newMarkerIdx = guarded.indexOf(marker);
            const protectAt = newMarkerIdx === -1 ? guarded.length : newMarkerIdx;
            const remove = Math.min(excess, Math.max(0, protectAt - 500));
            if (remove > 0) {
                guarded = guarded.slice(remove);
                excess -= remove;
            }
        }

        if (excess > 0 && guarded.length > limit) {
            guarded = guarded.slice(guarded.length - limit);
        }

        return guarded.replace(marker, "");
    };

    const hasDirectDialogPressure = () => {
        const prev = getPrevAction();
        const source = `${prev?.text || prev?.rawText || ""}\n${text || ""}`;
        return /[?"]|(?:\bask(?:s|ed|ing)?\b|\btell(?:s|ing)?\b|\bsay(?:s|ing)?\b|\bspeak(?:s|ing)?\b|\brepl(?:y|ies|ied)\b)/i.test(source);
    };

    const applyAdaptiveProfile = (config) => {
        const next = { ...config, agents: config.agents };
        const failureScore = (MF.health.emptyOutputs || 0) + (MF.health.skippedCommits || 0) + (MF.health.memoryOnlyOutputs || 0) + ((MF.health.errors || 0) * 2);
        const pressureScore = (MF.health.contextGuards || 0) + ((MF.health.loadSheds || 0) * 2);
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
        if (!/[A-Za-z0-9]/.test(clean) || clean.length < 8) return false;
        if (/^(as an ai|as a language model|i cannot|i can't|sorry\b|i am unable|i'm unable)\b/i.test(clean)) {
            return false;
        }
        if (/\b(?:cannot|can't)\s+comply\b/i.test(clean)) return false;
        const words = clean.split(/\s+/).filter(Boolean);
        return words.length >= 2 || clean.length >= 16;
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

    const normalizePrivateThoughtPerspective = (agentName, value = "", config = {}) => {
        const playerName = cleanPlayerName(config.player) || String(config.player || "protagonist").trim();
        if (!playerName) return String(value || "").trim();
        const playerPattern = escapeRegex(playerName);
        const thoughtPrefix = "((?:I\\s+(?:need|must)\\s+to\\s+remember\\s+this|I\\s+remember|I\\s+notice|I\\s+need\\s+to\\s+understand[^:]{0,90}|I\\s+feel[^:]{0,90})\\s*:\\s*)?";
        return String(value || "")
            .replace(new RegExp(`^${thoughtPrefix}${playerPattern}\\s+${observerVerbPattern}\\s+my\\s+eyes\\b`, "i"), "$1my eyes")
            .replace(new RegExp(`(^|[.!?]["'\u201c\u201d]?\\s+)(?:she|he|they)\\s+goes\\s+rigid\\b`, "ig"), "$1my body goes rigid")
            .replace(new RegExp(`(^|[.!?]["'\u201c\u201d]?\\s+)(?:she|he|they)\\s+([A-Za-z]+)\\b`, "ig"), (match, prefix, verb) => `${prefix}I ${toFirstPersonVerb(verb)}`)
            .replace(new RegExp(`\\b(?:her|his|their)\\s+(${privateBodyNounPattern})\\b`, "ig"), "my $1")
            .replace(/\b(?:herself|himself|themselves)\b/ig, "myself")
            .replace(/\s+/g, " ")
            .trim();
    };

    const isQualityThought = (agentName, key, value, brain, config) => {
        if (!config.qualityGate) return true;
        const cleanKey = cleanComparableKey(key);
        const val = String(value || "").trim();
        const lower = val.toLowerCase();
        if (!cleanKey || /^(?:key|any_key|key_name|example_key|thought|memory|note|temp|placeholder)$/.test(cleanKey)) return false;
        if (!/[a-z]/i.test(val) || val.length < 4 || val.length > 260) return false;
        if (/^(?:as an ai|as a language model|i cannot|i can't|sorry\b|i am unable|i'm unable)\b/i.test(val)) return false;
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
        const playerName = String(config.player || "protagonist").trim() || "protagonist";
        const source = String(storyText || "")
            .replace(/<SYSTEM>[\s\S]*?<\/SYSTEM>/g, " ")
            .replace(/<!--mf:[a-zA-Z0-9_]+-->/g, " ")
            .replace(/\u200B[\u200C\u200D]*\u200B?/g, " ")
            .replace(/\[[+=-][^\]]+\]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        if (!source) return null;

        const sentences = source
            .split(/(?<=[.!?])\s+|\n+/)
            .map(item => item.trim().replace(/^["'`]+|["'`]+$/g, ""))
            .filter(item => item.length >= 10 && item.length <= 260 && !isUiChromeLeakLine(item));
        const pool = sentences.length ? sentences : [source.slice(0, 220)];
        const agentLower = String(agentName || "").toLowerCase();
        const playerLower = playerName.toLowerCase();
        const playerNamePattern = escapeRegex(playerName);
        const stripPlayerVocative = (sentence = "") => String(sentence || "")
            .replace(new RegExp(`^${playerNamePattern}\\s*[,;:!?-]+\\s*`, "i"), "")
            .replace(new RegExp(`\\s*[,;:!?-]+\\s*${playerNamePattern}\\s*([.!?])?$`, "i"), "$1")
            .replace(/\s+([.!?])/g, "$1")
            .trim();
        const strongRelationshipPattern = /\b(?:love|loves|loved|divorce|wife|husband|marriage|cheat|cheating|trust|trusts|distrust|distrusts|betray|betrays|betrayal|sorry|forgive|forgives|promise|promises|leave|leaves|left|vanish|vanishes|disappear|disappears|lie|lies|lied|lying)\b|why now|after all this time/i;
        const contextualRelationshipPattern = /\b(?:truth|evidence|secret|hidden|hide|hiding|bury|buried|memory|vault)\b|locked away/i;
        const statePattern = /\b(?:tense|guarded|rigid|tighten|tightens|tightened|stiff|cold|flat|quiet|firm|tired|worn|afraid|fear|angry|anger|hurt|tear|cry|shaken|uneasy|nervous|worried|suspicious|doubt|confused|hesitates?|pulls back|doesn'?t soften|searching)\b/i;
        const hasPlayerCue = (value = "") => {
            const lower = String(value || "").toLowerCase();
            return lower.includes(playerLower) || /\b(?:you|your)\b/i.test(value);
        };
        const isRelationshipEvent = (value = "") => (
            strongRelationshipPattern.test(value) ||
            (contextualRelationshipPattern.test(value) && hasPlayerCue(value))
        );
        const isQuestion = (value = "") => /\?\s*$/.test(String(value || "").trim());
        const cleanEventForThought = (sentence = "") => {
            const agentPattern = escapeRegex(agentName);
            const observerPattern = `(?:you|${playerNamePattern})\\s+${observerVerbPattern}`;
            let clean = stripPlayerVocative(sentence)
                .replace(/^["'`]+|["'`]+$/g, "")
                .replace(new RegExp(`,\\s*["'\u201c\u201d]?\\s*(?:${agentPattern}|she|he|they)\\s+(?:says?|asks?|echoes?|replies?|answers?|whispers?|shouts?)\\b[^.!?]*(?=[.!?]?$)`, "i"), "")
                .replace(new RegExp(`^${observerPattern}\\s+${agentPattern}'s\\b`, "i"), `${agentName}'s`)
                .replace(new RegExp(`^${observerPattern}\\s+(?:her|his|their)\\s+eyes\\b`, "i"), "my eyes")
                .replace(new RegExp(`^${observerPattern}\\s+as\\s+${agentPattern}\\b`, "i"), agentName)
                .replace(new RegExp(`\\b${agentPattern}'s\\b`, "ig"), "my")
                .replace(/\b[Yy]our\b/g, `${playerName}'s`)
                .replace(/\b[Yy]ou\b/g, playerName)
                .replace(new RegExp(`^${agentPattern}\\s+goes\\s+rigid\\b`, "i"), "my body goes rigid")
                .replace(/\s+/g, " ")
                .trim();
            clean = normalizePrivateThoughtPerspective(agentName, clean, config);
            clean = clean.replace(new RegExp(`^${escapeRegex(playerName)}\\s+love\\s+me\\b`, "i"), `${playerName} says ${playerName} loves me`);
            return clean;
        };
        const inferState = (event = "") => {
            const lower = String(event || "").toLowerCase();
            if (/\b(?:afraid|fear|nervous|worried)\b/.test(lower)) return "afraid";
            if (/\b(?:angry|anger)\b/.test(lower)) return "angry";
            if (/\b(?:hurt|tear|cry)\b/.test(lower)) return "hurt";
            if (/\b(?:tired|worn)\b/.test(lower)) return "tired";
            if (/\b(?:suspicious|doubt|lie|lied|hidden|secret|evidence|bury|buried)\b/.test(lower)) return "suspicious";
            if (/\b(?:confused|why|searching)\b/.test(lower)) return "uncertain";
            if (/\b(?:guarded|rigid|cold|flat|firm)\b/.test(lower)) return "guarded";
            return "tense";
        };
        const ensureSentenceEnd = (value = "") => /[.!?]$/.test(value.trim()) ? value.trim() : `${value.trim()}.`;
        const trimThought = (value = "", limit = 240) => {
            const clean = ensureSentenceEnd(String(value || "").replace(/\s+/g, " ").trim());
            return clean.length <= limit ? clean : ensureSentenceEnd(clean.slice(0, limit - 1).trim());
        };
        const buildThoughtValue = (key, event) => {
            const cleanEvent = ensureSentenceEnd(event || "something important changed");
            if (cleanComparableKey(key).startsWith("relationship_")) {
                if (isQuestion(cleanEvent)) {
                    return trimThought(`I need the truth from ${playerName}: ${cleanEvent}`);
                }
                if (/\b(?:divorce|wife|husband|marriage|cheat|cheating|betray|betrayal)\b/i.test(cleanEvent)) {
                    return trimThought(`I can no longer separate ${playerName} from what still stands between us: ${cleanEvent}`);
                }
                return trimThought(`I need to understand where I stand with ${playerName}: ${cleanEvent}`);
            }
            if (cleanComparableKey(key) === "state_current") {
                return trimThought(`I feel ${inferState(cleanEvent)} as this unfolds: ${cleanEvent}`);
            }
            if (isQuestion(cleanEvent)) {
                return trimThought(`I need an answer to this question: ${cleanEvent}`);
            }
            return trimThought(`I need to remember this: ${cleanEvent}`);
        };

        const scored = pool.map((sentence, order) => {
            const lower = sentence.toLowerCase();
            let score = 0;
            if (agentLower && lower.includes(agentLower)) score += 60;
            if (playerLower && lower.includes(playerLower)) score += 35;
            if (/\b(?:she|he|they)\b/i.test(sentence)) score += 12;
            if (isRelationshipEvent(sentence)) score += 75;
            if (statePattern.test(sentence)) score += 35;
            if (/["“”]/.test(sentence)) score += 5;
            return { sentence, order, score };
        }).sort((a, b) => (b.score - a.score) || (a.order - b.order));

        const event = cleanEventForThought(scored[0] ? scored[0].sentence : source.slice(0, 220));
        if (!event) return null;
        const key = isRelationshipEvent(event)
            ? `relationship_${formatMemoryKey(playerName)}`
            : statePattern.test(event)
            ? `_state_current(${config.decay || 3})`
            : "memory_recent";
        const value = buildThoughtValue(key, event);
        return { type: "set", key, val: value, tagKey: cleanKeyForLLM(key), fallback: true };
    };

    const hasComparableKey = (brain, baseKey) => {
        const target = cleanComparableKey(baseKey);
        for (const key in brain) {
            if (cleanComparableKey(key) === target) return true;
        }
        return false;
    };

    const normalizeOperationContent = (content, brain) => {
        const src = String(content || "").trim().replace(/==+/g, "=").replace(/::+/g, ":");
        if (!src) return null;

        const deleteMatch = src.match(/^(?:[-]\s*|del(?:et(?:e[ds]?|ing))?|for(?:get(?:s|ting)?|got(?:ten)?)|remov(?:e[ds]?|ing))\s+([a-zA-Z0-9_\s()]+)$/i);
        if (deleteMatch) {
            const key = formatMemoryKey(deleteMatch[1]);
            return key ? `[-${key}]` : null;
        }

        const signedMatch = src.match(/^([+=-])\s*([a-zA-Z0-9_\s()]+?)(?:\s*[=:]\s*([\s\S]+))?$/);
        if (signedMatch) {
            const sign = signedMatch[1];
            const key = formatMemoryKey(signedMatch[2]);
            const value = (signedMatch[3] || "").trim();
            if (!key) return null;
            if (sign === "-") return `[-${key}]`;
            if (!value) return null;
            if (sign === "=") return `[=${key}: ${formatMemoryKey(value)}]`;
            return `[+${key}: ${value}]`;
        }

        const delimiter = src.includes("=") ? "=" : src.includes(":") ? ":" : "";
        if (!delimiter) return null;
        const idx = src.indexOf(delimiter);
        const key = formatMemoryKey(src.slice(0, idx));
        const value = src.slice(idx + 1).trim();
        if (!key || !value) return null;

        const cleanValueKey = formatMemoryKey(value);
        if (!value.includes(" ") && cleanValueKey && hasComparableKey(brain, cleanValueKey)) {
            return `[=${key}: ${cleanValueKey}]`;
        }
        return `[+${key}: ${value}]`;
    };

    const normalizeOperationSyntax = (srcText, brain) => {
        const candidates = [];
        const blockRegex = /([(\[{])\s*([\s\S]{1,260}?)\s*([)\]}])/g;
        let match;
        while ((match = blockRegex.exec(srcText)) !== null) {
            const normalized = normalizeOperationContent(match[2], brain);
            if (!normalized) continue;
            const sign = normalized.match(/^\[\s*([+=-])/)?.[1] || "";
            const score = (sign === "=" ? 3 : sign === "+" ? 2 : 1) + (match.index === 0 ? 2 : 0);
            candidates.push({ raw: match[0], normalized, score, index: match.index });
        }
        if (!candidates.length) {
            const leading = srcText.trimStart();
            const offset = srcText.length - leading.length;
            const looseDelete = leading.match(/^(?:del(?:et(?:e[ds]?|ing))?|for(?:get(?:s|ting)?|got(?:ten)?)|remov(?:e[ds]?|ing))\s+([a-zA-Z0-9_\s()]{1,80})(?=[.!?\n]|$)/i);
            if (looseDelete) {
                const normalized = normalizeOperationContent(`delete ${looseDelete[1]}`, brain);
                if (normalized) {
                    bumpHealth("parserLooseOps");
                    return `${srcText.slice(0, offset)}${normalized}${leading.slice(looseDelete[0].length)}`;
                }
            }
            const looseAssign = leading.match(/^([a-zA-Z0-9_\s()]{1,80})\s*([=:])\s*([^.!?\n]{4,180}[.!?]?)/);
            if (looseAssign) {
                const normalized = normalizeOperationContent(`${looseAssign[1]}${looseAssign[2]}${looseAssign[3]}`, brain);
                if (normalized) {
                    bumpHealth("parserLooseOps");
                    return `${srcText.slice(0, offset)}${normalized}${leading.slice(looseAssign[0].length)}`;
                }
            }
            return srcText;
        }

        candidates.sort((a, b) => (b.score - a.score) || (a.index - b.index));
        const chosen = candidates[0];
        let usedChosen = false;
        const nextText = srcText.replace(blockRegex, (raw, open, content) => {
            const normalized = normalizeOperationContent(content, brain);
            if (!normalized) return raw;
            if (!usedChosen && raw === chosen.raw && normalized === chosen.normalized) {
                usedChosen = true;
                return normalized;
            }
            return "";
        }).replace(/\s{2,}/g, " ");

        bumpHealth(candidates.length > 1 ? "parserMultiOps" : "parserNormalizations");
        return nextText;
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
        const currentTurn = history.length;
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

    if (!config.enabled) {
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
                    outputMsg += `- Model Profile: ${config.profile}\n`;
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
                    outputMsg += `- Scenario Discoveries: ${MF.health.scenarioDiscoveries || 0}\n`;
                    outputMsg += `- World Writes: ${MF.health.worldWrites || 0}\n`;
                    outputMsg += `- World Compacts: ${MF.health.worldCompacts || 0}\n`;
                    outputMsg += `- Parser Normalizations: ${MF.health.parserNormalizations || 0}\n`;
                    outputMsg += `- Parser Multi-Ops: ${MF.health.parserMultiOps || 0}\n`;
                    outputMsg += `- Config Migrations: ${MF.health.configMigrations || 0}\n`;
                    outputMsg += `- Brain Repairs: ${MF.health.brainRepairs || 0}\n`;
                    outputMsg += `- Adaptive Shifts: ${MF.health.adaptiveShifts || 0}\n`;
                    outputMsg += `- Runtime Errors: ${MF.health.errors || 0}\n\n`;
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
        return;
    }

    // 2. CONTEXT HOOK: Multi-NPC thoughts injection and decay
    if (hook === "context") {
        MF.agent = "";

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

        let activeAgents = detectTriggers(config).filter(name => getAgentMeta(name, config).enabled);
        if (
            MF.scene.agent &&
            !activeAgents.includes(MF.scene.agent) &&
            recentHistoryMentionsAgent(config, MF.scene.agent) &&
            getAgentMeta(MF.scene.agent, config).enabled
        ) {
            activeAgents.push(MF.scene.agent);
        }
        if (MF.scene.agent && activeAgents.includes(MF.scene.agent) && activeAgents[0] !== MF.scene.agent && MF.scene.ttl > 0) {
            activeAgents = [MF.scene.agent, ...activeAgents.filter(name => name !== MF.scene.agent)];
            MF.scene.ttl--;
            bumpHealth("sceneLocks");
        }
        const limit = getContextLimit(config);
        const pressure = limit ? text.length / limit : 0;
        if (pressure > 0.92 && activeAgents.length > 1) {
            activeAgents = activeAgents.slice(0, 1);
            bumpHealth("loadSheds");
        } else if (pressure > 0.78 && activeAgents.length > 2) {
            activeAgents = activeAgents.slice(0, 2);
            bumpHealth("loadSheds");
        }

        if (activeAgents.length === 0) {
            MF.scene = { agent: "", ttl: 0 };
            text = text
                .replace(/<!--mf:[a-zA-Z0-9_]+-->/g, "")
                .replace(/\u200B[\u200C\u200D]+\u200B/g, "");
            deindicateAll(); // Strip all indicators since no NPC is active
            return;
        }

        const decodedLabels = decodeThoughtLabels(text, activeAgents);
        text = decodedLabels.text.replace(/<!--mf:[a-zA-Z0-9_]+-->/g, "");

        const primaryAgent = activeAgents[0];
        const primaryMeta = getAgentMeta(primaryAgent, config);
        MF.scene = { agent: primaryAgent, ttl: 2 };
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
        const maxBrainChars = Math.max(320, Math.floor((config.contextPct / 100) * text.length));
        const budgets = allocateBudgets(maxBrainChars, activeAgents.length);
        const isRetry = MF.hash === getHistoryHash();
        let primarySteward = null;

        for (let idx = 0; idx < activeAgents.length; idx++) {
            const agentName = activeAgents[idx];
            const isPrimary = idx === 0;
            const agentMeta = getAgentMeta(agentName, config);
            const budgetScale = Math.min(2, Math.max(0.25, agentMeta.budget / Math.max(1, config.contextPct)));
            const budget = Math.max(80, Math.floor((budgets[idx] || 120) * budgetScale));

            const brainCard = getBrainCard(agentName);
            let brain = deserializeBrain(brainCard.description);

            // Apply turn-based decay on active/present NPC
            const { brain: decayedBrain, modified } = decayVolatileMemories(brain, isRetry, config.decay);
            if (modified) {
                brain = decayedBrain;
                brainCard.description = serializeBrain(brain, agentName);
            }

            if (isPrimary) {
                primarySteward = chooseBrainTask(agentName, brain, config, pressure);
                const stats = getBrainStats(brain);
                const sparseBrain = stats.keys.length > 0 && stats.keys.length < Math.min(3, config.maxBrainKeys || 6);
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
            const recentTags = [...scanMemoryTags(text, 5), ...decodedLabels.keys];
            let brainStr = "";
            const rotationSeed = hashText(`${getHistoryHash()}:${agentName}:${Object.keys(brain).join("|")}`);
            const allThoughts = rankThoughtsForContext(agentName, brain, text, recentTags, rotationSeed, config.rotation);
            for (const tObj of allThoughts) {
                const displayKey = cleanKeyForLLM(tObj.key);
                const label = (MF.labels[agentName] || {})[tObj.key];
                const labelSuffix = Number.isInteger(label) ? ` [${label}]` : "";
                const line = `- ${displayKey}: ${tObj.val}${labelSuffix}\n`;
                if (brainStr.length + line.length > budget) break;
                brainStr += line;
                touchMemory(agentName, tObj.key, "seen");
            }

            if (brainStr) {
                const status = isPrimary ? "Active" : "Present";
                const ownershipName = agentName.toLowerCase().endsWith("s") ? `${agentName}'` : `${agentName}'s`;
                contextSegments.push({
                    primary: isPrimary,
                    text: `\n# ${ownershipName} Brain Thoughts (${status}):\n${brainStr}`
                });
            }
        }

        const worldContext = getWorldContext(text, config);
        const contextInjection = [
            worldContext,
            ...contextSegments.filter(segment => !segment.primary).map(segment => segment.text),
            ...contextSegments.filter(segment => segment.primary).map(segment => segment.text)
        ].join("");

        // Apply turn-based thought chance reduction on player turns
        const lastAct = getPrevAction();
        const isPlayerAction = lastAct && (lastAct.type === "do" || lastAct.type === "say" || lastAct.type === "story");
        const memoryOnlyAge = MF.memoryOnly && Number.isInteger(MF.memoryOnly.turn)
            ? history.length - MF.memoryOnly.turn
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
        const triggerChance = (finalChance / 100) > Math.random();
        const marker = "<|mindforge|>";
        const contextHistoryHash = getHistoryHash();

        if (!isRetry && triggerChance) {
            MF.pendingMemory = { agent: primaryAgent, hash: contextHistoryHash, turn: history.length };
            const povText = config.pov === 1 
                ? `first-person POV (as ${config.player})` 
                : config.pov === 3 
                ? "third-person POV" 
                : "second-person ('you') POV";
            const refocus = (
                config.reflectionChance > 0 &&
                !hasDirectDialogPressure() &&
                (config.reflectionChance / 100) > Math.random()
            ) ? `\n- If useful, focus ${primaryAgent}'s thought on self-reflection or a future plan instead of surface observation.` : "";

            const promptProfile = config.runtimeProfile === "guarded" ? "stable" : config.profile;
            const stewardLabel = primarySteward ? primarySteward.label : "write or update one non-duplicate thought";
            const slotGuidance = getSlotGuidance(primaryAgent, config);
            const agenticCharter = getAgenticCharter(primaryAgent, config);
            const rules = promptProfile === "stable"
                ? `<SYSTEM>\nContinue the story in ${povText}. If it fits naturally, include one short hidden memory operation for ${primaryAgent}: [+key: thought], [-key], or [=new_key: old_key]. Visible story prose is mandatory; never output the memory operation by itself.\n${agenticCharter}\n</SYSTEM>\n\n`
                : promptProfile === "full"
                ? `<SYSTEM>\n# MindForge Brain Steward: ${primaryAgent}\nChoose the single best memory operation for this turn.\nPriority: ${stewardLabel}\n${agenticCharter}\nAllowed forms:\n- [+key: first-person thought of ${primaryAgent} using names, no pronouns]\n- [-key]\n- [=new_key: old_key]\n${slotGuidance}\nRules:\n- Use at most one bracket operation, then one space, then story prose in ${povText}.\n- Visible story prose is mandatory; never output the memory operation by itself.\n- Prefer update, rename, or delete over creating duplicates.\n- Never delete core_* keys.\n- Continue directly from the last moment.\n</SYSTEM>\n\n`
                : `<SYSTEM>\n# MindForge NPC ${primaryAgent} Memory Operation\nContinue the story in ${povText}; visible story prose is mandatory.\nPriority: ${stewardLabel}\n${agenticCharter}\n${slotGuidance}\nForms:\n- [+key: 1st person thought of ${primaryAgent} using names, no pronouns]\n- [-key]\n- [=new_key: old_key]\nUse at most one bracket operation before or after the prose. Never output the memory operation by itself. If no natural story prose follows, skip the memory operation.\nExample: [+goal_current: I must help ${config.player}.] Story continues...\n</SYSTEM>\n\n`;
            const enhancedRules = rules.replace("\n</SYSTEM>", `${refocus}\n</SYSTEM>`);

            text = applyContextGuard(text.trimEnd() + marker + (contextInjection ? "\n" + contextInjection + "\n" : "") + "\n\n" + enhancedRules, config);
        } else {
            if (MF.pendingMemory && MF.pendingMemory.agent === primaryAgent) {
                MF.pendingMemory = { agent: "", hash: "", turn: -999 };
            }
            const povText = config.pov === 1 
                ? `first-person POV (as ${config.player})` 
                : config.pov === 3 
                ? "third-person POV" 
                : "second-person ('you') POV";

            const passiveRules = `<SYSTEM>\nAlways continue the story in ${povText}.\n</SYSTEM>\n\n`;
            text = applyContextGuard(text.trimEnd() + marker + (contextInjection ? "\n" + contextInjection + "\n" : "") + "\n\n" + passiveRules, config);
        }

        return;
    }

    // 3. OUTPUT HOOK: Parse memories, overwrite keys, clean system tags
    if (hook === "output") {
        const agentName = MF.agent;
        MF.agent = ""; // Reset for next turn

        if (!text || text.trim() === "") {
            bumpHealth("emptyOutputs");
            text = "\u200B";
            return;
        }

        // Always strip system instructions/rules blocks first
        text = text.replace(/<SYSTEM>[\s\S]*?<\/SYSTEM>/g, "").trim();
        if (text === "") {
            bumpHealth("emptyOutputs");
            text = "\u200B";
            return;
        }

        const uiCleaned = stripUiChromeLeaks(text);
        if (uiCleaned.removed) {
            text = uiCleaned.text;
            MF.health.uiLeakSkips = (MF.health.uiLeakSkips || 0) + uiCleaned.removed;
            if (text === "") {
                bumpHealth("emptyOutputs");
                text = "\u200B";
                return;
            }
        }

        if (!agentName) {
            return;
        }

        // --- ENHANCED COMMAND HEALING ---

        // 1. Repair missing brackets if output starts with prefix command
        if (text.trim().startsWith("+") || text.trim().startsWith("-") || text.trim().startsWith("=")) {
            const prefixRegex = /^([-+=])\s*([a-zA-Z0-9_\s()]+)(?:\s*:\s*([^.!?\n]+[.!?]?))/;
            const match = text.trim().match(prefixRegex);
            if (match) {
                const sign = match[1];
                const key = formatMemoryKey(match[2].trim().replace(/\s+/g, "_"));
                const val = match[3] ? match[3].trim() : "";
                const command = val ? `[${sign}${key}: ${val}]` : `[${sign}${key}]`;
                text = command + " " + text.trim().replace(prefixRegex, "").trim();
            }
        }

        // 2. Auto-close unclosed opening brackets
        if (text.includes("[") && !text.includes("]")) {
            const openIdx = text.indexOf("[");
            const sub = text.slice(openIdx);
            const colonIdx = sub.indexOf(":");
            if (colonIdx !== -1) {
                let endIdx = -1;
                const sentenceEndRegex = /[.!?]/g;
                let m;
                while ((m = sentenceEndRegex.exec(sub)) !== null) {
                    if (m.index > colonIdx) {
                        endIdx = m.index;
                        break;
                    }
                }
                if (endIdx !== -1) {
                    text = text.slice(0, openIdx + endIdx + 1) + "]" + text.slice(openIdx + endIdx + 1);
                } else {
                    if (sub.length > 80) {
                        text = text.slice(0, openIdx + 80) + "]" + text.slice(openIdx + 80);
                    } else {
                        text = text.trimEnd() + "]";
                    }
                }
            } else {
                const spaceIdx = sub.indexOf(" ");
                if (spaceIdx !== -1) {
                    text = text.slice(0, openIdx + spaceIdx) + "]" + text.slice(openIdx + spaceIdx);
                } else {
                    text = text.trimEnd() + "]";
                }
            }
        }

        // 3. Auto-close unclosed opening parentheses
        if (text.includes("(") && !text.includes(")")) {
            const openIdx = text.indexOf("(");
            const sub = text.slice(openIdx);
            const eqIdx = sub.indexOf("=");
            const colonIdx = sub.indexOf(":");
            const delimiterIdx = eqIdx !== -1 ? eqIdx : colonIdx;
            if (delimiterIdx !== -1) {
                let endIdx = -1;
                const sentenceEndRegex = /[.!?]/g;
                let m;
                while ((m = sentenceEndRegex.exec(sub)) !== null) {
                    if (m.index > delimiterIdx) {
                        endIdx = m.index;
                        break;
                    }
                }
                if (endIdx !== -1) {
                    text = text.slice(0, openIdx + endIdx + 1) + ")" + text.slice(openIdx + endIdx + 1);
                } else {
                    if (sub.length > 80) {
                        text = text.slice(0, openIdx + 80) + ")" + text.slice(openIdx + 80);
                    } else {
                        text = text.trimEnd() + ")";
                    }
                }
            } else {
                const spaceIdx = sub.indexOf(" ");
                if (spaceIdx !== -1) {
                    text = text.slice(0, openIdx + spaceIdx) + ")" + text.slice(openIdx + spaceIdx);
                } else {
                    text = text.trimEnd() + ")";
                }
            }
        }

        // 4. Auto-close unclosed opening curly braces
        if (text.includes("{") && !text.includes("}")) {
            const openIdx = text.indexOf("{");
            const sub = text.slice(openIdx);
            const eqIdx = sub.indexOf("=");
            const colonIdx = sub.indexOf(":");
            const delimiterIdx = eqIdx !== -1 ? eqIdx : colonIdx;
            if (delimiterIdx !== -1) {
                let endIdx = -1;
                const sentenceEndRegex = /[.!?]/g;
                let m;
                while ((m = sentenceEndRegex.exec(sub)) !== null) {
                    if (m.index > delimiterIdx) {
                        endIdx = m.index;
                        break;
                    }
                }
                if (endIdx !== -1) {
                    text = text.slice(0, openIdx + endIdx + 1) + "}" + text.slice(openIdx + endIdx + 1);
                } else {
                    if (sub.length > 80) {
                        text = text.slice(0, openIdx + 80) + "}" + text.slice(openIdx + 80);
                    } else {
                        text = text.trimEnd() + "}";
                    }
                }
            } else {
                const spaceIdx = sub.indexOf(" ");
                if (spaceIdx !== -1) {
                    text = text.slice(0, openIdx + spaceIdx) + "}" + text.slice(openIdx + spaceIdx);
                } else {
                    text = text.trimEnd() + "}";
                }
            }
        }

        // Normalize all opening/closing mismatched or matched command-like enclosures to standard brackets [ ... ]
        text = text.replace(/([(\[{])\s*([\s\S]+?)\s*([)\]}])/g, (m, open, content, close) => {
            const trimmedContent = content.trim();
            const startsWithSign = /^[-+=]/.test(trimmedContent);
            const startsWithWord = /^(?:del(?:et(?:e[ds]?|ing))?|for(?:get(?:s|ting)?|got(?:ten)?)|remov(?:e[ds]?|ing))\s/i.test(trimmedContent);
            const isAssignment = /^[a-zA-Z0-9_\s()]+?\s*[=:]\s*/.test(trimmedContent);

            if (startsWithSign || startsWithWord || isAssignment) {
                return `[${trimmedContent}]`;
            }
            return m; // return unchanged
        });

        // Fetch brain early to facilitate translation logic
        const brainCard = getBrainCard(agentName);
        const brain = deserializeBrain(brainCard.description);
        text = normalizeOperationSyntax(text, brain);

        // Translate bracket delete commands (e.g. [delete key])
        const bracketDelRegex = /\[\s*(?:del(?:et(?:e[ds]?|ing))?|for(?:get(?:s|ting)?|got(?:ten)?)|remov(?:e[ds]?|ing))\s+([a-zA-Z0-9_\s()]+)\s*\]/ig;
        text = text.replace(bracketDelRegex, "[-$1]");

        // Translate bracket set/rename commands (e.g. [key = val])
        const bracketAssignRegex = /\[\s*([a-zA-Z0-9_\s()]+?)\s*([=:])\s*([^\]]+)\s*\]/g;
        text = text.replace(bracketAssignRegex, (match, keyRaw, delimiter, valRaw) => {
            const key = formatMemoryKey(keyRaw.trim().replace(/\s+/g, "_"));
            const val = valRaw.trim();
            const cleanVal = val.replace(/\(\d+\)$/, "").toLowerCase();
            let isRename = false;
            if (!val.includes(" ")) {
                for (const k in brain) {
                    if (k.replace(/^\_/, "").replace(/\(\d+\)$/, "").toLowerCase() === cleanVal) {
                        isRename = true;
                        break;
                    }
                }
            }
            if (isRename) {
                return `[=${key}: ${val}]`;
            } else {
                return `[+${key}: ${val}]`;
            }
        });

        // Parse bracket operation
        const opRegex = /\[\s*([+-=])\s*([a-zA-Z0-9_\s()]+)(?:\s*:\s*([^\]]+))?\s*\]/;
        const match = text.match(opRegex);

        let pendingOp = null;
        const currentHash = getHistoryHash();
        const isRetry = MF.hash === currentHash;

        if (match) {
            const sign = match[1];
            const keyRaw = formatMemoryKey(match[2].trim().replace(/\s+/g, "_"));
            const valRaw = match[3] ? match[3].trim() : "";
            // Clean value: strip surrounding quotes and simplify formatting
            let val = valRaw.replace(/^["'`«»„“”(")]+|[ "'`«»„“”)]+$/g, "").trim();
            val = val.replace(/[*#~]+/g, "").replace(/\s+/g, " ").replaceAll("…", "...");

            if (isRetry) {
                bumpHealth("retrySkips");
            } else {
                if (sign === "+" && keyRaw && val) {
                    let key = keyRaw;
                    if (keyRaw.startsWith("_") && !keyRaw.includes("(")) {
                        key = `${keyRaw}(${config.decay || 3})`; // config decay count
                    }
                    pendingOp = { type: "set", key, val, tagKey: cleanKeyForLLM(key), hash: currentHash };
                } else if (sign === "-" && keyRaw) {
                    pendingOp = { type: "delete", key: keyRaw, hash: currentHash };
                } else if (sign === "=" && keyRaw && val) {
                    const oldKeyRaw = formatMemoryKey(val.replace(/\s+/g, "_"));
                    let actualOldKey = null;
                    let foundVal = null;
                    const cleanOld = oldKeyRaw.replace(/^\_/, "").replace(/\(\d+\)$/, "").toLowerCase();
                    for (const k in brain) {
                        const currentClean = k.replace(/^\_/, "").replace(/\(\d+\)$/, "").toLowerCase();
                        if (currentClean === cleanOld) {
                            if (isCoreKey(k)) break;
                            foundVal = brain[k];
                            actualOldKey = k;
                            break;
                        }
                    }

                    if (actualOldKey) {
                        let key = keyRaw;
                        if (keyRaw.startsWith("_") && !keyRaw.includes("(")) {
                            key = `${keyRaw}(${config.decay || 3})`; // config decay count
                        }
                        pendingOp = { type: "rename", key, oldKey: actualOldKey, val: foundVal, hash: currentHash };
                    }
                }
            }

            text = text.replace(opRegex, "").trim();
        }

        // --- OUTPUT SANITIZATION ---
        const lines = text.split("\n");
        const cleanedLines = [];
        const playerNameLower = (config.player || "protagonist").toLowerCase();
        const activeAgentLower = agentName ? agentName.toLowerCase() : "";
        let removedUnsafeLine = false;

        for (let line of lines) {
            const lower = line.toLowerCase();
            // Check if line contains leaked instructions or system prompt leftovers
            let isNpcLeak = false;
            if (activeAgentLower && lower.includes(`you are ${activeAgentLower}`)) {
                isNpcLeak = true;
            }
            if (config.agents) {
                for (const agent of config.agents) {
                    if (lower.includes(`you are ${agent.name.toLowerCase()}`)) {
                        isNpcLeak = true;
                        break;
                    }
                    if (agent.aliases) {
                        for (const alias of agent.aliases) {
                            if (lower.includes(`you are ${alias}`)) {
                                isNpcLeak = true;
                                break;
                            }
                        }
                    }
                    if (isNpcLeak) break;
                }
            }

            const uiLeakLine = isUiChromeLeakLine(line);
            const shouldDropLine = (
                uiLeakLine ||
                lower.includes("strict output") ||
                lower.includes("output format") ||
                lower.includes("bracket operation") ||
                lower.includes("thought of") ||
                lower.includes("to forget") ||
                lower.includes("to rename") ||
                lower.includes("story continues") ||
                lower.includes("configure mindforge") ||
                lower.includes("mindforge npc") ||
                lower.includes(`you are ${playerNameLower}`) ||
                isNpcLeak ||
                lower.includes("system instruction") ||
                /^(as an ai|as a language model|i cannot|i can't|sorry\b|i am unable|i'm unable)\b/i.test(line.trim()) ||
                /\b(?:cannot|can't)\s+comply\b/i.test(line.trim()) ||
                // Leftover unparsed operations that might have leaked
                /^\[\s*[-+=].*\]$/.test(line.trim()) ||
                /^\(\s*[-+=].*\)$/.test(line.trim()) ||
                /^\(\s*(?:del(?:et(?:e[ds]?|ing))?|for(?:get(?:s|ting)?|got(?:ten)?)|remov(?:e[ds]?|ing)).*\)$/i.test(line.trim()) ||
                /^\(\s*[a-zA-Z0-9_\s()]+?\s*[=:]\s*.*\)$/.test(line.trim()) ||
                /^\{\s*[-+=].*\}$/.test(line.trim()) ||
                /^\{\s*(?:del(?:et(?:e[ds]?|ing))?|for(?:get(?:s|ting)?|got(?:ten)?)|remov(?:e[ds]?|ing)).*\}$/i.test(line.trim()) ||
                /^\{\s*[a-zA-Z0-9_\s()]+?\s*[=:]\s*.*\}$/.test(line.trim())
            );
            if (shouldDropLine) {
                removedUnsafeLine = true;
                if (uiLeakLine) {
                    bumpHealth("uiLeakSkips");
                }
                continue;
            }
            cleanedLines.push(line);
        }
        text = cleanedLines.join("\n").trim();

        let prefixText = "";
        const hasNarrative = isUsableNarrative(text);
        if (!pendingOp && hasNarrative && !isRetry && MF.pendingMemory && MF.pendingMemory.agent === agentName && MF.pendingMemory.hash === currentHash) {
            pendingOp = buildFallbackMemoryOp(agentName, text, config);
            if (pendingOp) {
                pendingOp.hash = currentHash;
            }
        }
        const memoryOnlyOutput = !!(pendingOp && !hasNarrative && text === "" && !removedUnsafeLine);
        if (pendingOp && !hasNarrative && text === "") {
            MF.memoryOnly = { agent: agentName, turn: history.length };
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
                const canFallbackFromRejectedSet = () => (
                    hasNarrative &&
                    !setOp.fallback &&
                    MF.pendingMemory &&
                    MF.pendingMemory.agent === agentName &&
                    MF.pendingMemory.hash === currentHash
                );
                if (!isQualityThought(agentName, setOp.key, setOp.val, brain, config)) {
                    bumpHealth("thoughtQualitySkips");
                    bumpHealth("qualitySkips");
                    const fallbackOp = canFallbackFromRejectedSet() ? buildFallbackMemoryOp(agentName, text, config) : null;
                    if (fallbackOp) {
                        fallbackOp.hash = setOp.hash;
                        setOp = {
                            ...fallbackOp,
                            val: normalizePrivateThoughtPerspective(agentName, fallbackOp.val, config)
                        };
                        if (!isQualityThought(agentName, setOp.key, setOp.val, brain, config)) {
                            bumpHealth("thoughtQualitySkips");
                            bumpHealth("qualitySkips");
                            commitSet = false;
                        } else if (isDuplicateThought(brain, setOp.key, setOp.val)) {
                            bumpHealth("duplicateSkips");
                            commitSet = false;
                        }
                    } else {
                        commitSet = false;
                    }
                } else if (isDuplicateThought(brain, setOp.key, setOp.val)) {
                    bumpHealth("duplicateSkips");
                    commitSet = false;
                }

                if (!commitSet) {
                    MF.ops--;
                } else {
                    removeFromBrain(brain, setOp.key, { allowCore: true });
                    removeLabelsForKey(agentName, setOp.key);
                    brain[setOp.key] = setOp.val;
                    touchMemory(agentName, setOp.key, "write");
                    const label = ensureThoughtLabel(agentName, setOp.key);
                    if (hasNarrative) {
                        prefixText = config.zwspLabels ? encodeLabel(label) : `<!--mf:${setOp.tagKey}-->`;
                    }
                    logMsg = `// operation ${MF.ops}\n${agentName.toLowerCase()}.${setOp.key} = ${JSON.stringify(setOp.val)};`;
                    if (setOp.fallback) {
                        bumpHealth("fallbackMemoryWrites");
                    }
                }
            } else if (pendingOp.type === "delete") {
                if (isCoreKey(pendingOp.key)) {
                    bumpHealth("coreSkips");
                    MF.ops--;
                } else {
                    const deleted = removeFromBrain(brain, pendingOp.key);
                    removeLabelsForKey(agentName, pendingOp.key);
                    forgetMemoryMeta(agentName, pendingOp.key);
                    if (deleted) {
                        logMsg = `// operation ${MF.ops}\ndelete ${agentName.toLowerCase()}.${pendingOp.key};`;
                    } else {
                        MF.ops--;
                    }
                }
            } else if (pendingOp.type === "rename") {
                if (isCoreKey(pendingOp.oldKey) || isCoreKey(pendingOp.key)) {
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
                MF.lastWrite[agentName] = history.length;
                if (MF.pendingMemory && MF.pendingMemory.agent === agentName) {
                    MF.pendingMemory = { agent: "", hash: "", turn: -999 };
                }
                brainCard.entry = `${brainCard.entry.trim()}\n\n${logMsg}`.trim();
                if (brainCard.entry.length > 2500) {
                    brainCard.entry = "// Bounded Operation Log:\n" + brainCard.entry.split("\n\n").slice(-10).join("\n\n");
                }
                brainCard.description = serializeBrain(brain, agentName);
            }
        } else if (pendingOp) {
            bumpHealth("skippedCommits");
            bumpHealth("qualitySkips");
        }

        if (hasNarrative) {
            updateWorldMemory(text, config, "output");
        }

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
