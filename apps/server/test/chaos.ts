/**
 * Fault injection for the resilience tests (test/chaos.test.ts). Everything stays inside the test's own database and
 * process — the Postgres and Redis services are shared, so they are never stopped:
 *
 *  - DbChaos: kills one pooled connection (pg_terminate_backend from an admin connection, as a Postgres restart or a
 *    DBA would) at a chosen statement of the app's queries, before it runs or right after it ran (for COMMIT: the
 *    transaction is committed but the server sees a connection failure).
 *  - databaseOutage: no connection to the test database is possible (ALLOW_CONNECTIONS false, existing backends
 *    terminated) until restore().
 *  - TcpProxy: a cut-able TCP hop in front of a service (Redis).
 */
import { createServer, Socket, type AddressInfo, type Server } from 'node:net';
import pg from 'pg';
import { TEST_ADMIN_URL } from './global-setup.js';

export interface KillPlan {
  /** The statement at which the connection is killed (matched against the SQL text). */
  at: RegExp;
  /**
   * 'before': the connection dies before the statement reaches Postgres — it fails and Postgres rolls the transaction
   * back. 'after': it dies once the statement has run — for COMMIT the transaction is durable, yet the caller sees a
   * connection failure (the "did it commit?" case a retry must handle).
   */
  when: 'before' | 'after';
  /** Only on a connection that ran a statement matching this first, since it was checked out (the transaction of interest). */
  after?: RegExp;
}

type QueryFn = (...args: unknown[]) => unknown;
type QueryCallback = (err: Error | null, res?: unknown) => void;
type ConnectCallback = (err: Error | undefined, client: pg.PoolClient | undefined, release: (e?: unknown) => void) => void;
type ChaosClient = pg.PoolClient & { processID?: number; __chaosWrapped?: true };

function sqlText(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object' && typeof (arg as { text?: unknown }).text === 'string') return (arg as { text: string }).text;
  return '';
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Terminate backends from a separate admin connection, waiting until they are gone. */
export async function terminateBackends(pids: number[]): Promise<void> {
  if (!pids.length) return;
  await admin((c) => c.query('SELECT pg_terminate_backend(pid, 5000) FROM unnest($1::int[]) AS pid', [pids]));
}

/** Backend pids of the connections a pool (by its application_name) has open to `dbName`, idle or in use. */
export async function backendPids(dbName: string, applicationName = 'smartproctoring'): Promise<number[]> {
  const { rows } = await admin((c) => c.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE datname = $1 AND application_name = $2', [dbName, applicationName]));
  return rows.map((r) => r.pid);
}

/** Those of `pids` whose transaction is open and waiting for the app (no statement running). */
export async function idleInTransaction(pids: number[]): Promise<number[]> {
  const { rows } = await admin((c) => c.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND state = 'idle in transaction'`, [pids]));
  return rows.map((r) => r.pid);
}

export class DbChaos {
  private plan: (KillPlan & { fired: () => void }) | null = null;
  /** Clients that ran the plan's `after` statement in their current checkout. */
  private readonly primed = new WeakSet<pg.PoolClient>();

  constructor(private readonly pool: pg.Pool) {
    const connect = pool.connect.bind(pool) as (cb?: ConnectCallback) => Promise<pg.PoolClient> | void;
    const wrapped = (cb?: ConnectCallback) => {
      if (cb) {
        return connect((err, client, release) => {
          if (client) this.wrap(client as ChaosClient);
          cb(err, client, release);
        });
      }
      return (connect() as Promise<pg.PoolClient>).then((client) => {
        this.wrap(client as ChaosClient);
        return client;
      });
    };
    pool.connect = wrapped as pg.Pool['connect'];
    pool.on('release', (_err: unknown, client: pg.PoolClient) => this.primed.delete(client));
  }

  /** Arm one kill; resolves once it happened. */
  arm(plan: KillPlan): Promise<void> {
    return new Promise((resolve) => {
      this.plan = { ...plan, fired: resolve };
    });
  }

  disarm(): void {
    this.plan = null;
  }

  /** True until the armed kill happened. */
  get armed(): boolean {
    return this.plan != null;
  }

  get poolStats() {
    return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount };
  }

  private wrap(client: ChaosClient): void {
    if (client.__chaosWrapped) return;
    client.__chaosWrapped = true;
    const query = client.query.bind(client) as QueryFn;
    (client as { query: QueryFn }).query = (...args: unknown[]) => {
      const plan = this.plan;
      if (!plan) return query(...args);
      const text = sqlText(args[0]);
      if (plan.after?.test(text)) this.primed.add(client);
      if (!plan.at.test(text) || (plan.after && !this.primed.has(client))) return query(...args);
      this.plan = null;
      const kill = () => terminateBackends(client.processID ? [client.processID] : []).finally(plan.fired);
      const cb = typeof args[args.length - 1] === 'function' ? (args[args.length - 1] as QueryCallback) : null;
      if (plan.when === 'before') {
        if (!cb) return kill().then(() => query(...args));
        kill().then(
          () => query(...args),
          (err: Error) => cb(err),
        );
        return undefined;
      }
      const lost = () => new Error('Connection terminated unexpectedly');
      if (!cb) {
        return (query(...args) as Promise<unknown>).then(async () => {
          await kill();
          throw lost();
        });
      }
      query(...args.slice(0, -1), (err: Error | null) => {
        if (err) return cb(err);
        kill().then(
          () => cb(lost()),
          (e: Error) => cb(e),
        );
      });
      return undefined;
    };
  }
}

/**
 * The test database becomes unreachable: new connections are refused ("database is not currently accepting
 * connections") and the open ones are terminated. Only this database is affected. Call restore() (also in finally).
 */
export async function databaseOutage(dbName: string): Promise<{ restore(): Promise<void> }> {
  await admin(async (c) => {
    await c.query(`ALTER DATABASE "${dbName}" WITH ALLOW_CONNECTIONS false`);
    await c.query('SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]);
  });
  let restored = false;
  return {
    async restore() {
      if (restored) return;
      restored = true;
      await admin((c) => c.query(`ALTER DATABASE "${dbName}" WITH ALLOW_CONNECTIONS true`));
    },
  };
}

/**
 * A TCP hop to `target` that can be cut: cut() resets every open connection and refuses new ones (they are accepted
 * and reset at once) until restore().
 */
export class TcpProxy {
  private readonly sockets = new Set<Socket>();
  private down = false;
  private constructor(private readonly server: Server) {}

  static async start(target: { host: string; port: number }): Promise<TcpProxy> {
    const proxy: TcpProxy = new TcpProxy(
      createServer((client) => {
        if (proxy.down) {
          client.resetAndDestroy();
          return;
        }
        const upstream = new Socket();
        proxy.sockets.add(client).add(upstream);
        const drop = () => {
          proxy.sockets.delete(client);
          proxy.sockets.delete(upstream);
          client.destroy();
          upstream.destroy();
        };
        client.on('error', drop).on('close', drop);
        upstream.on('error', drop).on('close', drop);
        upstream.connect(target.port, target.host, () => {
          client.pipe(upstream);
          upstream.pipe(client);
        });
      }),
    );
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    return proxy;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  cut(): void {
    this.down = true;
    for (const s of this.sockets) s.resetAndDestroy();
    this.sockets.clear();
  }

  restore(): void {
    this.down = false;
  }

  async close(): Promise<void> {
    this.cut();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
