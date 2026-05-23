import type { MiddlewareHandler } from "hono";
import {
  verifyCfAccessJwt,
  CfAccessError,
  type CfAccessClaims,
  type CfAccessConfig,
} from "./cf-access";

type EnvShape = {
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
};

export function cfAccessMiddleware<E extends EnvShape = EnvShape>(
  override?: Pick<CfAccessConfig, "jwksOverride">,
): MiddlewareHandler<{ Bindings: E; Variables: { cfAccess: CfAccessClaims } }> {
  return async (c, next) => {
    if (!c.env.CF_ACCESS_TEAM_DOMAIN || !c.env.CF_ACCESS_AUD) {
      return c.json(
        { error: "CF Access misconfigured: team domain or audience missing" },
        500,
      );
    }
    try {
      const claims = await verifyCfAccessJwt(c.req.raw, {
        teamDomain: c.env.CF_ACCESS_TEAM_DOMAIN,
        audience: c.env.CF_ACCESS_AUD,
        ...(override?.jwksOverride ? { jwksOverride: override.jwksOverride } : {}),
      });
      c.set("cfAccess", claims);
    } catch (err) {
      const msg =
        err instanceof CfAccessError
          ? err.message
          : err instanceof Error
            ? err.message
            : "verification failed";
      return c.json({ error: `CF Access JWT: ${msg}` }, 401);
    }
    await next();
  };
}
