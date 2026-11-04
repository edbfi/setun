/**
 * The Drizzle schema, one module per aggregate (PRD §19).
 *
 * Re-exported here as the single surface the connection module binds and the
 * query modules import; the migration generator reads it through this file too.
 */
export * from "./artifact";
export * from "./attachment";
export * from "./classroom";
export * from "./classroom-mcp-tool";
export * from "./classroom-model-alias";
export * from "./classroom-skill";
export * from "./context-summary";
export * from "./conversation";
export * from "./educator";
export * from "./generated-image";
export * from "./instance";
export * from "./login-attempt";
export * from "./mcp-server";
export * from "./mcp-tool";
export * from "./message";
export * from "./model-alias";
export * from "./session";
export * from "./skill";
export * from "./student";
export * from "./turn";
export * from "./usage-event";
