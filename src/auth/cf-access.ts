import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface CfAccessConfig {
  teamDomain: string;          // e.g. "mtamaramu.cloudflareaccess.com"
  audience: string;            // CF Access Application AUD tag
  jwksOverride?: JWTVerifyGetKey;
}

export interface CfAccessClaims {
  sub?: string;
  email?: string;
  identity_nonce?: string;
  [key: string]: unknown;
}

export class CfAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfAccessError";
  }
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

export async function verifyCfAccessJwt(
  request: Request,
  config: CfAccessConfig,
): Promise<CfAccessClaims> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new CfAccessError("missing Cf-Access-Jwt-Assertion");

  const jwks = config.jwksOverride ?? getJwks(config.teamDomain);
  const { payload } = await jwtVerify(token, jwks, {
    audience: config.audience,
    issuer: `https://${config.teamDomain}`,
  });
  return payload as CfAccessClaims;
}

function getJwks(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
    );
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

export function _resetJwksCacheForTests(): void {
  jwksCache.clear();
}
