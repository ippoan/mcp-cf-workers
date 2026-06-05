import { defineConfig } from "vitest/config";

/**
 * plain node vitest (本体 @ippoan/mcp-cf-workers と同じ defineConfig)。
 *
 * このワーカーは Durable Object を持たないので workerd (vitest-pool-workers) は
 * 不要。ロジック (lib/cf-api.ts の CF REST client、mcp/tools.ts の tool 実体、
 * middleware/binding-jwt.ts の introspect) はすべて fetch / client を引数で
 * 差し替え可能な pure 関数にしてあるため node 上で直接テストできる。
 *
 * MCP SDK / Hono 配線 (mcp/server.ts / index.ts) は exclude する (ajv が
 * pool loader と相性が悪いのと、配線自体はロジックを持たないため)。
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/env.ts", "src/index.ts", "src/mcp/server.ts"],
    },
  },
});
