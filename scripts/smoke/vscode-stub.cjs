// Minimal stub of the 'vscode' module for exercising extension-host code outside VS Code.
const cfg = { executablePath: "muse", environmentVariables: [], autosave: false };
module.exports = {
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({ get: (k, d) => (k in cfg ? cfg[k] : d), update: async () => {} }),
    workspaceFolders: [],
  },
  window: {},
  commands: { executeCommand: async () => {} },
  ConfigurationTarget: { Global: 1 },
};
