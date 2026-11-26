// Tiny self-migrator for the POC: applies any migration not yet recorded in _migrations, once per isolate.
// The .sql files in /migrations are the source of truth. Later this can move to `wrangler d1 migrations apply`.

import m0001 from "../migrations/0001_init.sql";

const MIGRATIONS = [["0001_init", m0001]];

let ready = null;

function statements(sql) {
  return sql.split("\n").map(l => l.replace(/--.*$/, "")).join("\n")
    .split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
}

export function ensureSchema(env) {
  if (!env.DB) throw new Error("The database isn't connected yet (missing D1 binding named DB).");
  if (!ready) {
    ready = (async () => {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, at TEXT NOT NULL)").run();
      const done = new Set((await env.DB.prepare("SELECT name FROM _migrations").all()).results.map(r => r.name));
      for (const [name, sql] of MIGRATIONS) {
        if (done.has(name)) continue;
        const stmts = statements(sql).map(s => env.DB.prepare(s));
        stmts.push(env.DB.prepare("INSERT INTO _migrations (name, at) VALUES (?, ?)").bind(name, new Date().toISOString()));
        await env.DB.batch(stmts);
      }
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}
