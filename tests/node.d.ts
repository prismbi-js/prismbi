// Minimal Node types (no @types/node installed); used by the SQL pushdown tests.
declare module 'node:child_process' {
  export function execFileSync(file: string, args?: string[], options?: { input?: string; stdio?: string; maxBuffer?: number }): { toString(): string };
}
declare module 'node:fs' {
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}
declare module 'node:os' {
  export function tmpdir(): string;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
}
declare const process: { execPath: string };
