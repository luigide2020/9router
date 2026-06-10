#!/usr/bin/env node

/**
 * M365 Copilot Token Extractor
 * 
 * Usage:
 *   npx puppeteer browsers install chrome
 *   node scripts/extract-m365-token.js
 *
 * This script opens a browser window for you to log in to Microsoft 365,
 * then automatically extracts the substrate.office.com access token
 * needed for the M365 Copilot executor.
 * 
 * The token is printed to stdout and saved to ~/.9router/m365-token.json
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

async function main() {
  let puppeteer;
  try {
    puppeteer = await import("puppeteer");
    if (puppeteer.default) puppeteer = puppeteer.default;
  } catch {
    console.error("❌ puppeteer not installed. Run: npm install puppeteer");
    console.error("   Then: npx puppeteer browsers install chrome");
    process.exit(1);
  }

  console.log("🚀 Launching browser...");
  const browser = await puppeteer.launch({
    headless: false, // Must be headed for user to log in
    args: ["--disable-blink-features=AutomationControlled"],
    defaultViewport: null,
  });

  const page = await browser.newPage();

  // Remove webdriver flag to avoid detection
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  console.log("📄 Navigating to Microsoft 365 Copilot...");
  await page.goto("https://www.office.com/launch?appid=c2d1442c-ab1e-4d58-a737-77a1e0121b73", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  console.log("");
  console.log("⏳ Please log in to your Microsoft 365 account in the browser window.");
  console.log("   The script will automatically detect when the token is available.");
  console.log("   (Timeout: 5 minutes)");
  console.log("");

  // Wait for the Copilot page to fully load (up to 5 minutes for login)
  const START_TIME = Date.now();
  const MAX_WAIT_MS = 5 * 60 * 1000;
  let token = null;
  let tokenClaims = null;

  while (Date.now() - START_TIME < MAX_WAIT_MS) {
    try {
      // Check if we're on the outlook domain (token is stored there)
      const currentUrl = page.url();

      // Try to extract token from outlook.office.com localStorage
      if (currentUrl.includes("office.com") || currentUrl.includes("microsoft.com")) {
        // Navigate to outlook.office.com if not already there
        if (!currentUrl.includes("outlook.office.com")) {
          try {
            await page.goto("https://outlook.office.com", {
              waitUntil: "domcontentloaded",
              timeout: 30_000,
            });
            await new Promise((r) => setTimeout(r, 3000));
          } catch {
            // May redirect — that's fine
          }
        }

        // Try to extract substrate token from localStorage
        const result = await page.evaluate(() => {
          try {
            const keys = Object.keys(localStorage);
            // Look for keys containing substrate token
            // Microsoft stores tokens in various formats in localStorage
            for (const key of keys) {
              const value = localStorage.getItem(key);
              if (!value) continue;

              // Try parsing as JSON — Microsoft Auth Library (MSAL) format
              try {
                const parsed = JSON.parse(value);
                if (parsed.secret && parsed.credentialType === "AccessToken") {
                  // Check if it's for substrate.office.com
                  const target = parsed.target || "";
                  const realm = parsed.realm || "";
                  if (
                    target.includes("substrate") ||
                    target.includes("office.com") ||
                    key.includes("substrate") ||
                    key.includes("sydney")
                  ) {
                    // Decode to check expiry
                    const parts = parsed.secret.split(".");
                    if (parts.length >= 2) {
                      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
                      if (payload.exp && payload.exp * 1000 > Date.now()) {
                        return {
                          token: parsed.secret,
                          claims: payload,
                          key,
                          expiresAt: new Date(payload.exp * 1000).toISOString(),
                        };
                      }
                    }
                  }
                }
              } catch {
                // Not JSON, try raw token values
                if (value.startsWith("ey") && value.split(".").length >= 2) {
                  try {
                    const parts = value.split(".");
                    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
                    if (
                      payload.aud &&
                      (payload.aud.includes("substrate") || payload.aud.includes("sydney")) &&
                      payload.exp * 1000 > Date.now()
                    ) {
                      return {
                        token: value,
                        claims: payload,
                        key,
                        expiresAt: new Date(payload.exp * 1000).toISOString(),
                      };
                    }
                  } catch { /* skip */ }
                }
              }
            }

            // Fallback: try intercepting network requests for substrate
            return null;
          } catch (e) {
            return { error: e.message };
          }
        });

        if (result?.token) {
          token = result.token;
          tokenClaims = result.claims;
          console.log(`✅ Token found in localStorage key: ${result.key}`);
          console.log(`   Expires: ${result.expiresAt}`);
          break;
        }
      }
    } catch {
      // Page might be navigating — retry
    }

    // Progress indicator
    const elapsed = Math.floor((Date.now() - START_TIME) / 1000);
    if (elapsed % 10 === 0) {
      process.stdout.write(`   Waiting... ${elapsed}s elapsed\r`);
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!token) {
    // Last resort: try to intercept via network request
    console.log("\n⚠️  Token not found in localStorage. Trying network interception...");

    try {
      // Navigate to copilot and intercept WebSocket connection
      const interceptedToken = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("No WebSocket request detected in 30s")), 30_000);

        page.on("request", (request) => {
          const url = request.url();
          if (url.includes("substrate.office.com") && url.includes("access_token=")) {
            clearTimeout(timeout);
            const match = url.match(/access_token=([^&]+)/);
            if (match) resolve(decodeURIComponent(match[1]));
          }
        });

        page.goto("https://www.office.com/launch?appid=c2d1442c-ab1e-4d58-a737-77a1e0121b73").catch(() => {});
      });

      if (interceptedToken) {
        token = interceptedToken;
        console.log("✅ Token captured from network request");
      }
    } catch (err) {
      console.error(`❌ Network interception failed: ${err.message}`);
    }
  }

  await browser.close();

  if (!token) {
    console.error("");
    console.error("❌ Failed to extract token. Manual instructions:");
    console.error("   1. Open https://outlook.office.com in your browser");
    console.error("   2. Open DevTools (F12) → Application → Local Storage");
    console.error("   3. Look for https://outlook.office.com entries");
    console.error("   4. Find keys containing 'AccessToken' or 'substrate'");
    console.error("   5. Copy the 'secret' field value (JWT starting with 'ey...')");
    process.exit(1);
  }

  // Save token
  const tokenDir = join(homedir(), ".9router");
  if (!existsSync(tokenDir)) mkdirSync(tokenDir, { recursive: true });
  const tokenFile = join(tokenDir, "m365-token.json");

  const tokenData = {
    accessToken: token,
    extractedAt: new Date().toISOString(),
    expiresAt: tokenClaims?.exp ? new Date(tokenClaims.exp * 1000).toISOString() : "unknown",
    userPrincipalName: tokenClaims?.upn || tokenClaims?.preferred_username || "unknown",
    tenantId: tokenClaims?.tid || "unknown",
    objectId: tokenClaims?.oid || "unknown",
  };

  writeFileSync(tokenFile, JSON.stringify(tokenData, null, 2));

  console.log("");
  console.log("✅ Token saved to: " + tokenFile);
  console.log("");
  console.log("📋 Token details:");
  console.log(`   User: ${tokenData.userPrincipalName}`);
  console.log(`   Tenant: ${tokenData.tenantId}`);
  console.log(`   Expires: ${tokenData.expiresAt}`);
  console.log("");
  console.log("💡 To use in 9Router:");
  console.log("   1. Open the dashboard → Web Cookie Providers → M365 Copilot");
  console.log("   2. Paste the token (or the script will auto-save it)");
  console.log("");
  console.log("📋 Raw token (copy to clipboard):");
  console.log(token);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
