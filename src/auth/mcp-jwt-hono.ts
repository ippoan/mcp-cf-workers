import type { MiddlewareHandler } from "hono";
import {
  verifyMcpJwt,
  McpJwtError,
  type McpJwtClaims,
} from "./mcp-jwt";

type EnvShape = {
  MCP_JWT_SECRET: string;
  MCP_JWT_AUDIENCE: string;
};

/**
 * Hono middleware for HS256 MCP-JWT bearer auth — the symmetric counterpart to
 * `cfAccessMiddleware`. Reads `MCP_JWT_SECRET` + `MCP_JWT_AUDIENCE` from the
 * binding env, verifies the `Authorization: Bearer` token, and exposes the
 * claims on `c.var.mcpJwt`.
 *
 * - 500 when the secret / audience binding is missing (`server_misconfigured`)
 * - 401 with a coarse `reason` on any verification failure
 *
 * Mount it in front of the `/mcp` route so `createWorkerMcp` only sees
 * authenticated requests.
 */
export function mcpJwtMiddleware<E extends EnvShape = EnvShape>(
  override?: Pick<McpJwtConfigOverride, "clockToleranceSec">,
): MiddlewareHandler<{ Bindings: E; Variables: { mcpJwt: McpJwtClaims } }> {
  return async (c, next) => {
    if (!c.env.MCP_JWT_SECRET || !c.env.MCP_JWT_AUDIENCE) {
      return c.json(
        { error: "server_misconfigured", reason: "no_jwt_secret_or_audience" },
        500,
      );
    }
    try {
      const claims = await verifyMcpJwt(c.req.raw, {
        secret: c.env.MCP_JWT_SECRET,
        audience: c.env.MCP_JWT_AUDIENCE,
        ...(override?.clockToleranceSec !== undefined
          ? { clockToleranceSec: override.clockToleranceSec }
          : {}),
      });
      c.set("mcpJwt", claims);
    } catch (err) {
      const reason = err instanceof McpJwtError ? err.reason : "verify";
      return c.json({ error: "unauthorized", reason }, 401);
    }
    await next();
  };
}

type McpJwtConfigOverride = { clockToleranceSec?: number };
