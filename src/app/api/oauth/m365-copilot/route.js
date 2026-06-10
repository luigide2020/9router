import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";

const TOKEN_DIR = join(homedir(), ".9router");
const TOKEN_FILE = join(TOKEN_DIR, "m365-token.json");

/**
 * Decode JWT payload without verification
 */
function decodeJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
  } catch {
    return null;
  }
}

function ensureTokenDir() {
  if (!existsSync(TOKEN_DIR)) mkdirSync(TOKEN_DIR, { recursive: true });
}

function readSavedToken() {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
    if (!data.accessToken) return null;
    const claims = decodeJwt(data.accessToken);
    if (claims?.exp && claims.exp * 1000 < Date.now()) {
      return { ...data, expired: true };
    }
    return { ...data, expired: false };
  } catch {
    return null;
  }
}

/**
 * GET /api/oauth/m365-copilot
 * Returns the current saved token status
 */
export async function GET() {
  const saved = readSavedToken();
  if (!saved) {
    return NextResponse.json({
      hasToken: false,
      message: "No M365 Copilot token saved. Use the extraction script or paste a token.",
    });
  }

  const claims = decodeJwt(saved.accessToken);
  return NextResponse.json({
    hasToken: true,
    expired: saved.expired,
    userPrincipalName: saved.userPrincipalName || claims?.upn || claims?.preferred_username || "unknown",
    tenantId: saved.tenantId || claims?.tid || "unknown",
    objectId: saved.objectId || claims?.oid || "unknown",
    extractedAt: saved.extractedAt,
    expiresAt: saved.expiresAt || (claims?.exp ? new Date(claims.exp * 1000).toISOString() : "unknown"),
  });
}

/**
 * POST /api/oauth/m365-copilot
 * 
 * Actions:
 * - { action: "save", accessToken: "ey..." }  → Save a manually pasted token
 * - { action: "extract" }                       → Trigger Puppeteer extraction (spawns child process)
 * - { action: "delete" }                        → Delete saved token
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const action = body.action || "save";

    if (action === "delete") {
      if (existsSync(TOKEN_FILE)) {
        const { unlinkSync } = await import("fs");
        unlinkSync(TOKEN_FILE);
      }
      return NextResponse.json({ success: true, message: "Token deleted" });
    }

    if (action === "extract") {
      // Spawn the Puppeteer extraction script as a child process
      const scriptPath = join(process.cwd(), "scripts", "extract-m365-token.js");

      if (!existsSync(scriptPath)) {
        return NextResponse.json({
          error: "Extraction script not found. Run: node scripts/extract-m365-token.js manually after installing puppeteer.",
        }, { status: 400 });
      }

      // Check if puppeteer is available
      try {
        await import("puppeteer");
      } catch {
        return NextResponse.json({
          error: "puppeteer is not installed. Run: npm install puppeteer && npx puppeteer browsers install chrome",
        }, { status: 400 });
      }

      return new Promise((resolve) => {
        const child = spawn(process.execPath, [scriptPath], {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env },
          detached: false,
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

        const timeout = setTimeout(() => {
          child.kill("SIGTERM");
          resolve(NextResponse.json({
            error: "Extraction timed out (5 minutes). Try running manually: node scripts/extract-m365-token.js",
            output: stdout.slice(-500),
          }, { status: 408 }));
        }, 6 * 60 * 1000);

        child.on("close", (code) => {
          clearTimeout(timeout);
          if (code === 0) {
            // Read the saved token file
            const saved = readSavedToken();
            if (saved) {
              resolve(NextResponse.json({
                success: true,
                message: "Token extracted successfully",
                userPrincipalName: saved.userPrincipalName,
                expiresAt: saved.expiresAt,
              }));
            } else {
              resolve(NextResponse.json({
                error: "Extraction script completed but no token was saved",
                output: stdout.slice(-500),
              }, { status: 500 }));
            }
          } else {
            resolve(NextResponse.json({
              error: `Extraction script exited with code ${code}`,
              stderr: stderr.slice(-500),
              stdout: stdout.slice(-500),
            }, { status: 500 }));
          }
        });

        child.on("error", (err) => {
          clearTimeout(timeout);
          resolve(NextResponse.json({
            error: `Failed to spawn extraction script: ${err.message}`,
          }, { status: 500 }));
        });
      });
    }

    // Default: save action
    const accessToken = body.accessToken?.trim();
    if (!accessToken) {
      return NextResponse.json({ error: "accessToken is required" }, { status: 400 });
    }

    // Validate JWT format
    if (!accessToken.startsWith("ey")) {
      return NextResponse.json({ error: "Invalid token format. Expected JWT starting with 'ey...'" }, { status: 400 });
    }

    const claims = decodeJwt(accessToken);
    if (!claims) {
      return NextResponse.json({ error: "Failed to decode token. Ensure it is a valid JWT." }, { status: 400 });
    }

    // Check if token is for substrate
    const audience = claims.aud || "";
    if (!audience.includes("substrate") && !audience.includes("sydney") && !audience.includes("office")) {
      // Warn but don't block — token might still work
    }

    // Check expiry
    if (claims.exp && claims.exp * 1000 < Date.now()) {
      return NextResponse.json({
        error: "Token is already expired. Please extract a fresh token.",
        expiresAt: new Date(claims.exp * 1000).toISOString(),
      }, { status: 400 });
    }

    // Save token
    ensureTokenDir();
    const tokenData = {
      accessToken,
      extractedAt: new Date().toISOString(),
      expiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : "unknown",
      userPrincipalName: claims.upn || claims.preferred_username || "unknown",
      tenantId: claims.tid || "unknown",
      objectId: claims.oid || "unknown",
    };
    writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));

    return NextResponse.json({
      success: true,
      message: "Token saved successfully",
      userPrincipalName: tokenData.userPrincipalName,
      expiresAt: tokenData.expiresAt,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
