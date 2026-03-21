import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseEnvFile, loadEnv, getUserDir } from "./envLoader.ts";

// ---------------------------------------------------------------------------
// parseEnvFile — pure unit tests
// ---------------------------------------------------------------------------

describe("parseEnvFile", () => {
  it("parses KEY=VALUE pairs", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips comments and empty lines", () => {
    const input = `
# This is a comment
FOO=bar

  # Indented comment

BAZ=qux
`;
    const result = parseEnvFile(input);
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("handles values containing = signs", () => {
    const result = parseEnvFile("URL=http://host:8080/path?a=1&b=2");
    expect(result).toEqual({ URL: "http://host:8080/path?a=1&b=2" });
  });

  it("strips double quotes from values", () => {
    const result = parseEnvFile('NAME="John Doe"');
    expect(result).toEqual({ NAME: "John Doe" });
  });

  it("strips single quotes from values", () => {
    const result = parseEnvFile("NAME='John Doe'");
    expect(result).toEqual({ NAME: "John Doe" });
  });

  it("handles empty values", () => {
    const result = parseEnvFile("EMPTY=");
    expect(result).toEqual({ EMPTY: "" });
  });

  it("skips lines without = sign", () => {
    const result = parseEnvFile("NOEQ\nFOO=bar");
    expect(result).toEqual({ FOO: "bar" });
  });

  it("trims whitespace around keys", () => {
    const result = parseEnvFile("  FOO  =bar");
    expect(result).toEqual({ FOO: "bar" });
  });
});

// ---------------------------------------------------------------------------
// loadEnv — integration tests with temp directories
// ---------------------------------------------------------------------------

describe("loadEnv", () => {
  let projectDir: string;
  let userDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  const keysToClean: string[] = [];

  function saveKey(key: string) {
    if (!(key in savedEnv)) {
      savedEnv[key] = process.env[key];
      keysToClean.push(key);
    }
  }

  function setEnvKey(key: string, value: string) {
    saveKey(key);
    process.env[key] = value;
  }

  function deleteEnvKey(key: string) {
    saveKey(key);
    delete process.env[key];
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "envloader-proj-"));
    userDir = mkdtempSync(join(tmpdir(), "envloader-user-"));
    // Point RELAY_USER_DIR to our temp user dir
    setEnvKey("RELAY_USER_DIR", userDir);
  });

  afterEach(() => {
    // Restore all saved env keys
    for (const key of keysToClean) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    keysToClean.length = 0;
    Object.keys(savedEnv).forEach((k) => delete savedEnv[k]);

    // Clean up temp dirs
    try { rmSync(projectDir, { recursive: true }); } catch {}
    try { rmSync(userDir, { recursive: true }); } catch {}
  });

  it("loads base .env values correctly", () => {
    writeFileSync(join(projectDir, ".env"), "TEST_ENVLOADER_A=from_project\n");
    deleteEnvKey("TEST_ENVLOADER_A");

    loadEnv(projectDir);

    expect(process.env.TEST_ENVLOADER_A).toBe("from_project");
  });

  it("user override .env takes precedence over base", () => {
    writeFileSync(join(projectDir, ".env"), "TEST_ENVLOADER_B=from_project\n");
    writeFileSync(join(userDir, ".env"), "TEST_ENVLOADER_B=from_user\n");
    deleteEnvKey("TEST_ENVLOADER_B");

    loadEnv(projectDir);

    expect(process.env.TEST_ENVLOADER_B).toBe("from_user");
  });

  it("process.env takes precedence over both files", () => {
    writeFileSync(join(projectDir, ".env"), "TEST_ENVLOADER_C=from_project\n");
    writeFileSync(join(userDir, ".env"), "TEST_ENVLOADER_C=from_user\n");
    setEnvKey("TEST_ENVLOADER_C", "from_runtime");

    loadEnv(projectDir);

    expect(process.env.TEST_ENVLOADER_C).toBe("from_runtime");
  });

  it("missing user .env file is gracefully handled (no crash)", () => {
    // Remove the user dir entirely
    rmSync(userDir, { recursive: true });

    writeFileSync(join(projectDir, ".env"), "TEST_ENVLOADER_D=from_project\n");
    deleteEnvKey("TEST_ENVLOADER_D");

    // Should not throw
    expect(() => loadEnv(projectDir)).not.toThrow();
    expect(process.env.TEST_ENVLOADER_D).toBe("from_project");
  });

  it("missing project .env file is gracefully handled", () => {
    // Don't create any .env in projectDir
    deleteEnvKey("TEST_ENVLOADER_E");

    expect(() => loadEnv(projectDir)).not.toThrow();
    expect(process.env.TEST_ENVLOADER_E).toBeUndefined();
  });

  it("merges keys from both project and user .env", () => {
    writeFileSync(join(projectDir, ".env"), "TEST_ENVLOADER_F1=proj_only\n");
    writeFileSync(join(userDir, ".env"), "TEST_ENVLOADER_F2=user_only\n");
    deleteEnvKey("TEST_ENVLOADER_F1");
    deleteEnvKey("TEST_ENVLOADER_F2");

    loadEnv(projectDir);

    expect(process.env.TEST_ENVLOADER_F1).toBe("proj_only");
    expect(process.env.TEST_ENVLOADER_F2).toBe("user_only");
  });

  it("comments and empty lines in .env are skipped", () => {
    writeFileSync(
      join(projectDir, ".env"),
      "# comment\n\nTEST_ENVLOADER_G=value\n  # another comment\n\n"
    );
    deleteEnvKey("TEST_ENVLOADER_G");

    loadEnv(projectDir);

    expect(process.env.TEST_ENVLOADER_G).toBe("value");
  });
});

// ---------------------------------------------------------------------------
// getUserDir
// ---------------------------------------------------------------------------

describe("getUserDir", () => {
  const savedRelayUserDir = process.env.RELAY_USER_DIR;

  afterEach(() => {
    if (savedRelayUserDir === undefined) {
      delete process.env.RELAY_USER_DIR;
    } else {
      process.env.RELAY_USER_DIR = savedRelayUserDir;
    }
  });

  it("returns RELAY_USER_DIR when set", () => {
    process.env.RELAY_USER_DIR = "/custom/relay/dir";
    expect(getUserDir()).toBe("/custom/relay/dir");
  });

  it("defaults to ~/.claude-relay when RELAY_USER_DIR is not set", () => {
    delete process.env.RELAY_USER_DIR;
    const { homedir } = require("os");
    expect(getUserDir()).toBe(join(homedir(), ".claude-relay"));
  });
});
