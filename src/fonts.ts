import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as vscode from 'vscode';

const COMMON_FONTS = [
  'Segoe UI',
  'Segoe UI Variable',
  'Arial',
  'Calibri',
  'Aptos',
  'Malgun Gothic',
  'Apple SD Gothic Neo',
  'SF Pro Text',
  'Helvetica Neue',
  'Inter',
  'Noto Sans',
  'Noto Sans KR',
  'Pretendard',
  'Pretendard Variable',
  'Roboto',
  'Ubuntu',
];

export function defaultUiFontFamily(): string {
  if (process.platform === 'win32') {
    return '"Pretendard Variable", "Pretendard", "Inter", "Segoe UI Variable", "Segoe UI", "Malgun Gothic", sans-serif';
  }
  if (process.platform === 'darwin') {
    return '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Pretendard Variable", "Pretendard", "Apple SD Gothic Neo", sans-serif';
  }
  return '"Inter", "Pretendard", "Noto Sans", "Noto Sans KR", "Ubuntu", sans-serif';
}

export async function selectEditorFont() {
  const installedFonts = await getInstalledFontFamilies();
  const current = vscode.workspace.getConfiguration('noteWise.editor').get<string>('ui.fontFamily', '');
  const items: vscode.QuickPickItem[] = [
    {
      label: 'Use OS Default',
      description: defaultUiFontFamily(),
      detail: 'Clears noteWise.editor.ui.fontFamily',
    },
    ...installedFonts.map((font) => ({
      label: font,
      description: current === font ? 'Current' : undefined,
    })),
  ];

  const selected = await vscode.window.showQuickPick(items, {
    title: 'NoteWise Editor: Select editor font',
    placeHolder: 'Choose a font installed on this machine',
    matchOnDescription: true,
  });
  if (!selected) return;

  const config = vscode.workspace.getConfiguration('noteWise.editor');
  const value = selected.label === 'Use OS Default' ? undefined : selected.label;
  await config.update('ui.fontFamily', value, vscode.ConfigurationTarget.Global);
}

export async function getInstalledFontFamilies(): Promise<string[]> {
  const fonts = new Set<string>(COMMON_FONTS);
  const platformFonts = await platformFontFamilies();
  for (const font of platformFonts) {
    const normalized = normalizeFontName(font);
    if (normalized) fonts.add(normalized);
  }
  return [...fonts].sort((a, b) => a.localeCompare(b));
}

async function platformFontFamilies(): Promise<string[]> {
  if (process.platform === 'win32') return windowsFontFamilies();
  if (process.platform === 'darwin') return macFontFamilies();
  return linuxFontFamilies();
}

async function windowsFontFamilies(): Promise<string[]> {
  const roots = [
    ['HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'],
    ['HKLM\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'],
  ];
  const outputs = await Promise.all(roots.map((args) => execFileText('reg.exe', ['query', ...args]).catch(() => '')));
  const names: string[] = [];

  for (const output of outputs) {
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^\s*(.+?)\s+REG_\w+\s+.+$/);
      if (!match) continue;
      names.push(match[1].replace(/\s*\((?:TrueType|OpenType|Type 1)\)\s*$/i, '').trim());
    }
  }
  return names;
}

async function macFontFamilies(): Promise<string[]> {
  const output = await execFileText('system_profiler', ['SPFontsDataType', '-json']).catch(() => '');
  if (!output) return [];
  try {
    const parsed = JSON.parse(output) as { SPFontsDataType?: Array<{ family?: string; _name?: string }> };
    return (parsed.SPFontsDataType ?? []).flatMap((font) => [font.family, font._name]).filter((font): font is string => Boolean(font));
  } catch {
    return [];
  }
}

async function linuxFontFamilies(): Promise<string[]> {
  const output = await execFileText('fc-list', [':', 'family']).catch(() => '');
  return output
    .split(/\r?\n/)
    .flatMap((line) => line.split(','))
    .map((font) => font.trim());
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function normalizeFontName(name: string): string | undefined {
  const cleaned = name
    .replace(/\s+/g, ' ')
    .replace(/\s+(?:Regular|Normal|Bold|Italic|Light|Medium|SemiBold|Black|Thin)$/i, '')
    .trim();
  if (!cleaned || cleaned.length < 2) return undefined;
  if (cleaned.includes('&')) return undefined;
  if (os.platform() === 'win32' && /\.(ttf|otf|ttc|fon)$/i.test(cleaned)) return undefined;
  return cleaned;
}
