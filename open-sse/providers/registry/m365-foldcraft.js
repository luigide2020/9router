export default {
  id: "m365-foldcraft",
  priority: 31,
  alias: "foldcraft",
  aliases: ["fc"],
  uiAlias: "foldcraft",
  display: {
    name: "M365 Foldcraft",
    icon: "precision_manufacturing",
    color: "#7C3AED",
    textIcon: "FC",
    website: "https://m365.cloud.microsoft",
    notice: {
      authHint: "Shares M365 Copilot token (same auth source)",
    },
  },
  category: "cookie",
  transport: {
    baseUrl: "https://substrate.office.com/m365Copilot/Chathub",
    format: "openai",
  },
  models: [
    { id: "foldcraft", name: "Foldcraft (Reasoning)", defaultReasoning: true },
    { id: "foldcraft-fast", name: "Foldcraft (Fast)" },
  ],
};
