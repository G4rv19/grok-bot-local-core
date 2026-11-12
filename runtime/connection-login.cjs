"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { recipes } = require("./cli-connections.cjs");
// Interactive authorization runs in Terminal, outside the Bot tool interface.
// The CLI owns credentials. No token, browser cookie or OAuth secret is returned.
async function openGoogleLogin(dataDir, shell) {
  const recipe = recipes().find((x) => x.id === "gmail");
  if (!recipe.command)
    throw new Error("Install Google Workspace CLI before connecting Google");
  const directory = path.join(dataDir, "account-setup");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "Connect Google.command");
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(
    file,
    `#!/bin/zsh\nexport PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin\nprint 'Connect Gmail and Calendar to Grok Bot Local'\nprint 'The CLI will guide Google project setup and open account authorization.'\nif [ ! -f "$HOME/.config/gws/client_secret.json" ]; then\n  ${quote(recipe.command)} auth setup || exit 1\nfi\n${quote(recipe.command)} auth login --services gmail,calendar\nprint 'Return to Grok Bot Local and choose Test connection.'\nread '?Press Return to close this setup window.'\n`,
    { mode: 0o700 },
  );
  const error = await shell.openPath(file);
  if (error) throw new Error(error);
}
module.exports = { openGoogleLogin };
