/**
 * Worker の binding 型。
 *
 * CF Zero Trust API token は CF Secrets Store binding (`SecretsStoreSecret`)
 * 経由で runtime に `.get()` で取得する (= 値を worker code / wrangler vars に
 * 焼き込まない)。`CF_ACCOUNT_ID` / `AUTH_WORKER_ORIGIN` は plain const。
 */
export interface Env {
  /** CF Zero Trust API token。CF Secrets Store binding。`.get()` で string を取る。 */
  CF_ZEROTRUST_API_TOKEN: SecretsStoreSecret;

  /** account-scoped CF API の account id (= base URL 組み立てに使う)。 */
  CF_ACCOUNT_ID: string;

  /**
   * binding_jwt introspect 先 (auth-worker)。例: https://auth.ippoan.org。
   * discovery.ts の /.well-known/* proxy と WWW-Authenticate 表示にのみ使う
   * (introspect自体は下の AUTH_WORKER service binding 経由、Refs #62)。
   */
  AUTH_WORKER_ORIGIN: string;

  /** auth-worker への Service Binding (`/mcp/introspect` 呼び出し用、Refs #62)。 */
  AUTH_WORKER: Fetcher;
}
