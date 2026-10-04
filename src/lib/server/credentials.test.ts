import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialEnvironment } from "./credentials";
import { loadMcpConfig, parseMcpConfig, resolveCredential } from "./mcp/config";

/**
 * MCP credentials are named by the operator in mcp.json, so they cannot be declared in
 * src/env.ts. Under SvelteKit 3 an undeclared name reads as `undefined` through
 * `$app/env/private`; these tests fail if the lookup stops seeing a variable that was never
 * declared anywhere.
 */
const created: string[] = [];
const directories: string[] = [];

/** A variable name and value that exist nowhere else: built at runtime, obviously fake. */
function dummyCredential(): { name: string; value: string } {
  const suffix = `${process.pid}_${Date.now()}_${created.length}`;
  const name = `SETUN_TEST_DUMMY_MCP_CREDENTIAL_${suffix}`;
  const value = ["dummy", "credential", "not", "a", "real", "secret", suffix].join("-");
  process.env[name] = value;
  created.push(name);
  return { name, value };
}

afterEach(() => {
  for (const name of created.splice(0)) delete process.env[name];
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("credentialEnvironment", () => {
  test("sees a credential variable that src/env.ts does not declare", () => {
    const { name, value } = dummyCredential();
    const resolved = credentialEnvironment()[name];
    expect(resolved).toBeDefined();
    expect(resolved).toBe(value);
  });

  test("resolves an mcp.json credential named by the operator", () => {
    const { name, value } = dummyCredential();
    const directory = mkdtempSync(join(tmpdir(), "setun-mcp-test-"));
    directories.push(directory);
    const path = join(directory, "mcp.json");
    writeFileSync(
      path,
      JSON.stringify({
        servers: {
          dummy: { label: "Dummy server", url: "https://mcp.invalid/mcp", credentialEnv: name },
        },
      }),
    );

    // loadMcpConfig refuses a configuration whose named credential reads as unset.
    const config = loadMcpConfig({ path, env: credentialEnvironment() });

    expect(config.servers).toHaveLength(1);
    const [server] = config.servers;
    expect(server?.credentialEnv).toBe(name);
    expect(server && resolveCredential(server, credentialEnvironment())).toBe(value);
  });

  test("still refuses a named credential that is really unset", () => {
    const { name } = dummyCredential();
    delete process.env[name];
    const [server] = parseMcpConfig(
      JSON.stringify({
        servers: { dummy: { label: "Dummy", url: "https://mcp.invalid/mcp", credentialEnv: name } },
      }),
    );
    expect(() => server && resolveCredential(server, credentialEnvironment())).toThrow(name);
  });
});
