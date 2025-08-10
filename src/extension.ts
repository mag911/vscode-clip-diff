/* ============================================================================
 * clip-diff — VSCode extension (single-file)
 * STATUS: PROD READY v1.0.0
 * ----------------------------------------------------------------------------
 * Features
 * - Reads unified diff (supports ```diff fences, @@ hunks, ---/+++ headers)
 * - Dry-run patch application with clear error messages
 * - Fuzzy yet safe matching: verifies '-' lines before removal
 * - Preserves document EOLs (LF/CRLF)
 * - Warns if diff target path header doesn't match active file
 * - Single undo step via one WorkspaceEdit
 * No external dependencies.
 * ========================================================================== */

import * as vscode from "vscode";

/** Command ID (contributes.commands in package.json should match this) */
const CMD_APPLY_FROM_CLIPBOARD = "clip-diff.applyDiffPatchFromClipboard";

/** Activate */
export function activate(context: vscode.ExtensionContext) {
  console.log('[clip-diff] Activated');

  const disposable = vscode.commands.registerCommand(
    CMD_APPLY_FROM_CLIPBOARD,
    async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showInformationMessage("No active editor found.");
          return;
        }

        const rawClipboard = await vscode.env.clipboard.readText();
        const stripped = stripCodeFence(rawClipboard);
        if (!isLikelyUnifiedDiff(stripped)) {
          vscode.window.showInformationMessage("The clipboard does not contain a valid unified diff.");
          return;
        }

        // Optional path header check
        const headerPath = getDiffTargetPath(stripped);
        if (headerPath) {
          const fsPath = editor.document.uri.fsPath.replace(/\\/g, "/");
          const matches = fsPath.endsWith(headerPath.replace(/^a\//, "").replace(/^b\//, ""));
          if (!matches) {
            const choice = await vscode.window.showWarningMessage(
              `Diff targets "${headerPath}" but the active file is "${fsPath}". Apply anyway?`,
              { modal: true },
              "Apply", "Cancel"
            );
            if (choice !== "Apply") return;
          }
        }

        const doc = editor.document;
        const original = doc.getText();
        const eol = doc.eol;

        // Dry run in memory
        const patched = applyDiffPatch(original, stripped, eol);

        if (patched === original) {
          vscode.window.showInformationMessage("No changes applied (already up to date).");
          return;
        }

        // Apply as one edit for single undo
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(original.length)
        );
        edit.replace(doc.uri, fullRange, patched);
        const ok = await vscode.workspace.applyEdit(edit);
        if (ok) {
          vscode.window.showInformationMessage("Diff patch applied successfully from the clipboard.");
        } else {
          vscode.window.showErrorMessage("Failed to apply edit.");
        }
      } catch (err: any) {
        const msg = (err && err.message) ? err.message : String(err);
        console.error("[clip-diff] Error:", err);
        vscode.window.showErrorMessage(`Failed to apply diff patch from the clipboard: ${msg}`);
      }
    }
  );

  context.subscriptions.push(disposable);
}

/** Deactivate */
export function deactivate() {}

/* ========================================================================== */
/* Diff helpers                                                               */
/* ========================================================================== */

function stripCodeFence(s: string): string {
  if (!s) return s;
  // Handles ```diff ... ``` or ``` ... ```
  const fence = s.match(/^```(?:diff)?\s*([\s\S]*?)\s*```$/m);
  return normalizeEOL((fence ? fence[1] : s).trim());
}

function isLikelyUnifiedDiff(s: string): boolean {
  if (!s) return false;
  // Either unified hunks or file headers present
  return /^@@\s-/.test(s) || /^---\s.+\n\+\+\+\s.+/m.test(s);
}

/** Try to extract the target path from ---/+++ headers. Returns basename-ish path or undefined. */
function getDiffTargetPath(s: string): string | undefined {
  const m = s.match(/^---\s+(.+)\n\+\+\+\s+(.+)$/m);
  if (!m) return undefined;
  // Prefer +++ (new file path)
  const path = m[2].trim();
  // Strip prefixes and surrounding quotes
  return stripHeaderPath(path);
}

function stripHeaderPath(p: string): string {
  // Unified diffs often prefix with a/ and b/
  let t = p.replace(/^["']|["']$/g, "");
  t = t.replace(/^[ab]\//, "");
  // Some tools include timestamps: path\tYYYY...
  t = t.split(/\t/)[0].split(/\s{2,}/)[0];
  return t;
}

function normalizeEOL(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

function restoreEOL(s: string, eol: vscode.EndOfLine): string {
  if (eol === vscode.EndOfLine.CRLF) return s.replace(/\n/g, "\r\n");
  return s;
}

/* ========================================================================== */
/* Patch engine (unified diff, hunk-by-hunk)                                  */
/* ========================================================================== */

type Hunk = {
  header: string;
  body: string[];
  oldStart: number;
  oldCount: number | undefined;
  newStart: number;
  newCount: number | undefined;
};

function parseHunks(diffText: string): Hunk[] {
  const parts = diffText.split(/^@@/gm).slice(1).map(h => `@@${h}`);
  const hunks: Hunk[] = [];

  for (const raw of parts) {
    const lines = raw.split("\n");
    const header = lines[0] ?? "";
    const m = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) {
      throw new Error(`Invalid hunk header: ${header}`);
    }
    hunks.push({
      header,
      body: lines.slice(1),
      oldStart: Number(m[1]),
      oldCount: m[2] ? Number(m[2]) : undefined,
      newStart: Number(m[3]),
      newCount: m[4] ? Number(m[4]) : undefined,
    });
  }
  return hunks;
}

function applyDiffPatch(documentContent: string, rawDiff: string, eol: vscode.EndOfLine): string {
  const docLF = normalizeEOL(documentContent);
  const diff = normalizeEOL(rawDiff);

  const hunks = parseHunks(diff);
  if (hunks.length === 0) return restoreEOL(docLF, eol);

  let content = docLF;
  let lastAppliedLine = 0;

  for (const hunk of hunks) {
    const res = applySingleHunk(content, hunk, lastAppliedLine);
    if (!res) {
      const header = hunk.header;
      throw new Error(`Could not apply hunk:\n${header}`);
    }
    content = res.content;
    lastAppliedLine = res.lastAppliedLine;
  }

  return restoreEOL(content, eol);
}

function applySingleHunk(
  content: string,
  hunk: Hunk,
  startLine: number
): { content: string; lastAppliedLine: number } | null {
  const contentLines = content.split("\n");

  // Build the "old" block sequence (context + minus lines) and "new" block (context + plus lines)
  const oldBlock: string[] = [];
  const newBlock: string[] = [];

  for (const line of hunk.body) {
    if (line.length === 0) continue; // skip empty line artifacts between hunks
    const tag = line[0];
    const val = line.slice(1);
    if (tag === " " || tag === "-") oldBlock.push(val);
    if (tag === " " || tag === "+") newBlock.push(val);
  }

  // Sliding window: find best match from startLine onward using full-old-block scoring
  let bestIdx = -1;
  let bestScore = -1;

  for (let i = startLine; i <= contentLines.length; i++) {
    const window = contentLines.slice(i, i + oldBlock.length);
    const score = scoreSequence(window, oldBlock);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
      if (score === oldBlock.length) break; // perfect match
    }
  }
  if (bestIdx < 0) return null;

  // Safety: verify that every '-' line matches at the correct relative position before removal
  if (!verifyRemovals(contentLines, bestIdx, hunk.body)) {
    return null;
  }

  // Apply replacement
  const before = contentLines.slice(0, bestIdx);
  const after = contentLines.slice(bestIdx + oldBlock.length);
  const merged = [...before, ...newBlock, ...after].join("\n");
  const lastAppliedLine = bestIdx + newBlock.length;

  return { content: merged, lastAppliedLine };
}

function scoreSequence(window: string[], target: string[]): number {
  const n = Math.min(window.length, target.length);
  let score = 0;
  for (let i = 0; i < n; i++) {
    if (window[i] === target[i]) score++;
  }
  return score;
}

function verifyRemovals(contentLines: string[], startIdx: number, body: string[]): boolean {
  let idx = startIdx;
  for (const line of body) {
    if (line.length === 0) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === " " || tag === "-") {
      if (contentLines[idx] !== val) return false;
      idx++;
    }
    // '+' does not advance idx on the old content
  }
  return true;
}
