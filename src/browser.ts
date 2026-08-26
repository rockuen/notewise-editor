import { exec, execFile } from 'node:child_process';
import * as vscode from 'vscode';

export type HtmlOpenTarget = 'browser' | 'editor';

const HTML_EXTENSION = /\.(html?|xhtml)$/i;

/**
 * Link hrefs carry a `?query` / `#fragment` the extension test has to look past,
 * while a plain fs path may legitimately contain `#` in a folder name, so try the
 * raw value before stripping.
 */
export function isHtmlPath(value: string): boolean {
  if (HTML_EXTENSION.test(value)) return true;
  const pathPart = value.split(/[?#]/, 1)[0] ?? value;
  return HTML_EXTENSION.test(pathPart);
}

export function getHtmlOpenTarget(): HtmlOpenTarget {
  const configured = vscode.workspace.getConfiguration('noteWise').get<string>('openHtmlIn', 'browser');
  return configured === 'editor' ? 'editor' : 'browser';
}

/**
 * `vscode.open` always lands in an editor tab, so local HTML has to leave the
 * workbench and reach the OS default application - the browser on a normal
 * desktop.
 *
 * `env.openExternal` cannot do that for local files on Windows: it forwards the
 * serialized URI to ShellExecute, and the percent-encoded drive colon in
 * `file:///c%3A/...` makes it fail with 0x2 (file not found) behind VS Code's own
 * "An error occurred opening an external program" dialog. So `file:` URIs go
 * through the platform shell instead, which is what the calendar view has always
 * used for its external extensions.
 */
export async function openInDefaultBrowser(uri: vscode.Uri): Promise<void> {
  if (uri.scheme !== 'file') {
    const opened = await vscode.env.openExternal(uri);
    if (!opened) throw new Error(`External target could not be opened: ${uri.toString(true)}`);
    return;
  }

  // A plain path is the most reliable thing to hand the shell, but it cannot
  // carry an anchor, so only build a URL when there is something to preserve.
  if (uri.fragment || uri.query) {
    try {
      await openWithOsShell(toFileUrl(uri));
      return;
    } catch {
      // Losing the anchor beats not opening the page at all.
    }
  }

  await openWithOsShell(uri.fsPath);
}

/** Keeps the drive letter's colon intact - that is the byte ShellExecute chokes on. */
function toFileUrl(uri: vscode.Uri): string {
  // `Uri.path` is already slash-separated ("/c:/notes/report.html").
  const encodedPath = uri.path
    .split('/')
    .map((segment) => (/^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/')
    .replace(/^\/+/, '');

  const query = uri.query ? `?${uri.query}` : '';
  const fragment = uri.fragment ? `#${uri.fragment}` : '';
  return `file:///${encodedPath}${query}${fragment}`;
}

function openWithOsShell(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null) => (error ? reject(error) : resolve());

    if (process.platform === 'win32') {
      // PowerShell escapes a single quote inside a quoted string by doubling it.
      const escaped = target.replace(/'/g, "''");
      exec(`powershell -NoProfile -Command "Start-Process -FilePath '${escaped}'"`, done);
      return;
    }

    // No shell, so the path needs no quoting at all.
    execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], done);
  });
}

export async function openInDefaultEditor(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, 'default', {
    viewColumn: vscode.ViewColumn.Active,
    preview: false,
  });
}
