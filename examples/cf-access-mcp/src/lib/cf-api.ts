/**
 * Cloudflare Zero Trust (Access) REST client。
 *
 * 設計方針 (issue #26):
 *  - base URL と fetch 実装を constructor field 化し、テストで httptest 相当に
 *    差し替えられるようにする (本番は global fetch + 公式エンドポイント)。
 *  - account-scoped API (`/accounts/{account_id}/access/*`) のみを扱う。
 *  - token は呼び出し側 (server.ts) が CF Secrets Store binding の `.get()` で
 *    取得して string で渡す (= この client は binding に依存しない pure logic)。
 *  - CF の共通 envelope (`{ success, errors, messages, result }`) を解いて
 *    `result` だけ返す。`success:false` / 非 2xx は {@link CfApiRequestError}。
 *
 * read (`list_*` / `get_*`, PR1) + write (`create` / `update` / `delete`, PR2)。
 */

/** CF API の共通 envelope。 */
interface CfEnvelope<T> {
  success: boolean;
  errors: CfApiError[];
  messages: unknown[];
  result: T;
}

/** CF API が返す individual error (`{ code, message }`)。 */
export interface CfApiError {
  code: number;
  message: string;
}

/**
 * CF API 呼び出しの失敗。`status` は HTTP status (fetch 自体の失敗は 0)、
 * `errors` は CF envelope の `errors[]` (取れた場合)。値漏れ防止のため
 * message には CF が返す error code / message のみを載せ、token は含めない。
 */
export class CfApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly errors: CfApiError[],
    message: string,
  ) {
    super(message);
    this.name = "CfApiRequestError";
  }
}

/** CF の各リソースは要点だけ型付けし、残りは素通し (read はそのまま JSON で返す)。 */
export type CfRecord = Record<string, unknown>;

/**
 * Access policy の include rule (CF の include[] 要素)。allow 系を表現する:
 * - `email`: 特定アドレスを許可
 * - `email_domain`: ドメイン全体を許可
 * - `everyone`: 認証さえ通れば誰でも (IdP 未指定なら One-time PIN)
 */
export type AccessInclude =
  | { email: { email: string } }
  | { email_domain: { domain: string } }
  | { everyone: Record<string, never> };

export interface CreateAccessPolicyBody {
  name: string;
  decision: string;
  include: AccessInclude[];
}

export interface CreateAccessAppBody {
  name: string;
  type: string;
  domain: string;
  policies?: string[];
  allowed_idps?: string[];
}

export interface CfClientOptions {
  /** CF account id。account-scoped base URL の組み立てに使う。 */
  accountId: string;
  /** CF Zero Trust API token (Bearer)。 */
  token: string;
  /** base URL override (test 差し替え用)。default は公式エンドポイント。 */
  baseUrl?: string;
  /** fetch 実装の override (test 差し替え用)。default は global fetch。 */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";

export class CfAccessClient {
  private readonly accountBase: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CfClientOptions) {
    const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.accountBase = `${base}/accounts/${opts.accountId}`;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * account base 相対 path へ 1 本叩く。`body` を渡すと JSON 化して送る
   * (POST/PUT)。CF envelope を解いて `result` を返し、`success:false` / 非 2xx /
   * non-JSON / fetch 失敗は {@link CfApiRequestError}。
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let resp: Response;
    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      resp = await this.fetchImpl(`${this.accountBase}${path}`, init);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CfApiRequestError(0, [], `CF API fetch failed: ${msg}`);
    }

    let parsed: CfEnvelope<T>;
    try {
      parsed = (await resp.json()) as CfEnvelope<T>;
    } catch {
      throw new CfApiRequestError(
        resp.status,
        [],
        `CF API returned non-JSON body (HTTP ${resp.status})`,
      );
    }

    if (!resp.ok || !parsed.success) {
      const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
      const detail =
        errors.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${resp.status}`;
      throw new CfApiRequestError(resp.status, errors, `CF API error: ${detail}`);
    }
    return parsed.result;
  }

  // ----- Access read endpoints (PR1) ---------------------------------------

  /** GET /access/apps — Access applications (uid / name / domain / type / aud)。 */
  listAccessApps(): Promise<CfRecord[]> {
    return this.request<CfRecord[]>("GET", "/access/apps");
  }

  /** GET /access/apps/{uid} — 単一 Access application。 */
  getAccessApp(uid: string): Promise<CfRecord> {
    return this.request<CfRecord>("GET", `/access/apps/${encodeURIComponent(uid)}`);
  }

  /** GET /access/policies — reusable Access policies。 */
  listAccessPolicies(): Promise<CfRecord[]> {
    return this.request<CfRecord[]>("GET", "/access/policies");
  }

  /** GET /access/service_tokens — Access service tokens (メタデータのみ)。 */
  listServiceTokens(): Promise<CfRecord[]> {
    return this.request<CfRecord[]>("GET", "/access/service_tokens");
  }

  /** GET /access/identity_providers — IdP 一覧 (allowed_idps に使う id)。 */
  listIdentityProviders(): Promise<CfRecord[]> {
    return this.request<CfRecord[]>("GET", "/access/identity_providers");
  }

  /** GET /access/groups — Access groups。 */
  listAccessGroups(): Promise<CfRecord[]> {
    return this.request<CfRecord[]>("GET", "/access/groups");
  }

  // ----- Access write endpoints (PR2) --------------------------------------

  /** POST /access/policies — reusable policy を作成。応答に policy id を含む。 */
  createAccessPolicy(body: CreateAccessPolicyBody): Promise<CfRecord> {
    return this.request<CfRecord>("POST", "/access/policies", body);
  }

  /** DELETE /access/policies/{uid} — reusable policy を削除。 */
  deleteAccessPolicy(uid: string): Promise<CfRecord> {
    return this.request<CfRecord>("DELETE", `/access/policies/${encodeURIComponent(uid)}`);
  }

  /** POST /access/apps — self_hosted app を作成。応答に uid / aud を含む。 */
  createAccessApp(body: CreateAccessAppBody): Promise<CfRecord> {
    return this.request<CfRecord>("POST", "/access/apps", body);
  }

  /** PUT /access/apps/{uid} — app を更新 (CF は full replace)。 */
  updateAccessApp(uid: string, patch: CfRecord): Promise<CfRecord> {
    return this.request<CfRecord>("PUT", `/access/apps/${encodeURIComponent(uid)}`, patch);
  }

  /** DELETE /access/apps/{uid} — app を削除。 */
  deleteAccessApp(uid: string): Promise<CfRecord> {
    return this.request<CfRecord>("DELETE", `/access/apps/${encodeURIComponent(uid)}`);
  }
}
