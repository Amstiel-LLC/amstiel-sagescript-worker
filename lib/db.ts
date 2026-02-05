// lib/db.ts
import { Pool, QueryResult, QueryResultRow } from "pg";
import { DefaultAzureCredential } from "@azure/identity";

let pool: Pool | null = null;

// Azure AD authentication for managed identity
const credential = new DefaultAzureCredential();
const PG_AAD_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

async function getAADToken(): Promise<string> {
  const token = await credential.getToken(PG_AAD_SCOPE);
  if (!token) {
    throw new Error("Failed to acquire AAD token for PostgreSQL");
  }
  return token.token;
}

function validateConfig(): void {
  if (!process.env.AZURE_POSTGRES_HOST || !process.env.AZURE_POSTGRES_DB) {
    throw new Error(
      "Missing database configuration. Set AZURE_POSTGRES_HOST and AZURE_POSTGRES_DB"
    );
  }
}

function getPool(): Pool {
  if (pool) return pool;

  validateConfig();

  // Azure AD token-based authentication (managed identity)
  pool = new Pool({
    host: process.env.AZURE_POSTGRES_HOST,
    database: process.env.AZURE_POSTGRES_DB,
    user: process.env.AZURE_POSTGRES_USER || "worker-mi",
    port: parseInt(process.env.AZURE_POSTGRES_PORT || "5432", 10),
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    // Dynamic password function - fetches fresh AAD token
    password: async () => await getAADToken(),
  });

  console.log("[db] Worker configured with Azure AD managed identity authentication");

  return pool;
}

/**
 * Execute a parameterized query.
 * Returns { rows, rowCount } or throws on error.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const p = getPool();
  return p.query<T>(text, params);
}

/**
 * Get the underlying pool for transactions or advanced use.
 */
export function getDb(): Pool {
  return getPool();
}

/**
 * Gracefully close the pool (for clean shutdown).
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
