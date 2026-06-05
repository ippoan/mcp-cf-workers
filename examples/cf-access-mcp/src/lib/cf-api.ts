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
 * PR1 は read (`list_*` / `get_*`) のみ。write (create/update/delete) は PR2。
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

  /** path は account base からの相対 (例 `/access/apps`)。GET 専用 (read tools)。 */
  private async request<T>(path: string): Promise<T> {
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.accountBase}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CfApiRequestError(0, [], `CF API fetch failed: ${msg}`);
    }

    let body: CfEnvelope<T>;
    try {
      body = (await resp.json()) as CfEnvelope<T>;
    } catch {
      throw new CfApiRequestError(
        resp.status,
        [],
        `CF API returned non-JSON body (HTTP ${resp.status})`,
      );
    }

    if (!resp.ok || !body.success) {
      const errors = Array.isArray(body.errors) ? body.errors : [];
      const detail =
        errors.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${resp.status}`;
      throw new CfApiRequestError(resp.status, errors, `CF API error: ${detail}`);
    }
    return body.result;
  }

  // ----- Access read endpoints (PR1) ---------------------------------------

  /** GET /access/apps — Access applications (uid / name / domain / type / aud)。 */
  listAccessApps(): Promise<CfRecord[]> {
    return this.request<CfRecord[]>("/access/apps");
  }

  /** GET /access/apps/{uid} — 単一 Access application。 */
  getAccessApp(uid: string): Promise<CfRecord> {
    return this.request<CfRecord>(`/access/apps/${encodeURIComponent(uid)}`);
  }

  /** GET /access/policies — reusable Access policies。 */
  listAccessPolicies(): Promise<CfRecord[]> {
    return this.request<CfRecord[]>("/access/policies");
  }

  /** GET /access/service_tokens — Access service tokens (メタデータのみ)。 */
  listServiceTokens(): Promise<CfRecord[]> {
    return this.request<CfRecord[]>("/access/service_tokens");
  }

  /** GET /access/identity_providers — IdP 一覧 (allowed_idps に使う id)。 */
  listIdentityProviders(): Promise<CfRecord[]> {
    return this.request<CfRecord[]>("/access/identity_providers");
  }

  /** GET /access/groups — Access groups。 */
  listAccessGroups(): Promise<CfRecord[]> {
    return this.request<CfRecord[]>("/access/groups");
  }
}
