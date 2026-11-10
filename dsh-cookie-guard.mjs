#!/usr/bin/env node
/**
 * dsh-cookie-guard —— 预防 DSH 桌面端「Web authentication failed」启动崩溃。
 *
 * 背景（2026-11-10 事故；上游 deepseek-harness #11293 / #11366 已确认，官方尚未修复）：
 *   每次启动 DSH，本地 Web 宿主都会给 127.0.0.1 下发一个新的 dsh-auth-* cookie，
 *   名字 = "dsh-auth-" + base64url(sha256(authority))，而 authority 含**每次随机**的端口；
 *   Chromium 按域名（不按端口）存 cookie，于是每次启动净增一条、Max-Age 30 天从不回收。
 *   累积约 70 条后 Cookie 请求头超过 Node 默认 16KB 上限，宿主回 431，
 *   外壳 connectDesktopWelcome 只判断 res.ok，于是抛
 *   "desktop welcome: Web authentication failed"，应用启动失败。
 *
 * 治理思路：
 *   cookie 库在 DSH 运行期间被 Chromium 独占锁定，只能在**启动前**或**退出后**清理。
 *   因此提供：
 *     --check          只读体检
 *     --clean          直接清理（要求 DSH 未运行）
 *     --clean-if-idle  DSH 未运行才清理（给计划任务用，可安全重复调用）
 *     --launch         清理后启动 DSH（给启动器用）
 *
 * 只删 host_key='127.0.0.1' 且 name 以 dsh-auth- 开头的行，不动任何其他 cookie。
 * 每次改动前自动备份，只保留最近 5 份。
 *
 * 用法：
 *   node dsh-cookie-guard.mjs --check
 *   node dsh-cookie-guard.mjs --clean --keep 0
 *   node dsh-cookie-guard.mjs --clean-if-idle --quiet
 *   node dsh-cookie-guard.mjs --launch
 *   node dsh-cookie-guard.mjs --check --db <某个 Cookies 备份>
 */

import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Node 的 16KB(16384) 上限统计的是**整个请求头块**，Cookie 之外还有 Host /
 * User-Agent / Accept 等。实测本机 71 条 cookie 拼出 16117 字节时已 431，
 * 15000 字节仍 303 —— 所以给 Cookie 单独的预算是 15200，留约 1.2KB 给其他头。
 */
const HEADER_LIMIT = 16384;
const COOKIE_BUDGET = 15200;
const WARN_AT = 11000;
const MAX_BACKUPS = 5;
const APP_EXE =
  process.env.DSH_DESKTOP_EXE ||
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');

const COOKIE_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  '@deepseek-ai',
  'dsh-desktop',
  'Network',
);
const DEFAULT_DB = path.join(COOKIE_DIR, 'Cookies');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};
const strOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const QUIET = has('--quiet') || has('--silent');
const log = (...a) => { if (!QUIET) console.log(...a); };
const warn = (...a) => console.log(...a);

const DB = path.resolve(strOf('--db', DEFAULT_DB));
const IS_DEFAULT_DB = DB.toLowerCase() === path.resolve(DEFAULT_DB).toLowerCase();

/** DSH 桌面端主进程是否在跑（Electron 会占用 cookie 库）。 */
function appRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.includes('DeepSeek Harness.exe');
  } catch {
    return false;
  }
}

/** 统计 127.0.0.1 名下 cookie 行数与估算 Cookie 头长度。 */
function headerStats(db) {
  const rows = db
    .prepare(
      "select name, length(name) + max(length(value), length(encrypted_value)) + 2 as bytes " +
        "from cookies where host_key = '127.0.0.1'",
    )
    .all();
  return {
    auth: rows.filter((r) => r.name.startsWith('dsh-auth-')).length,
    loopback: rows.length,
    bytes: rows.reduce((sum, r) => sum + r.bytes, 0),
  };
}

/** 主库被独占锁定时，复制到临时目录读一份副本。 */
function readSnapshot() {
  try {
    const db = new DatabaseSync(DB, { readOnly: true });
    const stats = headerStats(db);
    db.close();
    return stats;
  } catch {}
  const tmp = path.join(os.tmpdir(), `dsh-cookies-snapshot-${process.pid}.db`);
  try {
    fs.copyFileSync(DB, tmp);
    for (const ext of ['-journal', '-wal']) {
      if (fs.existsSync(DB + ext)) fs.copyFileSync(DB + ext, tmp + ext);
    }
  } catch (error) {
    const e = new Error(`cookie 库被 DeepSeek Harness 独占锁定，无法读取（${error.code ?? error.message}）`);
    e.code = 'LOCKED';
    e.cause = error;
    throw e;
  }
  const db = new DatabaseSync(tmp, { readOnly: true });
  const stats = headerStats(db);
  db.close();
  for (const f of [tmp, tmp + '-journal', tmp + '-wal']) {
    try { fs.unlinkSync(f); } catch {}
  }
  return stats;
}

function pruneBackups() {
  try {
    const dir = path.dirname(DB);
    const base = path.basename(DB);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.bak-`))
      .sort()
      .reverse();
    for (const f of files.slice(MAX_BACKUPS)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  } catch {}
}

function backup() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const dest = `${DB}.bak-${stamp}`;
  fs.copyFileSync(DB, dest);
  for (const ext of ['-journal', '-wal']) {
    if (fs.existsSync(DB + ext)) fs.copyFileSync(DB + ext, dest + ext);
  }
  pruneBackups();
  return dest;
}

/**
 * 打开主库并删除旧 dsh-auth-* 条目。
 * @returns 结果对象；库被占用时抛带 code='LOCKED' 的错误。
 */
function clean(keep) {
  let db;
  try {
    db = new DatabaseSync(DB);
    db.prepare('select count(*) n from cookies').get();
  } catch (error) {
    try { db?.close(); } catch {}
    const e = new Error('cookie 库被占用（DeepSeek Harness 正在运行）');
    e.code = 'LOCKED';
    e.cause = error;
    throw e;
  }

  const before = headerStats(db);
  const rows = db
    .prepare(
      "select rowid from cookies where host_key = '127.0.0.1' and name like 'dsh-auth-%' " +
        'order by creation_utc desc',
    )
    .all();
  const doomed = rows.slice(keep).map((r) => r.rowid);

  if (doomed.length === 0) {
    db.close();
    return { before, after: before, removed: 0, backup: null };
  }

  const backupPath = backup();
  const del = db.prepare('delete from cookies where rowid = ?');
  for (const id of doomed) del.run(id);
  db.exec('VACUUM');
  const after = headerStats(db);
  db.close();
  return { before, after, removed: doomed.length, backup: backupPath };
}

function reportLine(s) {
  const pct = ((s.bytes / COOKIE_BUDGET) * 100).toFixed(0);
  const level = s.bytes > COOKIE_BUDGET ? '超限' : s.bytes > WARN_AT ? '预警' : '正常';
  return `dsh-auth-* ${s.auth} 条 | 127.0.0.1 共 ${s.loopback} 条 | Cookie 头约 ${s.bytes} / ${COOKIE_BUDGET} 字节（${pct}%，${level}）`;
}

function cmdCheck() {
  if (!fs.existsSync(DB)) {
    warn(`[x] 找不到 cookie 库: ${DB}`);
    return 1;
  }
  let stats;
  try {
    stats = readSnapshot();
  } catch (error) {
    if (error.code === 'LOCKED') {
      warn(`[!] ${error.message}`);
      warn('    体检请在完全退出 DSH 后运行，或用 --launch 走启动前清理。');
      return 5;
    }
    throw error;
  }
  log(`库文件: ${DB}`);
  log(reportLine(stats));
  if (stats.bytes > COOKIE_BUDGET) {
    warn('[!] 已超过 Cookie 头预算（16KB 请求头扣掉其他头后的余量）—— 下次启动大概率报 Web authentication failed，请立即 --clean');
    return 3;
  }
  if (stats.bytes > WARN_AT) {
    warn('[~] 已进入预警区间，建议尽快 --clean');
    return 2;
  }
  return 0;
}

function cmdClean(keep) {
  if (!fs.existsSync(DB)) {
    warn(`[x] 找不到 cookie 库: ${DB}`);
    return 1;
  }
  if (IS_DEFAULT_DB && appRunning()) {
    warn('[x] DeepSeek Harness 正在运行，cookie 库被占用，无法清理。');
    warn('    请从托盘完全退出后重试，或改用 --clean-if-idle 交给计划任务。');
    return 4;
  }
  try {
    const r = clean(keep);
    log(`清理前: ${reportLine(r.before)}`);
    if (r.removed === 0) {
      log('[=] 没有需要清理的 dsh-auth-* cookie');
      return 0;
    }
    log(`已备份: ${r.backup}`);
    log(`已删除 ${r.removed} 条；清理后: ${reportLine(r.after)}`);
    return 0;
  } catch (error) {
    if (error.code === 'LOCKED') {
      warn('[x] cookie 库被占用，无法清理；请先完全退出 DeepSeek Harness。');
      return 4;
    }
    throw error;
  }
}

function cmdCleanIfIdle(keep) {
  if (!fs.existsSync(DB)) return 0;
  if (IS_DEFAULT_DB && appRunning()) {
    log('[=] DeepSeek Harness 正在运行，跳过本次清理');
    return 0;
  }
  try {
    const r = clean(keep);
    if (r.removed > 0) {
      warn(`[ok] 已清理 ${r.removed} 条 dsh-auth-* cookie（保留 ${keep} 条）；当前 ${reportLine(r.after)}`);
    } else {
      log('[=] 无需清理');
    }
    return 0;
  } catch (error) {
    if (error.code === 'LOCKED') {
      log('[=] cookie 库仍被占用（可能正在启动/退出），跳过');
      return 0;
    }
    throw error;
  }
}

function cmdLaunch(keep) {
  const running = appRunning();
  if (!running) {
    try {
      const r = clean(keep);
      if (r.removed > 0) {
        log(`[ok] 启动前已清理 ${r.removed} 条旧 dsh-auth-* cookie（${reportLine(r.before)} -> ${reportLine(r.after)}）`);
      } else {
        log('[=] 启动前无需清理');
      }
    } catch (error) {
      if (error.code === 'LOCKED') warn('[!] cookie 库被占用，跳过清理，直接启动');
      else throw error;
    }
  }
  if (!fs.existsSync(APP_EXE)) {
    warn(`[x] 找不到 DeepSeek Harness.exe: ${APP_EXE}`);
    warn('    可用环境变量 DSH_DESKTOP_EXE 指定完整路径。');
    return 1;
  }
  const child = spawn(APP_EXE, [], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  log(`[ok] 已启动: ${APP_EXE}`);
  return 0;
}

// ---- 入口 ----
const keep = valueOf('--keep', 0);

let code = 0;
try {
  if (has('--launch')) code = cmdLaunch(keep);
  else if (has('--clean-if-idle')) code = cmdCleanIfIdle(keep);
  else if (has('--clean')) code = cmdClean(keep);
  else if (has('--check')) code = cmdCheck();
  else {
    console.log('dsh-cookie-guard —— 预防 DSH 桌面端启动报「Web authentication failed」');
    console.log('');
    console.log('  --check             只读体检');
    console.log('  --clean             直接清理（需先完全退出 DSH）');
    console.log('  --clean-if-idle     DSH 未运行时才清理（供计划任务调用）');
    console.log('  --launch            清理后启动 DSH（供启动器调用）');
    console.log('  --keep <n>          保留最新 n 条（默认 0 = 全清）');
    console.log('  --db <path>         指定 cookie 库（自检用，可指向备份）');
    console.log('  --quiet             静默模式');
    code = 0;
  }
} catch (error) {
  warn(`[x] 执行失败: ${error?.message ?? error}`);
  code = 1;
}
process.exit(code);
