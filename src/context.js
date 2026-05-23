globalThis.stop ??= false;
MindForge("context");
const modifier = (text) => {
  return { text, stop: globalThis.stop === true };
};
modifier(text);
