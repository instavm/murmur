import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function readJson(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

export function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

export function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function setNested(obj, keyPath, value) {
  const keys = keyPath.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== "object" || cur[keys[i]] === null) {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  const last = keys[keys.length - 1];
  const before = cur[last];
  cur[last] = value;
  return !deepEqual(before, value);
}

export function deleteNested(obj, keyPath) {
  const keys = keyPath.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== "object" || cur[keys[i]] === null) return false;
    cur = cur[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (last in cur) {
    delete cur[last];
    return true;
  }
  return false;
}
