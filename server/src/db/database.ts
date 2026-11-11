import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { loadConfig } from '../config.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const cfg = loadConfig();
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const file = path.join(cfg.dataDir, 'datax.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      must_change_password INTEGER NOT NULL DEFAULT 1,
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS data_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT NOT NULL,
      password_enc TEXT NOT NULL DEFAULT '',
      database TEXT NOT NULL DEFAULT '',
      schema TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      connection_id INTEGER,
      connection_name TEXT,
      sql TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      rules_hit TEXT NOT NULL DEFAULT '',
      ai_summary TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL,
      executed INTEGER NOT NULL DEFAULT 0,
      elapsed_ms INTEGER NOT NULL DEFAULT 0,
      result TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_data_permissions (
      user_id INTEGER NOT NULL,
      connection_id INTEGER NOT NULL,
      database_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, connection_id, database_name),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (connection_id) REFERENCES data_sources(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      requester_id INTEGER NOT NULL,
      requester_name TEXT NOT NULL,
      connection_id INTEGER NOT NULL,
      connection_name TEXT NOT NULL,
      database_name TEXT NOT NULL,
      sql TEXT NOT NULL,
      audit_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewer_id INTEGER,
      reviewer_name TEXT,
      review_comment TEXT NOT NULL DEFAULT '',
      executed INTEGER NOT NULL DEFAULT 0,
      elapsed_ms INTEGER NOT NULL DEFAULT 0,
      result TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (connection_id) REFERENCES data_sources(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_hidden_databases (
      user_id INTEGER NOT NULL,
      connection_id INTEGER NOT NULL,
      database_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, connection_id, database_name),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (connection_id) REFERENCES data_sources(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_permission_user ON user_data_permissions(user_id);
    CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status, created_at);
  `);

  // 增量迁移：旧库补 token_version 列（改密后吊销旧 JWT）
  const userColumns = d.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
  if (!userColumns.some((col) => col.name === 'token_version')) {
    d.exec(`ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0`);
  }

  // 初始化管理员
  const cfg = loadConfig();
  const existing = d.prepare('SELECT id FROM users WHERE username = ?').get(cfg.adminUsername);
  if (!existing) {
    const hash = bcrypt.hashSync(cfg.adminPassword, 10);
    d.prepare(
      `INSERT INTO users (username, password_hash, role, must_change_password)
       VALUES (?, ?, 'admin', 1)`
    ).run(cfg.adminUsername, hash);
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
