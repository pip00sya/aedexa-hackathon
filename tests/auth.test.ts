import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  clearedSessionCookie,
  createAccount,
  createSessionToken,
  endSession,
  findAccountByEmail,
  hashPassword,
  hashSessionToken,
  looksLikeEmail,
  normalizeEmail,
  passwordProblem,
  readCookie,
  readSession,
  sessionCookie,
  startSession,
  verifyPassword,
  SESSION_COOKIE,
  type Database,
} from "../app/lib/auth/accounts.ts";

function memoryDatabase(): Database & { accounts: Map<string, Record<string, string>> } {
  const accounts = new Map<string, Record<string, string>>();
  const sessions = new Map<string, { accountId: string; expiresAt: string }>();

  return {
    accounts,
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              if (query.includes("FROM accounts WHERE email")) {
                const row = accounts.get(String(values[0]));
                return (row as T) ?? null;
              }
              if (query.includes("FROM sessions s JOIN accounts")) {
                const session = sessions.get(String(values[0]));
                if (!session) return null;
                const account = [...accounts.values()].find(
                  (item) => item.id === session.accountId,
                );
                if (!account) return null;
                return { ...account, expiresAt: session.expiresAt } as T;
              }
              return null;
            },
            async run() {
              if (query.startsWith("INSERT INTO accounts")) {
                const [id, email, name, passwordHash, createdAt] = values.map(String);
                accounts.set(email, { id, email, name, passwordHash, createdAt });
              }
              if (query.startsWith("INSERT INTO sessions")) {
                const [tokenHash, accountId, expiresAt] = values.map(String);
                sessions.set(tokenHash, { accountId, expiresAt });
              }
              if (query.startsWith("DELETE FROM sessions")) sessions.delete(String(values[0]));
              return undefined;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  };
}

test("password is never stored in plain text, and verification tells right from wrong", async () => {
  const stored = await hashPassword("правильная-лошадь-батарейка");

  assert.equal(stored.includes("правильная"), false, "password leaked into the stored string");
  assert.match(
    stored,
    /^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/u,
    "hash format with parameters",
  );
  assert.equal(await verifyPassword("правильная-лошадь-батарейка", stored), true);
  assert.equal(await verifyPassword("правильная-лошадь-батарейкА", stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("identical passwords give different hashes: the salt is random", async () => {
  const first = await hashPassword("one-and-the-same-string");
  const second = await hashPassword("one-and-the-same-string");
  assert.notEqual(first, second, "without salt, identical passwords give each other away");
  assert.equal(await verifyPassword("one-and-the-same-string", first), true);
  assert.equal(await verifyPassword("one-and-the-same-string", second), true);
});

test("a corrupted hash string lets nobody in", async () => {
  for (const broken of ["", "not-a-hash", "pbkdf2$", "sha1$1$aa$bb", "pbkdf2$100000$aa"]) {
    assert.equal(
      await verifyPassword("anything", broken),
      false,
      `string "${broken}" was accepted`,
    );
  }
});

test("the database stores the session hash, not the token itself", async () => {
  const token = createSessionToken();
  assert.match(token, /^[0-9a-f]{64}$/u, "256 bits of randomness");

  const hash = await hashSessionToken(token);
  assert.notEqual(hash, token, "a database row can't be used to sign in");
  assert.equal(await hashSessionToken(token), hash, "hash is stable");
  assert.notEqual(await hashSessionToken(createSessionToken()), hash);
});

test("password rules are about length, not character sets", () => {
  assert.match(passwordProblem("short") ?? "", /shorter than 10/u);
  assert.match(passwordProblem("1234567890123") ?? "", /digits-only/u);
  assert.equal(passwordProblem("long password made of words"), null);
  assert.match(passwordProblem("x".repeat(201)) ?? "", /longer than 200/u);
});

test("email is lowercased and checked for shape", () => {
  assert.equal(normalizeEmail("  Иван@Пример.KZ "), "иван@пример.kz");
  assert.equal(looksLikeEmail("a@b.kz"), true);
  assert.equal(looksLikeEmail("no-at-sign.kz"), false);
  assert.equal(looksLikeEmail("two@@at-signs.kz"), false);
  assert.equal(looksLikeEmail("no@domain"), false);
});

test("session cookie is hidden from scripts and other subdomains", () => {
  const cookie = sessionCookie("token", new Date("2026-10-09T00:00:00Z"));
  assert.ok(cookie.startsWith("__Host-aedexa-session=token"), "the __Host- prefix is required");
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) {
    assert.ok(cookie.includes(flag), `missing flag ${flag}`);
  }
  assert.ok(clearedSessionCookie().includes("Max-Age=0"), "sign out clears the cookie");
});

test("cookie is read from a header with other cookies", () => {
  assert.equal(readCookie(`a=1; ${SESSION_COOKIE}=xyz; b=2`, SESSION_COOKIE), "xyz");
  assert.equal(readCookie("a=1; b=2", SESSION_COOKIE), null);
  assert.equal(readCookie(null, SESSION_COOKIE), null);
});

test("full flow: sign up, sign in with a session, sign out", async () => {
  const db = memoryDatabase();
  const account = await createAccount(
    db,
    "  Проектировщик@Бюро.KZ ",
    "  Асель  ",
    "long password made of words",
  );

  assert.equal(account.email, "проектировщик@бюро.kz", "email is normalized");
  assert.equal(account.name, "Асель", "name is trimmed");

  const stored = await findAccountByEmail(db, "ПРОЕКТИРОВЩИК@бюро.kz");
  assert.ok(stored, "account is found regardless of case");
  assert.equal(await verifyPassword("long password made of words", stored.passwordHash), true);

  const session = await startSession(db, account.id);
  const restored = await readSession(db, session.token);
  assert.equal(restored?.email, "проектировщик@бюро.kz", "session returns its owner");
  assert.equal(await readSession(db, createSessionToken()), null, "an unknown token is rejected");

  await endSession(db, session.token);
  assert.equal(await readSession(db, session.token), null, "session is dead after sign out");
});

test("expired session is rejected", async () => {
  const db = memoryDatabase();
  const account = await createAccount(db, "a@b.kz", "Name", "long password made of words");
  const session = await startSession(db, account.id);

  // Swap the expiry for a past date: cleanup runs separately, but access must be denied
  const hash = await hashSessionToken(session.token);
  await db
    .prepare("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)")
    .bind(hash, account.id, new Date(Date.now() - 1000).toISOString())
    .run();

  assert.equal(await readSession(db, session.token), null);
});

test("routes get the database from the shared binding module", async () => {
  for (const route of ["auth", "projects"]) {
    const source = await readFile(new URL(`../app/api/${route}/route.ts`, import.meta.url), "utf8");
    assert.ok(!source.includes("process.env"), `${route}: binding is not read from process.env`);
    assert.ok(
      source.includes('from "../../lib/auth/db"'),
      `${route}: database comes from the shared module`,
    );
  }
});
