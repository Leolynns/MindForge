const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const srcDir = path.join(rootDir, "src");
const distDir = path.join(rootDir, "dist");
const files = ["input.js", "context.js", "output.js", "library.js"];

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

for (const file of files) {
    const source = path.join(srcDir, file);
    const target = path.join(distDir, file);
    if (!fs.existsSync(source)) {
        throw new Error(`Missing source file: ${source}`);
    }
    fs.copyFileSync(source, target);
}

const assetsDir = path.join(rootDir, "assets");
if (fs.existsSync(assetsDir)) {
    fs.cpSync(assetsDir, path.join(distDir, "assets"), { recursive: true });
}

for (const file of ["README.md", "NOTICE", "LICENSE"]) {
    const source = path.join(rootDir, file);
    if (fs.existsSync(source)) {
        fs.copyFileSync(source, path.join(distDir, file));
    }
}

const installText = [
    "# MindForge AI Dungeon Install",
    "",
    "Copy each file into the matching AI Dungeon script tab:",
    "",
    "- input.js -> Input",
    "- context.js -> Context",
    "- output.js -> Output",
    "- library.js -> Library",
    "",
    "Start or continue the scenario once. MindForge will create its",
    "configuration card and any detected NPC brain cards in the background.",
    "",
    "For public scenarios, leave Player Name on auto when your prompt reveals",
    "the setup answer in text such as \"Your name is ${Your name?}\"; set it",
    "manually if needed. Leave Model Profile on Balanced unless you are",
    "targeting cache or smaller models; use Stable for those. Keep Brain",
    "Steward, Agentic Charter, Auto Doctor, Bootstrap Empty Brains, Memory",
    "Slots, and Thought Quality Gate enabled for hands-off NPC minds. World",
    "Memory is optional and disabled by default."
].join("\n");

fs.writeFileSync(path.join(distDir, "INSTALL.md"), installText);

console.log(`Built MindForge release package: ${distDir}`);
