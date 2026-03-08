/**
 * Shared CLI formatting utilities.
 * ANSI color helpers, box-drawing constructors, and NO_COLOR support.
 */

// Box-drawing characters
export const BOX = {
  topLeft: "\u250C",
  topRight: "\u2510",
  bottomLeft: "\u2514",
  bottomRight: "\u2518",
  vertical: "\u2502",
  horizontal: "\u2500",
} as const;

// ANSI 24-bit color codes (matching strata-web terminal animation palette)
const CODES = {
  bronzePrimary: "\x1b[38;2;176;124;79m",   // #b07c4f
  bronzeBright: "\x1b[38;2;224;180;140m",    // #e0b48c
  bronzeMuted: "\x1b[38;2;122;85;58m",       // #7a553a
  success: "\x1b[38;2;67;179;174m",          // #43b3ae
  active: "\x1b[38;2;255;183;77m",           // #ffb74d
  text: "\x1b[38;2;231;233;234m",            // #e7e9ea
  muted: "\x1b[38;2;110;118;129m",           // #6e7681
  reset: "\x1b[0m",
} as const;

/** Whether color output is disabled. Call initColor() first. */
let noColor = false;

/**
 * Initialize color state from flags and environment.
 * Must be called once at CLI startup before any formatting.
 */
export function initColor(flags: Record<string, string | boolean>): void {
  noColor = Boolean(flags["no-color"]) || process.env.NO_COLOR !== undefined;
}

/** Wrap text with an ANSI color code. Respects NO_COLOR. */
function c(text: string, code: string): string {
  if (noColor) return text;
  return `${code}${text}${CODES.reset}`;
}

// Semantic color functions
export const bronze = (t: string) => c(t, CODES.bronzePrimary);
export const bright = (t: string) => c(t, CODES.bronzeBright);
export const muted = (t: string) => c(t, CODES.bronzeMuted);
export const success = (t: string) => c(t, CODES.success);
export const active = (t: string) => c(t, CODES.active);
export const text = (t: string) => c(t, CODES.text);
export const dim = (t: string) => c(t, CODES.muted);

/** Terminal width, with a sensible fallback. */
export function termWidth(): number {
  return process.stdout.columns || 80;
}

/** Wrap text into lines of maxLen characters, breaking at word boundaries where possible. */
export function wordWrap(str: string, maxLen: number): string[] {
  if (str.length <= maxLen) return [str];
  const lines: string[] = [];
  let remaining = str;
  while (remaining.length > maxLen) {
    let breakAt = remaining.lastIndexOf(" ", maxLen);
    if (breakAt <= 0) breakAt = maxLen; // no space found, hard break
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining.length > 0) lines.push(remaining);
  return lines;
}

/** Create a horizontal rule of given length. */
export function rule(length: number): string {
  return BOX.horizontal.repeat(length);
}

/** Top border: ┌─ title ────────────┐ (totalWidth wide) */
export function topBorder(title: string, totalWidth: number): string {
  const inner = `${BOX.horizontal} ${title} `;
  // -2 for topLeft and topRight
  const remaining = Math.max(0, totalWidth - inner.length - 2);
  return `${muted(BOX.topLeft)}${muted(inner)}${muted(rule(remaining))}${muted(BOX.topRight)}`;
}

/** Bottom border: └────────────────────┘ (totalWidth wide) */
export function bottomBorder(totalWidth: number): string {
  // -2 for bottomLeft and bottomRight
  return muted(`${BOX.bottomLeft}${rule(totalWidth - 2)}${BOX.bottomRight}`);
}

/** Vertical bar with content padded to fill box: │   text           │ */
export function boxLine(content: string, contentWidth: number): string {
  // 3 chars padding on each side to match left/right symmetry
  const visibleLen = content.replace(/\x1b\[[0-9;]*m/g, "").length;
  const pad = Math.max(0, contentWidth - visibleLen);
  return `${muted(BOX.vertical)}   ${content}${" ".repeat(pad)}   ${muted(BOX.vertical)}`;
}
