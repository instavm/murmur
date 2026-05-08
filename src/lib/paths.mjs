import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const MURMUR_HOME = process.env.MURMUR_HOME || join(homedir(), ".murmur");
export const DB_PATH = process.env.MURMUR_DB || join(MURMUR_HOME, "db.sqlite");
export const AUDIT_PATH = process.env.MURMUR_AUDIT || join(MURMUR_HOME, "audit.jsonl");
export const PID_FILE = join(MURMUR_HOME, "murmurd.pid");
export const PORT_FILE = join(MURMUR_HOME, "murmurd.port");
export const LOG_FILE = join(MURMUR_HOME, "murmurd.log");
export const DEFAULT_PORT = parseInt(process.env.MURMUR_PORT || "9999", 10);

export function ensureMurmurHome() {
  mkdirSync(MURMUR_HOME, { recursive: true });
}
