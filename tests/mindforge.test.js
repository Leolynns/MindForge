/**
 * MindForge regression tests.
 */

// Minimal AI Dungeon runtime shim.
globalThis.state = {};
globalThis.info = { maxChars: 4000 };
globalThis.storyCards = [];
globalThis.history = [];
globalThis.text = "";

globalThis.addStoryCard = function(keys, entry, type, title, description, options) {
    const card = { keys, entry, type, title, description };
    globalThis.storyCards.push(card);
    if (options && options.returnCard) {
        return card;
    }
};

const fs = require('fs');
const path = require('path');
const libraryCode = fs.readFileSync(path.join(__dirname, '../src/library.js'), 'utf8');

eval(libraryCode);

console.log("=== Running MindForge Tests ===\n");

function assert(condition, message) {
    if (!condition) {
        console.error("FAIL:", message);
        process.exit(1);
    } else {
        console.log("PASS:", message);
    }
}

// --- Test 1: Config card creation and parsing (Aliases support) ---
MindForge("input"); // Run any hook to initialize config card
const configCard = globalThis.storyCards.find(c => c.title.includes("Configure MindForge"));
assert(configCard !== undefined, "Configuration card should be created automatically.");
assert(!configCard.description.includes("Clara") && !configCard.description.includes("Marcus"), "Default configuration should not ship demo NPCs.");

// Let's modify the config card to add some NPCs and aliases
configCard.entry = "MindForge Configuration\n\nAdjust the values below. Keep the colon and space.\n\nEnabled: true\nPlayer Name: Alex\nPOV (1=1st, 2=2nd, 3=3rd): 2\nThought Chance (0-100): 100\nMax Brain Context (1-95): 25\nLookback Turns (1-20): 5";
configCard.description = "NPC Names (First name followed by comma-separated aliases):\nClara, princess, her highness\nMarcus, captain, Sir Marcus, warrior";

// Run hook again to parse new config
MindForge("input");

// --- Test 2: Trigger Detection & Alias Resolution ---
// Pre-create brains
const claraBrainCard = globalThis.addStoryCard(
    JSON.stringify({ agent: "Clara" }),
    `// MindForge Brain Card initialized @ UTC\n// Operation Log:\n`,
    "Brain",
    "Clara Brain",
    "feeling: Clara feels happy to see Alex.",
    { returnCard: true }
);

const marcusBrainCard = globalThis.addStoryCard(
    JSON.stringify({ agent: "Marcus" }),
    `// MindForge Brain Card initialized @ UTC\n// Operation Log:\n`,
    "Brain",
    "Marcus Brain",
    "duty: Marcus must defend Clara.",
    { returnCard: true }
);

// Set history using an alias for Clara ("the princess")
globalThis.history = [
    { text: "You arrive at the castle gates.", type: "story" },
    { text: "The princess sighs and looks at the sky.", type: "story" } // "princess" alias matches Clara
];

globalThis.text = "You talk to her.";
MindForge("context");

assert(globalThis.state.MindForge.agent === "Clara", "Alias matching should trigger Clara when 'princess' is mentioned.");
assert(globalThis.text.includes("Clara's Brain Thoughts (Active):"), "Clara should be active.");
assert(globalThis.text.includes("- feeling: Clara feels happy to see Alex."), "Clara's feeling should be injected.");

// --- Test 3: Multi-NPC Co-presence & Dialog Routing ---
// Mention Marcus ("warrior") and Clara ("princess") in lookback window
globalThis.history = [
    { text: "The warrior stands guard near the door.", type: "story" }, // matches Marcus
    { text: "The princess smiles warmly at you.", type: "story" }      // matches Clara
];

globalThis.text = "What is the plan?";
MindForge("context");

// Both should be in the context!
assert(globalThis.state.MindForge.agent === "Clara", "Clara (most recent) should be the primary agent.");
assert(globalThis.text.includes("Clara's Brain Thoughts (Active):"), "Clara thoughts should be marked Active.");
assert(globalThis.text.includes("Marcus' Brain Thoughts (Present):"), "Marcus thoughts should be marked Present (Co-presence).");
assert(globalThis.text.includes("- duty: Marcus must defend Clara."), "Marcus's thoughts should be injected passively.");

// --- Test 4: Volatile Memory with Decay Count ---
// Set Clara's brain description to include a volatile thought
claraBrainCard.description = "_mood(2): angry\nfeeling: Clara feels happy to see Alex.";

// Reset history hash so it is not marked retry
globalThis.history.push({ text: "The princess smiles warmly at you.", type: "continue" });
globalThis.text = "You greet her.";

MindForge("context");

// In injected context, the counter and underscore should be stripped for LLM visibility
assert(globalThis.text.includes("- mood: angry"), "LLM should see 'mood: angry' without underscore or parenthesis.");
assert(!globalThis.text.includes("_mood(2)"), "LLM context shouldn't expose underscore and decay counter.");

// Check Clara's brain card in storyCards: the counter should have decayed by 1
let parsedClaraBrain = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});

assert(parsedClaraBrain["_mood(1)"] === "angry", "Volatile memory counter should decay from 2 to 1.");

// Push another turn and trigger context again to decrement to 0 (delete)
globalThis.history.push({ text: "Clara nods in response.", type: "continue" });
globalThis.text = "You nod back.";
MindForge("context");

parsedClaraBrain = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});

assert(parsedClaraBrain["_mood(0)"] === undefined && parsedClaraBrain["_mood"] === undefined, "Volatile memory should be deleted after counting down to 0.");

// --- Test 5: Volatile Overwriting and Deletion Healing ---
// Set volatile memory
claraBrainCard.description = "_mood(2): angry";
globalThis.state.MindForge.agent = "Clara";
globalThis.history.push({ text: "Clara turns to you.", type: "continue" });

// Output command overwrite: [+_mood: happy]
globalThis.text = "[+_mood: happy] Clara looks pleased.";
MindForge("output");

parsedClaraBrain = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});

assert(parsedClaraBrain["_mood(3)"] === "happy", "New memory [+_mood] should overwrite _mood(2) and get default decay (3).");
assert(parsedClaraBrain["_mood(2)"] === undefined, "Old _mood(2) should be removed.");

// Deleting volatile memory: [-_mood]
globalThis.history.push({ text: "Clara looks pleased.", type: "continue" });
globalThis.state.MindForge.agent = "Clara";
globalThis.text = "[-_mood] Clara stops smiling.";
MindForge("output");

parsedClaraBrain = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});

assert(parsedClaraBrain["_mood(3)"] === undefined, "[-_mood] should delete the volatile memory.");

// --- Test 6: Player OOC Commands ---
// List command: /mf list
globalThis.text = "/mf list";
MindForge("input");
assert(globalThis.text.includes("🧩 [MindForge System Status]"), "OOC list command should return system status.");
assert(globalThis.text.includes("- Clara"), "Status should list configured NPCs.");

// Set command: /mf set Clara relationship friendly
globalThis.text = "/mf set Clara relationship friendly";
MindForge("input");
assert(globalThis.text.includes("✅ Set [relationship] to \"friendly\""), "OOC set command should verify success.");

parsedClaraBrain = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});
assert(parsedClaraBrain.relationship === "friendly", "Brain card should be modified by OOC set command.");

// Forget command: /mf forget Clara relationship
globalThis.text = "/mf forget Clara relationship";
MindForge("input");
assert(globalThis.text.includes("✅ Forgot key [relationship]"), "OOC forget command should verify success.");

parsedClaraBrain = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});
assert(parsedClaraBrain.relationship === undefined, "Brain card should be cleared of forgotten key.");

// --- Test 7: Rename Operator [=new_key: old_key] ---
claraBrainCard.description = "feeling: Clara feels happy to see Alex.";
globalThis.state.MindForge.agent = "Clara";
globalThis.history.push({ text: "Clara turns to you.", type: "continue" });
globalThis.text = "[=mood: feeling] Clara smiles at Alex.";

MindForge("output");

parsedClaraBrain = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});

assert(parsedClaraBrain.mood === "Clara feels happy to see Alex.", "Rename operator should rename the key 'feeling' to 'mood'.");
assert(parsedClaraBrain.feeling === undefined, "Old key 'feeling' should be deleted from brain.");
assert(globalThis.text === "Clara smiles at Alex.", "Output should be cleaned of the rename command block.");

// --- Test 8: Active NPC Visual Indicator (Emoji Toggling) ---
globalThis.history = [
    { text: "The princess sighs and looks at the sky.", type: "story" } // matches Clara
];
globalThis.text = "You talk to her.";
claraBrainCard.title = "Clara Brain"; // Reset
marcusBrainCard.title = "Marcus Brain";

// Turn on visual indicator in config card
configCard.entry = "MindForge Configuration\n\nEnabled: true\nVisual Indicator: true";
MindForge("context");

assert(claraBrainCard.title === "🧩\u200B Clara Brain", "Active NPC card should be prepended with emoji and ZWSP.");
assert(marcusBrainCard.title === "Marcus Brain", "Inactive NPC card should not be prepended.");

// De-trigger active NPC
globalThis.history = [{ text: "You wander in the empty desert.", type: "story" }];
globalThis.text = "Hello?";
MindForge("context");

assert(claraBrainCard.title === "Clara Brain", "Card title should be restored when NPC is no longer active.");

// --- Test 9: Config Card Auto-Pinning ---
configCard.entry = "MindForge Configuration\n\nEnabled: true\nPin Config Card: true";
// Move configCard to the end of storyCards
globalThis.storyCards.splice(globalThis.storyCards.indexOf(configCard), 1);
globalThis.storyCards.push(configCard);

// Trigger context hook
MindForge("context");
assert(globalThis.storyCards[0] === configCard, "Config card should be pinned to the top (index 0) of storyCards when enabled.");

// --- Test 10: Shorthand @NPC Detection and Brain Card Scan Persistence ---
const shorthandCard = globalThis.addStoryCard("", "", "class", "@Lydia", "", { returnCard: true });
// Run parsing to detect the shorthand card
MindForge("input");

assert(shorthandCard.title === "Lydia", "@Lydia title should be cleaned to Lydia.");
const lydiaBrainCard = globalThis.storyCards.find(c => {
    try {
        const meta = JSON.parse(c.keys);
        return meta && meta.agent === "Lydia";
    } catch { return false; }
});
assert(lydiaBrainCard !== undefined, "Lydia brain card should be pre-created immediately to persist registration.");

// Simulating subsequent turn: Lydia's card title is already "Lydia" (no @ prefix)
// Reset configuration agents parsed from config card description, then run input hook again
globalThis.text = "Hi";
MindForge("input");
// Lydia should be detected from scanning lydiaBrainCard keys containing `"agent"`
assert(globalThis.storyCards.some(c => c.keys && c.keys.includes('"agent"') && c.keys.includes('Lydia')), "Lydia brain card should exist.");

// --- Test 11: Turn-based Chance Half-Reduction ---
// Enable 100% chance in config card
configCard.entry = "MindForge Configuration\n\nEnabled: true\nThought Chance (0-100): 100";
globalThis.history = [
    { text: "Clara says hello.", type: "story" } // matches Clara
];
// Last action was story (a player turn category)
globalThis.history[globalThis.history.length - 1].type = "say";

// Mock Math.random to return 0.6.
// Since chance is 100%, if there is no reduction, triggerChance is (100 / 100) > 0.6 (true).
// But since the last action is "say", chance is halved to 50%.
// So finalChance is 50%, and (50 / 100) > 0.6 is false (rules block will not be appended!).
const originalRandom = Math.random;
Math.random = () => 0.6;

globalThis.text = "You respond.";
MindForge("context");

// Check if active rules are NOT appended (since chance was halved to 50%, and 0.5 < 0.6)
assert(!globalThis.text.includes("Memory Operation"), "Thought chance should be halved on player turn (active rules not appended).");

// Restore Math.random
Math.random = originalRandom;

// --- Test 12: Output Sanitization and System Tag Stripping ---
globalThis.state.MindForge.agent = "Clara";
globalThis.text = "<SYSTEM>\n# MindForge NPC Clara Memory Operation\nStart response with EXACTLY one bracket operation...\n</SYSTEM>\n\n[+feeling: Clara is excited] Clara smiles.\nSTRICT OUTPUT FORMAT\nYou are Clara.\nStory continues...";

MindForge("output");
assert(!globalThis.text.includes("<SYSTEM>"), "System instructions should be completely stripped.");
assert(!globalThis.text.includes("STRICT OUTPUT FORMAT"), "Sanitized output should strip leaked instructions.");
assert(!globalThis.text.includes("You are Clara."), "Sanitized output should strip 'You are Clara' leaks.");
assert(!globalThis.text.includes("Story continues"), "Sanitized output should strip prompt tail leaks.");
assert(globalThis.text.includes("Clara smiles."), "Final story text should preserve the valid narrative.");

// --- Test 13: Configurable Volatile Decay ---
configCard.entry = "MindForge Configuration\n\nEnabled: true\nVolatile Decay: 5";
claraBrainCard.description = "";
globalThis.history.push({ text: "Clara walks in.", type: "continue" });
globalThis.state.MindForge.agent = "Clara";
globalThis.text = "[+_mood: happy] Clara smiles.";
MindForge("output");

let parsedClara = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});
assert(parsedClara["_mood(5)"] === "happy", "Volatile decay turns should be configured to 5.");

// Run context to verify decay from 5 to 4
globalThis.history.push({ text: "Clara greets you.", type: "continue" });
globalThis.text = "You greet her back.";
MindForge("context");
parsedClara = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});
assert(parsedClara["_mood(4)"] === "happy", "Volatile decay should decrement to 4.");

// --- Test 14: Custom Visual Indicator Emoji ---
configCard.entry = "MindForge Configuration\n\nEnabled: true\nVisual Indicator: 🎭";
claraBrainCard.title = "Clara Brain";
globalThis.history = [
    { text: "The princess sighs.", type: "story" }
];
globalThis.text = "Hello Clara.";
MindForge("context");
assert(claraBrainCard.title === "🎭\u200B Clara Brain", "Custom indicator emoji 🎭 should be prepended to the title.");

// --- Test 15: OOC Rename and Clear Commands ---
claraBrainCard.description = "mood: happy\nfeeling: tired";
globalThis.text = "/mf rename Clara status mood";
MindForge("input");
assert(globalThis.text.includes("✅ Renamed key [mood] to [status]"), "Rename command output should be successful.");
parsedClara = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});
assert(parsedClara.status === "happy" && parsedClara.mood === undefined, "Brain should rename mood to status.");

globalThis.text = "/mf clear Clara";
MindForge("input");
assert(globalThis.text.includes("✅ Cleared all thoughts"), "Clear command output should be successful.");
assert(claraBrainCard.description.trim() === "", "Brain card description should be empty after clear.");

// --- Test 16: Regex JSON parser recovery ---
claraBrainCard.description = `{\n  "key1": "val1",\n  "key2": "val2",\n}`; // Trailing comma makes JSON.parse fail
globalThis.history = [
    { text: "The princess is here.", type: "story" } // matches Clara
];
globalThis.text = "You nod.";
MindForge("context");
assert(globalThis.text.includes("key1: val1") && globalThis.text.includes("key2: val2"), "Should recover keys from malformed JSON (trailing comma) via integration context hook.");

claraBrainCard.description = `{\n  "key1": "val1",\n  "key2": "val2"\n`; // Missing closing brace
globalThis.history = [
    { text: "The princess is here.", type: "story" } // matches Clara
];
globalThis.text = "You nod.";
MindForge("context");
assert(globalThis.text.includes("key1: val1") && globalThis.text.includes("key2: val2"), "Should recover keys from unclosed JSON via integration context hook.");

// --- Test 17: Exclusion of volatile memories from consolidation ---
// Reset Clara's brain card description to flat format with multiple keys to trigger consolidation
claraBrainCard.description = "background: old context\nkey1: val1\nkey2: val2\nkey3: val3\nkey4: val4\nkey5: val5\nkey6: val6\n_volatile1: temp1\n_volatile2: temp2";
globalThis.state.MindForge.agent = "Clara";
globalThis.text = "[+key7: val7] Clara nods.";
MindForge("output");

let parsedClaraConsolidated = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});

assert(parsedClaraConsolidated._volatile1 === "temp1" && parsedClaraConsolidated._volatile2 === "temp2", "Volatile memories must be excluded from consolidation.");
assert(parsedClaraConsolidated.background.includes("key5 is val5") || parsedClaraConsolidated.background.includes("key6 is val6"), "Normal keys should be consolidated into background.");


// --- Test 18: Skipping Auto-Cards lines in triggers ---
globalThis.history = [
    { text: ">>> Princess Clara\nShe is here.", type: "story" }
];
// "princess" is in the metadata line (which has >>>). So Clara should NOT be triggered if the metadata line is properly skipped.
// Let's reset the active agent
globalThis.state.MindForge.agent = "";
configCard.entry = "MindForge Configuration\n\nEnabled: true\nLookback Turns: 2";
MindForge("context");
assert(globalThis.state.MindForge.agent !== "Clara", "Skipping Auto-Cards lines should prevent Clara from triggering.");

// --- Test 19: Mismatched enclosure healing and bracket command translation ---
claraBrainCard.description = "feeling: happy";
globalThis.state.MindForge.agent = "Clara";
globalThis.state.MindForge.hash = "";
globalThis.text = "[+mood: cheerful) Clara laughs.";
MindForge("output");
parsedClara = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});
assert(parsedClara.mood === "cheerful", "Mismatched enclosure [+mood: cheerful) should be healed and parsed successfully.");

// Bracket set translation: [mood = excited]
globalThis.state.MindForge.agent = "Clara";
globalThis.state.MindForge.hash = "";
globalThis.text = "[mood = excited] Clara jumps.";
MindForge("output");
parsedClara = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});
assert(parsedClara.mood === "excited", "[mood = excited] should translate to [+mood: excited] and parse successfully.");

// Bracket rename translation: [status = mood]
globalThis.state.MindForge.agent = "Clara";
globalThis.state.MindForge.hash = "";
globalThis.text = "[status = mood] Clara smiles.";
MindForge("output");
parsedClara = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});
assert(parsedClara.status === "excited" && parsedClara.mood === undefined, "[status = mood] should translate to [=status: mood] and rename successfully.");

// --- Test 20: Fuzzy key deletion ---
claraBrainCard.description = "_mood(3): excited";
globalThis.state.MindForge.agent = "Clara";
globalThis.state.MindForge.hash = "";
globalThis.text = "[-mood] Clara calms down.";
MindForge("output");
parsedClara = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});
assert(parsedClara["_mood(3)"] === undefined, "[-mood] should fuzzy delete _mood(3) successfully.");

// --- Test 21: Smart capitalization triggering ---
configCard.entry = "MindForge Configuration\n\nEnabled: true\nThought Chance (0-100): 0\nLookback Turns: 2";
configCard.description = "NPC Names (First name followed by comma-separated aliases):\nWill";
globalThis.text = "You wait.";
globalThis.history = [{ text: "I will go to the old gate.", type: "story" }];
globalThis.state.MindForge.agent = "";
MindForge("context");
assert(globalThis.state.MindForge.agent !== "Will", "Lowercase common word 'will' should not trigger the NPC Will.");

globalThis.text = "Recent Story:\nWill steps into the old gatehouse.";
globalThis.history = [{ text: "Will steps into the old gatehouse.", type: "story" }];
MindForge("context");
assert(globalThis.state.MindForge.agent === "Will", "Capitalized NPC name Will should trigger normally.");

// Restore Clara/Marcus fixture for the remaining tests.
configCard.description = "NPC Names (First name followed by comma-separated aliases):\nClara, princess, her highness\nMarcus, captain, Sir Marcus, warrior";

// --- Test 22: ZWSP thought label association ---
configCard.entry = "MindForge Configuration\n\nEnabled: true\nThought Chance (0-100): 100\nZWSP Thought Labels: true";
claraBrainCard.description = "";
globalThis.state.MindForge.agent = "Clara";
globalThis.state.MindForge.hash = "";
globalThis.history = [{ text: "Clara finds a hidden door.", type: "story" }];
globalThis.text = "[+secret: Clara remembers the hidden door.] Clara lowers her voice.";
MindForge("output");

const secretLabel = globalThis.state.MindForge.labels.Clara.secret;
assert(Number.isInteger(secretLabel), "Newly written thoughts should get an invisible label id.");
assert(globalThis.text.startsWith("\u200B") && !globalThis.text.includes("<!--mf:"), "ZWSP label should be prefixed instead of an HTML comment tag.");

globalThis.history = [{ text: globalThis.text, type: "story" }, { text: "Clara studies the corridor.", type: "story" }];
globalThis.text = `Recent Story:\n${globalThis.history[0].text}\nClara studies the corridor.`;
MindForge("context");
assert(globalThis.text.includes(`[${secretLabel}]`), "Context should decode invisible thought labels into visible [label] markers.");
assert(globalThis.text.includes(`secret: Clara remembers the hidden door. [${secretLabel}]`), "Brain injection should show the matching thought label.");

// --- Test 23: Context guard keeps critical instructions while trimming oversized context ---
globalThis.info.maxChars = 1200;
configCard.entry = "MindForge Configuration\n\nEnabled: true\nThought Chance (0-100): 100\nMax Brain Context (1-95): 40\nContext Guard Buffer (200-3000): 200";
globalThis.history = [{ text: "Clara enters the archive.", type: "story" }];
globalThis.text = `AI Instructions:\nKeep core rules.\n\nRecent Story:\n${"old scene ".repeat(500)}\nClara enters the archive.`;
MindForge("context");
assert(globalThis.text.length <= globalThis.info.maxChars, "Context guard should keep final context under the AI Dungeon maxChars limit.");
assert(globalThis.text.includes("<SYSTEM>") && globalThis.text.includes("Always continue the story"), "Context guard should preserve MindForge's critical system directive.");
assert((globalThis.state.MindForge.health.contextGuards || 0) > 0, "Context guard activity should be counted silently.");
globalThis.info.maxChars = 4000;

// --- Test 24: Primary recency ordering and multi-NPC budget allocation ---
configCard.entry = "MindForge Configuration\n\nEnabled: true\nThought Chance (0-100): 0\nMax Brain Context (1-95): 20\nMax Active NPCs (1-5): 3";
claraBrainCard.description = "goal: Clara must protect the corridor.\nplan: Clara watches Marcus carefully.";
marcusBrainCard.description = "duty: Marcus must defend Clara.";
globalThis.history = [
    { text: "Marcus checks the door.", type: "story" },
    { text: "Marcus asks whether Clara is ready.", type: "story" }
];
globalThis.text = "Recent Story:\nMarcus checks the door.\nMarcus asks whether Clara is ready.";
MindForge("context");
const marcusIdx = globalThis.text.indexOf("Marcus' Brain Thoughts (Present):");
const claraIdx = globalThis.text.indexOf("Clara's Brain Thoughts (Active):");
assert(marcusIdx !== -1 && claraIdx !== -1 && marcusIdx < claraIdx, "Present NPC memories should appear before the primary NPC block.");
assert(globalThis.text.includes("- duty: Marcus must defend Clara."), "Secondary NPC should receive its own budget and avoid starvation.");

// --- Test 25: Staged commits skip command-only or leaked outputs ---
claraBrainCard.description = "";
globalThis.state.MindForge.agent = "Clara";
globalThis.state.MindForge.hash = "";
globalThis.history = [{ text: "Clara hesitates.", type: "story" }];
globalThis.text = "[+bad_memory: Clara stores a bad memory.]\nSTRICT OUTPUT FORMAT\nStory continues...";
MindForge("output");
parsedClara = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});
assert(parsedClara.bad_memory === undefined, "Brain mutation should be skipped when sanitized output has no real narrative.");
assert(globalThis.text === "\u200B", "Command-only bad output should degrade to a zero-width placeholder.");
assert((globalThis.state.MindForge.health.skippedCommits || 0) > 0, "Skipped commits should be counted silently.");

// --- Test 25b: Clean memory-only outputs commit once and avoid empty loops ---
claraBrainCard.description = "";
globalThis.state.MindForge.agent = "Clara";
globalThis.state.MindForge.hash = "";
globalThis.state.MindForge.memoryOnly = { agent: "", turn: -999 };
globalThis.history = [{ text: "Clara hesitates.", type: "story" }];
globalThis.text = "[+memory_recent: Clara notices Alex is afraid.]";
MindForge("output");
parsedClara = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts.slice(1).join(":").trim();
    return acc;
}, {});
assert(parsedClara.memory_recent === "Clara notices Alex is afraid.", "Clean memory-only outputs should still commit the useful thought once.");
assert(globalThis.text === "...", "Clean memory-only outputs should not display an empty response.");
assert((globalThis.state.MindForge.health.memoryOnlyOutputs || 0) > 0, "Memory-only outputs should be counted separately.");
configCard.entry = "MindForge Configuration\n\nEnabled: true\nThought Chance (0-100): 100\nBootstrap Empty Brains: true";
globalThis.history = [
    { text: "Clara hesitates.", type: "story" },
    { text: globalThis.text, type: "continue" }
];
globalThis.text = "Recent Story:\nClara hesitates.\n...";
Math.random = () => 0.1;
MindForge("context");
Math.random = originalRandom;
assert(!globalThis.text.includes("Memory Operation"), "A recent memory-only output should suppress the next active memory prompt.");
assert((globalThis.state.MindForge.health.memoryOnlyCooldowns || 0) > 0, "Memory-only cooldowns should be counted silently.");

// --- Test 25c: UI chrome leaks are stripped from visible output ---
const uiLeakSkipsBefore = globalThis.state.MindForge.health.uiLeakSkips || 0;
globalThis.state.MindForge.agent = "";
globalThis.history = [{ text: "Clara waits.", type: "story" }];
globalThis.text = "\u200BW a i t i n g f o r i n p u t...w_penciltake a turnw_wandcontinuew_retryRetryw_backspaceerase";
MindForge("output");
assert(globalThis.text === "\u200B", "UI chrome-only output should be stripped even without an active agent.");
assert((globalThis.state.MindForge.health.uiLeakSkips || 0) > uiLeakSkipsBefore, "UI chrome skips should be counted silently.");
globalThis.state.MindForge.agent = "Clara";
globalThis.history = [{ text: "Clara looks at Leo.", type: "story" }];
globalThis.text = "\u200BS I L E N C E\nClara's lips press together.\n\u200BW a i t i n g f o r i n p u t...w_penciltake a turnw_wandcontinuew_retryRetryw_backspaceerase";
MindForge("output");
assert(globalThis.text === "Clara's lips press together.", "UI chrome and spaced meta beats should be stripped while preserving real story text.");
globalThis.state.MindForge.memoryOnly = { agent: "", turn: -999 };
globalThis.state.MindForge.scene = { agent: "", ttl: 0 };
globalThis.state.MindForge.agent = "";

// --- Test 25d: Ignored memory prompts fall back to deterministic brain writes ---
claraBrainCard.description = "";
configCard.entry = "MindForge Configuration\n\nEnabled: true\nPlayer Name: Leo\nThought Chance (0-100): 100\nHalf Thought Chance: false\nBootstrap Empty Brains: true";
configCard.description = "NPC Names (First name followed by comma-separated aliases):\nClara, princess, her highness\nMarcus, captain, Sir Marcus, warrior";
globalThis.state.MindForge.hash = "";
globalThis.state.MindForge.scene = { agent: "", ttl: 0 };
globalThis.state.MindForge.pendingMemory = { agent: "", hash: "", turn: -999 };
globalThis.history = [{ text: "Clara asks Leo what he put in the capsule.", type: "story" }];
globalThis.text = "Recent Story:\nClara asks Leo what he put in the capsule.";
Math.random = () => 0.1;
MindForge("context");
Math.random = originalRandom;
globalThis.text = "Clara's jaw tightens. \"The divorce, Leo. The one you never signed.\"";
MindForge("output");
parsedClara = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts.slice(1).join(":").trim();
    return acc;
}, {});
assert(parsedClara.relationship_leo && parsedClara.relationship_leo.includes("Clara"), "Ignored memory prompts should still create a fallback NPC brain note.");
assert(globalThis.text.includes("Clara's jaw tightens"), "Fallback memory writes should preserve normal visible story output.");
assert((globalThis.state.MindForge.health.fallbackMemoryWrites || 0) > 0, "Fallback memory writes should be counted silently.");

// --- Test 25e: Sparse brains keep requesting follow-up writes even when chance is low ---
claraBrainCard.description = "memory_recent: Clara's gaze lingers on the capsule, then slides to Leo's face.";
configCard.entry = "MindForge Configuration\n\nEnabled: true\nPlayer Name: Leo\nThought Chance (0-100): 0\nHalf Thought Chance: false\nBootstrap Empty Brains: true";
globalThis.state.MindForge.hash = "";
globalThis.state.MindForge.lastWrite = {};
globalThis.state.MindForge.pendingMemory = { agent: "", hash: "", turn: -999 };
globalThis.state.MindForge.scene = { agent: "", ttl: 0 };
globalThis.history = [
    { text: "Clara watches Leo beside the capsule.", type: "story" },
    { text: "Leo kisses Clara beside the capsule.", type: "say" }
];
globalThis.text = "Recent Story:\nClara watches Leo beside the capsule.\nLeo kisses Clara beside the capsule.";
Math.random = () => 0.99;
MindForge("context");
Math.random = originalRandom;
assert(globalThis.state.MindForge.pendingMemory.agent === "Clara", "Sparse brains should force another memory prompt before settling into normal chance.");
globalThis.text = "Clara pulls back slowly. \"Why now, Leo? After all this time.\"";
MindForge("output");
parsedClara = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts.slice(1).join(":").trim();
    return acc;
}, {});
assert(parsedClara.relationship_leo && parsedClara.relationship_leo.includes("Why now"), "Sparse-brain fallback should add relationship memory from later normal prose.");

// --- Test 25f: Fallback memories remove repeated direct-address player names ---
claraBrainCard.description = "memory_recent: Clara watches Leo near the capsule.";
globalThis.state.MindForge.hash = "";
globalThis.state.MindForge.lastWrite = {};
globalThis.state.MindForge.pendingMemory = { agent: "Clara", hash: "", turn: history.length };
globalThis.state.MindForge.agent = "Clara";
globalThis.history = [{ text: "Clara asks Leo about the capsule.", type: "story" }];
globalThis.state.MindForge.pendingMemory.hash = (function() {
    let n = 0;
    const serialized = JSON.stringify(globalThis.history.slice(-30));
    for (let i = 0; i < serialized.length; i++) {
        n = ((31 * n) + serialized.charCodeAt(i)) | 0;
    }
    return n.toString(16);
})();
globalThis.text = "\"What did you bury, Leo?\"";
MindForge("output");
parsedClara = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts.slice(1).join(":").trim();
    return acc;
}, {});
assert(parsedClara.memory_recent === "Clara observes: What did Leo bury?", "Fallback memories should not repeat the player name as both subject and direct address.");
configCard.description = "NPC Names (First name followed by comma-separated aliases):\nClara, princess, her highness\nMarcus, captain, Sir Marcus, warrior";
globalThis.state.MindForge.pendingMemory = { agent: "", hash: "", turn: -999 };
globalThis.state.MindForge.lastWrite = {};
globalThis.state.MindForge.scene = { agent: "", ttl: 0 };
globalThis.state.MindForge.agent = "";

// --- Test 26: Memory tiers protect core memories automatically ---
configCard.entry = "MindForge Configuration\n\nEnabled: true\nThought Chance (0-100): 100";
claraBrainCard.description = "core_identity: Clara is sworn to protect the archive.\nkey1: v1\nkey2: v2\nkey3: v3\nkey4: v4\nkey5: v5\nkey6: v6";
globalThis.state.MindForge.agent = "Clara";
globalThis.state.MindForge.hash = "";
globalThis.history = [{ text: "Clara enters the archive.", type: "story" }];
globalThis.text = "[-core_identity] Clara keeps walking.";
MindForge("output");
globalThis.state.MindForge.agent = "Clara";
globalThis.state.MindForge.hash = "";
globalThis.text = "[+fresh: Clara checks the south wall.] Clara checks the south wall.";
MindForge("output");
parsedClara = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});
assert(parsedClara.core_identity === "Clara is sworn to protect the archive.", "Automatic delete operations must not remove core memories.");
assert(parsedClara.background && !parsedClara.background.includes("Clara is sworn"), "Core memories should not be folded into background consolidation.");
assert((globalThis.state.MindForge.health.coreSkips || 0) > 0, "Core memory protection should be counted silently.");

// --- Test 27: Duplicate thought guard prevents memory bloat ---
claraBrainCard.description = "goal: Clara must protect the archive from intruders.";
globalThis.state.MindForge.agent = "Clara";
globalThis.state.MindForge.hash = "";
globalThis.history = [{ text: "Clara watches the door.", type: "story" }];
globalThis.text = "[+new_goal: Clara must protect the archive from intruders.] Clara watches the door.";
MindForge("output");
parsedClara = claraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});
assert(parsedClara.new_goal === undefined, "Duplicate thoughts should be skipped instead of stored under a new key.");
assert((globalThis.state.MindForge.health.duplicateSkips || 0) > 0, "Duplicate skips should be counted silently.");

// --- Test 28: Scene lock stabilizes the primary NPC without user commands ---
configCard.entry = "MindForge Configuration\n\nEnabled: true\nThought Chance (0-100): 0\nLookback Turns: 3";
claraBrainCard.description = "goal: Clara leads the search.";
marcusBrainCard.description = "duty: Marcus follows Clara's orders.";
globalThis.state.MindForge.scene = { agent: "Clara", ttl: 2 };
globalThis.history = [
    { text: "Clara studies the chamber.", type: "story" },
    { text: "Clara watches Marcus shift closer.", type: "story" }
];
globalThis.text = "Recent Story:\nClara studies the chamber.\nClara watches Marcus shift closer.";
MindForge("context");
assert(globalThis.state.MindForge.agent === "Clara", "Scene lock should keep the current primary NPC when they are still present.");
assert((globalThis.state.MindForge.health.sceneLocks || 0) > 0, "Scene lock activity should be counted silently.");

// --- Test 29: Stable profile uses a shorter low-risk prompt ---
configCard.entry = "MindForge Configuration\n\nEnabled: true\nModel Profile (Stable/Balanced/Full): Stable\nThought Chance (0-100): 100";
globalThis.state.MindForge.scene = { agent: "", ttl: 0 };
globalThis.state.MindForge.memoryOnly = { agent: "", turn: -999 };
globalThis.state.MindForge.health = {};
globalThis.state.MindForge.adaptiveMode = "";
globalThis.history = [{ text: "Clara enters quietly.", type: "story" }];
globalThis.text = "Recent Story:\nClara enters quietly.";
Math.random = () => 0.1;
MindForge("context");
Math.random = originalRandom;
assert(globalThis.text.includes("If it fits naturally"), "Stable profile should use a softer prompt that does not force a memory operation.");
assert(!globalThis.text.includes("Start response with EXACTLY one bracket operation"), "Stable profile should avoid the strict long-form operation prompt.");

// --- Test 30: Per-agent metadata can silently disable an NPC ---
marcusBrainCard.keys = JSON.stringify({ agent: "Marcus", enabled: false });
configCard.entry = "MindForge Configuration\n\nEnabled: true\nThought Chance (0-100): 0\nMax Active NPCs (1-5): 3";
globalThis.state.MindForge.scene = { agent: "", ttl: 0 };
globalThis.history = [{ text: "Marcus stands beside Clara.", type: "story" }];
globalThis.text = "Recent Story:\nMarcus stands beside Clara.";
MindForge("context");
assert(!globalThis.text.includes("Marcus' Brain Thoughts"), "Disabled per-agent metadata should prevent that NPC from injecting context.");
marcusBrainCard.keys = JSON.stringify({ agent: "Marcus" });

// --- Test 31: Fail-open runtime guard ---
const originalAddStoryCard = globalThis.addStoryCard;
globalThis.storyCards = [];
globalThis.text = "Keep this player text.";
globalThis.addStoryCard = () => { throw new Error("simulated addStoryCard failure"); };
MindForge("input");
assert(globalThis.text === "Keep this player text.", "Runtime failure should preserve existing text instead of breaking the turn.");
assert((globalThis.state.MindForge.health.errors || 0) > 0, "Runtime failures should be counted silently.");
globalThis.addStoryCard = originalAddStoryCard;

// --- Test 32: Config migration preserves old cards while adding new settings ---
globalThis.state = {};
globalThis.storyCards = [];
globalThis.history = [];
const oldConfigCard = globalThis.addStoryCard(
    "mindforge_config",
    "MindForge Configuration\n\nEnabled: true\nThought Chance (0-100): 75",
    "class",
    "Configure MindForge",
    "Nora",
    { returnCard: true }
);
globalThis.text = "Boot.";
MindForge("input");
assert(oldConfigCard.entry.includes("Model Profile (Stable/Balanced/Full): Balanced"), "Config migration should add missing model profile setting.");
assert(oldConfigCard.entry.includes("ZWSP Thought Labels: true"), "Config migration should add missing ZWSP setting.");
assert(oldConfigCard.description.startsWith("NPC Names"), "Config migration should add the NPC names header without removing existing notes.");
assert((globalThis.state.MindForge.health.configMigrations || 0) > 0, "Config migrations should be counted silently.");

// --- Test 33: Brain card repair fixes damaged card fields ---
const damagedBrainCard = globalThis.addStoryCard(
    JSON.stringify({ agent: "Nora" }),
    42,
    "Brain",
    "",
    null,
    { returnCard: true }
);
globalThis.history = [{ text: "Nora studies the sealed door.", type: "story" }];
globalThis.text = "Recent Story:\nNora studies the sealed door.";
MindForge("context");
assert(JSON.parse(damagedBrainCard.keys).agent === "Nora", "Brain repair should preserve valid agent metadata.");
assert(typeof damagedBrainCard.entry === "string" && damagedBrainCard.entry.includes("Operation Log"), "Brain repair should restore the operation log.");
assert(damagedBrainCard.title.includes("Nora"), "Brain repair should restore a usable title.");
assert(damagedBrainCard.description === "", "Brain repair should normalize missing notes to an empty string.");
assert((globalThis.state.MindForge.health.brainRepairs || 0) > 0, "Brain repairs should be counted silently.");

// --- Test 34: No-command auto setup from marker story cards ---
globalThis.state = {};
globalThis.storyCards = [];
globalThis.history = [];
const markerCard = globalThis.addStoryCard(
    "mindforge:npc",
    "Nora is a quiet archivist.",
    "class",
    "Nora",
    "",
    { returnCard: true }
);
globalThis.text = "Boot.";
MindForge("input");
const noraBrainCard = globalThis.storyCards.find(c => {
    try {
        const meta = JSON.parse(c.keys);
        return meta && meta.agent === "Nora";
    } catch { return false; }
});
assert(markerCard.title === "Nora", "Marker story card should stay readable.");
assert(noraBrainCard !== undefined, "Marker story card should create an NPC brain without commands.");
globalThis.history = [{ text: "Nora opens the archive cabinet.", type: "story" }];
globalThis.text = "Recent Story:\nNora opens the archive cabinet.";
MindForge("context");
assert(globalThis.state.MindForge.agent === "Nora", "Auto-registered NPC should trigger normally.");

// --- Test 35: Output quality gate skips refusal-style commits ---
noraBrainCard.description = "";
globalThis.state.MindForge.agent = "Nora";
globalThis.state.MindForge.hash = "";
globalThis.history = [{ text: "Nora waits beside the cabinet.", type: "story" }];
globalThis.text = "[+bad: Nora stores a refusal.] As an AI language model, I cannot continue.";
MindForge("output");
const parsedNora = noraBrainCard.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts[1].trim();
    return acc;
}, {});
assert(parsedNora.bad === undefined, "Refusal-style output should not be committed to brain memory.");
assert(globalThis.text === "\u200B", "Refusal-style output should degrade to a zero-width placeholder.");
assert((globalThis.state.MindForge.health.qualitySkips || 0) > 0, "Quality gate skips should be counted silently.");

// --- Test 36: Adaptive profile lowers pressure after repeated failures ---
const adaptiveConfigCard = globalThis.storyCards.find(c => c.keys === "mindforge_config");
adaptiveConfigCard.entry = "MindForge Configuration\n\nEnabled: true\nModel Profile (Stable/Balanced/Full): Balanced\nThought Chance (0-100): 100\nMax Brain Context (1-95): 50\nMax Active NPCs (1-5): 5\nSelf Reflection Chance (0-100): 50";
globalThis.state.MindForge.health.emptyOutputs = 3;
globalThis.state.MindForge.health.skippedCommits = 2;
globalThis.state.MindForge.scene = { agent: "", ttl: 0 };
globalThis.history = [{ text: "Nora checks the archive lock.", type: "story" }];
globalThis.text = "Recent Story:\nNora checks the archive lock.";
Math.random = () => 0.9;
MindForge("context");
Math.random = originalRandom;
assert(globalThis.state.MindForge.adaptiveMode === "guarded", "Adaptive profile should enter guarded mode after repeated failures.");
assert(!globalThis.text.includes("Start response with EXACTLY one bracket operation"), "Guarded mode should avoid the strict operation prompt.");
assert((globalThis.state.MindForge.health.adaptiveShifts || 0) > 0, "Adaptive profile shifts should be counted silently.");

const parseBrain = (card) => card.description.split("\n").reduce((acc, line) => {
    const parts = line.split(":");
    if (parts.length >= 2) acc[parts[0].trim()] = parts.slice(1).join(":").trim();
    return acc;
}, {});

// --- Test 37: Full profile uses the Brain Steward prompt and slot guidance ---
globalThis.state = {};
globalThis.storyCards = [];
globalThis.history = [];
globalThis.text = "";
MindForge("input");
const stewardConfigCard = globalThis.storyCards.find(c => c.keys === "mindforge_config");
stewardConfigCard.entry = "MindForge Configuration\n\nEnabled: true\nPlayer Name: Alex\nModel Profile (Stable/Balanced/Full): Full\nThought Chance (0-100): 100\nHalf Thought Chance: false\nBrain Steward: true\nMemory Slots: true";
stewardConfigCard.description = "NPC Names (first name followed by optional comma-separated aliases):\nNora";
const stewardBrainCard = globalThis.addStoryCard(
    JSON.stringify({ agent: "Nora" }),
    `// MindForge Brain Card initialized @ UTC\n// Operation Log:\n`,
    "Brain",
    "Nora Brain",
    "memory_recent: Nora cataloged the sealed shelf.",
    { returnCard: true }
);
globalThis.history = [{ text: "Nora studies the sealed shelf.", type: "story" }];
globalThis.text = "Recent Story:\nNora studies the sealed shelf.";
Math.random = () => 0.1;
MindForge("context");
Math.random = originalRandom;
assert(globalThis.text.includes("# MindForge Brain Steward: Nora"), "Full profile should use the Brain Steward prompt.");
assert(globalThis.text.includes("relationship_alex"), "Memory slot guidance should prefer relationship slots for the configured player.");
assert(globalThis.text.includes("Allowed forms:"), "Brain Steward prompt should expose the operation forms clearly.");
assert(globalThis.text.includes("Private mind for Nora"), "Agentic charter should be injected automatically without user commands.");
assert(globalThis.text.includes("private motives"), "Agentic charter should give the model a stronger inner-life frame.");

// --- Test 37b: Empty brains bootstrap their first memory prompt ---
stewardConfigCard.entry = "MindForge Configuration\n\nEnabled: true\nPlayer Name: Alex\nModel Profile (Stable/Balanced/Full): Balanced\nThought Chance (0-100): 0\nHalf Thought Chance: false\nBrain Steward: true\nBootstrap Empty Brains: true";
stewardBrainCard.description = "";
globalThis.state.MindForge.scene = { agent: "", ttl: 0 };
globalThis.history = [{ text: "Nora pauses beside Alex in the sealed archive.", type: "story" }];
globalThis.text = "Recent Story:\nNora pauses beside Alex in the sealed archive.";
Math.random = () => 0.99;
MindForge("context");
Math.random = originalRandom;
assert(globalThis.text.includes("create Nora's first durable thought"), "Empty NPC brains should force a first-memory prompt even when normal thought chance is 0.");
assert((globalThis.state.MindForge.health.bootstrapPrompts || 0) > 0, "Bootstrap prompts should be counted silently.");

// --- Test 38: Context ranking preserves high-value memory tiers under tight budgets ---
stewardConfigCard.entry = "MindForge Configuration\n\nEnabled: true\nPlayer Name: Alex\nModel Profile (Stable/Balanced/Full): Balanced\nThought Chance (0-100): 0\nMax Brain Context (1-95): 1\nBrain Rotation: false";
stewardBrainCard.description = [
    "weak1: Nora notices an ordinary scratch across the old cabinet and files it away without urgency.",
    "weak2: Nora counts the brass hinges on the door and decides the number is not useful.",
    "weak3: Nora remembers the dust on the floor near the western shelf.",
    "weak4: Nora hears a distant drip somewhere behind the wall.",
    "core_identity: Nora is the archive keeper.",
    "relationship_alex: Nora trusts Alex with the sealed map.",
    "goal_current: Nora must open the sealed shelf."
].join("\n");
globalThis.state.MindForge.scene = { agent: "", ttl: 0 };
globalThis.history = [{ text: "Nora asks Alex to inspect the sealed shelf.", type: "story" }];
globalThis.text = "Recent Story:\nNora asks Alex to inspect the sealed shelf.";
MindForge("context");
assert(globalThis.text.includes("- core_identity: Nora is the archive keeper."), "Context ranking should preserve core memories under budget pressure.");
assert(globalThis.text.includes("- relationship_alex: Nora trusts Alex with the sealed map."), "Context ranking should preserve relationship memories under budget pressure.");
assert(globalThis.text.includes("- goal_current: Nora must open the sealed shelf."), "Context ranking should preserve goal memories under budget pressure.");

// --- Test 39: Smart prune folds weak memories while preserving tiered memories ---
stewardConfigCard.entry = "MindForge Configuration\n\nEnabled: true\nPlayer Name: Alex\nModel Profile (Stable/Balanced/Full): Balanced\nThought Chance (0-100): 100\nMax Brain Keys (3-20): 5";
stewardBrainCard.description = [
    "core_identity: Nora is the archive keeper.",
    "relationship_alex: Nora trusts Alex with the sealed map.",
    "goal_current: Nora must open the sealed shelf.",
    "weak1: old weak memory one.",
    "weak2: old weak memory two.",
    "weak3: old weak memory three.",
    "weak4: old weak memory four.",
    "weak5: old weak memory five.",
    "weak6: old weak memory six."
].join("\n");
globalThis.state.MindForge.agent = "Nora";
globalThis.state.MindForge.hash = "";
globalThis.history = [{ text: "Nora brushes dust from the shelf.", type: "story" }];
globalThis.text = "[+fresh_note: Nora notices dust on the sealed shelf.] Nora brushes dust from the shelf.";
MindForge("output");
const stewardParsedAfterPrune = parseBrain(stewardBrainCard);
assert(stewardParsedAfterPrune.core_identity === "Nora is the archive keeper.", "Smart prune should preserve core memories.");
assert(stewardParsedAfterPrune.relationship_alex === "Nora trusts Alex with the sealed map.", "Smart prune should preserve relationship memories.");
assert(stewardParsedAfterPrune.goal_current === "Nora must open the sealed shelf.", "Smart prune should preserve goal memories.");
assert(stewardParsedAfterPrune.background && stewardParsedAfterPrune.background.includes("weak"), "Smart prune should fold weak memories into background.");
assert((globalThis.state.MindForge.health.smartPrunes || 0) > 0, "Smart prune activity should be counted silently.");

// --- Test 40: Thought quality gate rejects placeholder keys even with narrative text ---
stewardBrainCard.description = "";
globalThis.state.MindForge.agent = "Nora";
globalThis.state.MindForge.hash = "";
globalThis.history = [{ text: "Nora waits beside the shelf.", type: "story" }];
globalThis.text = "[+any_key: This is a placeholder thought.] Nora nods.";
MindForge("output");
const stewardParsedAfterQuality = parseBrain(stewardBrainCard);
assert(stewardParsedAfterQuality.any_key === undefined, "Thought quality gate should reject placeholder memory keys.");
assert((globalThis.state.MindForge.health.thoughtQualitySkips || 0) > 0, "Thought quality gate skips should be counted separately.");

// --- Test 41: Auto Doctor silently compacts bloated brains without player commands ---
stewardConfigCard.entry = "MindForge Configuration\n\nEnabled: true\nPlayer Name: Alex\nModel Profile (Stable/Balanced/Full): Balanced\nThought Chance (0-100): 0\nMax Brain Keys (3-20): 5\nAuto Doctor: true";
stewardBrainCard.description = [
    "core_identity: Nora is the archive keeper.",
    "relationship_alex: Nora trusts Alex with the sealed map.",
    "goal_current: Nora must open the sealed shelf.",
    "weak1: old weak memory one.",
    "weak2: old weak memory two.",
    "weak3: old weak memory three.",
    "weak4: old weak memory four.",
    "weak5: old weak memory five.",
    "weak6: old weak memory six.",
    "weak7: old weak memory seven.",
    "weak8: old weak memory eight.",
    "weak9: old weak memory nine."
].join("\n");
globalThis.state.MindForge.scene = { agent: "", ttl: 0 };
globalThis.history = [{ text: "Nora silently reviews the sealed shelf.", type: "story" }];
globalThis.text = "Recent Story:\nNora silently reviews the sealed shelf.";
MindForge("context");
const stewardParsedAfterDoctor = parseBrain(stewardBrainCard);
assert(stewardParsedAfterDoctor.core_identity === "Nora is the archive keeper.", "Auto Doctor should preserve core memories while compacting.");
assert(stewardParsedAfterDoctor.relationship_alex === "Nora trusts Alex with the sealed map.", "Auto Doctor should preserve relationship memories while compacting.");
assert(stewardParsedAfterDoctor.background && stewardParsedAfterDoctor.background.includes("weak"), "Auto Doctor should silently fold bloated weak memories into background.");
assert((globalThis.state.MindForge.health.autoDoctorCompacts || 0) > 0, "Auto Doctor compactions should be counted silently.");

// --- Test 42: Parser normalizer chooses one operation and strips extra operation blocks ---
stewardConfigCard.entry = "MindForge Configuration\n\nEnabled: true\nPlayer Name: Alex\nModel Profile (Stable/Balanced/Full): Balanced\nThought Chance (0-100): 100\nAuto Doctor: true";
stewardBrainCard.description = "core_identity: Nora is the archive keeper.";
globalThis.state.MindForge.agent = "Nora";
globalThis.state.MindForge.hash = "";
globalThis.history = [{ text: "Nora steps beside Alex.", type: "story" }];
globalThis.text = "(goal current = Nora must protect Alex.) (delete core_identity) Nora advances.";
MindForge("output");
const stewardParsedAfterParser = parseBrain(stewardBrainCard);
assert(stewardParsedAfterParser.core_identity === "Nora is the archive keeper.", "Parser normalizer should not allow a second delete operation to remove core memory.");
assert(stewardParsedAfterParser.goal_current === "Nora must protect Alex.", "Parser normalizer should convert loose assignment syntax into a valid memory write.");
assert(!globalThis.text.toLowerCase().includes("delete core"), "Parser normalizer should strip extra operation blocks from story text.");
assert((globalThis.state.MindForge.health.parserMultiOps || 0) > 0, "Parser multi-operation normalization should be counted silently.");

// --- Test 43: Config card self-documents without creating fake NPCs ---
globalThis.state = {};
globalThis.storyCards = [];
globalThis.history = [];
globalThis.text = "";
MindForge("input");
const selfDocConfigCard = globalThis.storyCards.find(c => c.keys === "mindforge_config");
assert(selfDocConfigCard.description.includes("MindForge Quick Guide"), "Config card should include a built-in quick guide automatically.");
assert(selfDocConfigCard.description.includes("Public scenario setup"), "Config card should include creator-facing public scenario guidance.");
assert(selfDocConfigCard.entry.includes("Player Name: auto"), "Player name should default to automatic detection.");
assert(selfDocConfigCard.entry.includes("World Memory: false"), "World Memory should be available in config and disabled by default.");
assert(!globalThis.storyCards.some(c => {
    try {
        const meta = JSON.parse(c.keys);
        return meta && meta.agent === "Elara";
    } catch { return false; }
}), "Commented guide examples should not be parsed as NPC agents.");
selfDocConfigCard.description = "NPC Names (first name followed by optional comma-separated aliases):\n// MindForge Quick Guide:\nIris";
globalThis.state.MindForge.scene = { agent: "", ttl: 0 };
globalThis.history = [{ text: "Your name is Alex. Iris waits beside the archive.", type: "story" }];
globalThis.text = "Recent Story:\nYour name is Alex. Iris waits beside the archive.";
Math.random = () => 0.1;
MindForge("context");
Math.random = originalRandom;
assert(globalThis.state.MindForge.playerName === "Alex", "Player Name: auto should detect resolved scenario setup names.");
assert(globalThis.text.includes("relationship_alex"), "Auto-detected player name should feed memory slot guidance.");
globalThis.state.MindForge.agent = "Mira";
globalThis.state.MindForge.hash = "";
globalThis.history = [{ text: "Mira enters the Silver Observatory.", type: "story" }];
globalThis.text = "Mira enters the Silver Observatory and studies its mirrored dome.";
MindForge("output");
assert(!globalThis.storyCards.some(c => c.keys === "mindforge_world"), "World Memory should not create a world card while disabled by default.");

// --- Test 44: Scenario Auto-Discovery registers only high-confidence main NPCs ---
globalThis.state = {};
globalThis.storyCards = [];
globalThis.history = [{
    text: [
        "Your name is Leo.",
        "The person who finds you is Clara.",
        "",
        "Plot Essentials",
        "{ Player:",
        "Name: Leo",
        "Role: ex-agent }",
        "",
        "{ Main NPC:",
        "Name: Clara",
        "Connection: former partner }",
        "",
        "{ Core:",
        "This is a compact showcase. }",
        "",
        "For Leo. Open only when Clara arrives.",
        "Clara steps in, stops at the sight of the capsule, then looks at you.",
        "\"So it found you too,\" Clara says."
    ].join("\n"),
    type: "story"
}];
globalThis.text = `Recent Story:\n${globalThis.history[0].text}`;
MindForge("context");
const scenarioConfigCard = globalThis.storyCards.find(c => c.keys === "mindforge_config");
const scenarioConfigLines = scenarioConfigCard.description.split("\n");
const claraConfigLineIdx = scenarioConfigLines.findIndex(line => line.trim() === "Clara");
const scenarioGuideLineIdx = scenarioConfigLines.findIndex(line => line.includes("MindForge Quick Guide"));
assert(globalThis.state.MindForge.playerName === "Leo", "Scenario Auto-Discovery should cooperate with automatic player-name detection.");
assert(claraConfigLineIdx !== -1, "Scenario Auto-Discovery should append a clear main NPC to config notes.");
assert(scenarioGuideLineIdx === -1 || claraConfigLineIdx < scenarioGuideLineIdx, "Scenario Auto-Discovery should keep discovered NPCs above the guide comments.");
assert(globalThis.storyCards.some(c => {
    try {
        const meta = JSON.parse(c.keys);
        return meta && meta.agent === "Clara";
    } catch { return false; }
}), "Scenario Auto-Discovery should create the discovered NPC brain card.");
assert((globalThis.state.MindForge.health.scenarioDiscoveries || 0) > 0, "Scenario Auto-Discovery should be counted silently.");

globalThis.state = {};
globalThis.storyCards = [];
globalThis.history = [{
    text: [
        "Your name is Alex.",
        "The person who finds you is Mira.",
        "A paper tag reads: Open only when Mira arrives.",
        "Mira steps in and studies the sealed capsule."
    ].join("\n"),
    type: "story"
}];
globalThis.text = `Recent Story:\n${globalThis.history[0].text}`;
MindForge("context");
const naturalDiscoveryCard = globalThis.storyCards.find(c => c.keys === "mindforge_config");
assert(naturalDiscoveryCard.description.split("\n").some(line => line.trim() === "Mira"), "Scenario Auto-Discovery should use high-confidence opening sentences when Plot Essentials are absent.");

globalThis.state = {};
globalThis.storyCards = [];
globalThis.history = [{
    text: [
        "Kansercocuk:",
        "Leo",
        "",
        "{ Location:",
        "Name: Berlin }",
        "",
        "The room is cold and quiet."
    ].join("\n"),
    type: "story"
}];
globalThis.text = `Recent Story:\n${globalThis.history[0].text}`;
MindForge("context");
assert(!globalThis.storyCards.some(c => {
    try {
        const meta = JSON.parse(c.keys);
        return meta && (meta.agent === "Leo" || meta.agent === "Berlin");
    } catch { return false; }
}), "Scenario Auto-Discovery should ignore ambiguous custom headings and non-NPC blocks.");

// --- Test 45: World Memory silently writes and injects lore when enabled ---
const worldConfigCard = globalThis.storyCards.find(c => c.keys === "mindforge_config");
worldConfigCard.entry = "MindForge Configuration\n\nEnabled: true\nPlayer Name: Alex\nModel Profile (Stable/Balanced/Full): Balanced\nThought Chance (0-100): 0\nWorld Memory: true\nMax Lore Keys (3-30): 8";
worldConfigCard.description = "NPC Names (first name followed by optional comma-separated aliases):\n// MindForge Quick Guide:\nNora";
const loreBrainCard = globalThis.addStoryCard(
    JSON.stringify({ agent: "Nora" }),
    `// MindForge Brain Card initialized @ UTC\n// Operation Log:\n`,
    "Brain",
    "Nora Brain",
    "goal_current: Nora must inspect the archive.",
    { returnCard: true }
);
globalThis.state.MindForge.agent = "Nora";
globalThis.state.MindForge.hash = "";
globalThis.history = [{ text: "Nora approaches the Obsidian Archive.", type: "story" }];
globalThis.text = "[+memory_recent: Nora enters the Obsidian Archive.] Nora enters the Obsidian Archive and listens to its humming walls.";
MindForge("output");
const worldCard = globalThis.storyCards.find(c => c.keys === "mindforge_world");
assert(worldCard && worldCard.description.includes("obsidian_archive"), "World Memory should create a world memory card from normal story output when enabled.");
globalThis.state.MindForge.scene = { agent: "", ttl: 0 };
globalThis.history = [{ text: "Nora returns to the Obsidian Archive.", type: "story" }];
globalThis.text = "Recent Story:\nNora returns to the Obsidian Archive.";
MindForge("context");
assert(globalThis.text.includes("# World Memory:"), "Relevant World Memory should be injected automatically when mentioned.");
assert(globalThis.text.includes("obsidian_archive"), "World context should include the relevant lore key.");

// --- Test 46: Parser normalizer repairs loose unenclosed operations ---
globalThis.state.MindForge.agent = "Nora";
globalThis.state.MindForge.hash = "";
loreBrainCard.description = "core_identity: Nora is the archive keeper.";
globalThis.history = [{ text: "Nora studies the Obsidian Archive.", type: "story" }];
globalThis.text = "goal current = Nora protects the Obsidian Archive. Nora moves deeper.";
MindForge("output");
const parsedAfterLooseParser = parseBrain(loreBrainCard);
assert(parsedAfterLooseParser.goal_current === "Nora protects the Obsidian Archive.", "Parser normalizer should repair loose unenclosed assignment operations.");
assert(globalThis.text.replace(/[\u200B-\u200D]/g, "") === "Nora moves deeper.", "Loose operation repair should remove operation text from the final story.");
assert((globalThis.state.MindForge.health.parserLooseOps || 0) > 0, "Loose parser repairs should be counted silently.");

console.log("\nAll MindForge regression tests passed.");
