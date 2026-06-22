export default {
  id: "m365-copilot",
  priority: 30,
  alias: "m365",
  aliases: ["copilot"],
  uiAlias: "m365",
  display: {
    name: "M365 Copilot",
    icon: "smart_toy",
    color: "#0078D4",
    textIcon: "M3",
    website: "https://m365.cloud.microsoft",
    notice: {
      authHint: "Paste your substrate.office.com access token (from browser localStorage at outlook.office.com)",
    },
  },
  category: "cookie",
  transport: {
    baseUrl: "https://substrate.office.com/m365Copilot/Chathub",
    format: "m365-copilot",
  },
  models: [
    { id: "copilot", name: "M365 Copilot (Auto)" },
    { id: "gpt-5.5", name: "GPT-5.5 (via Copilot)", defaultReasoning: true },
    { id: "gpt-5.2", name: "GPT-5.2 (via Copilot)" },
  ],
};
