import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { defaultUiFontFamily } from './fonts';
import type { ClientMessage, ColorRole, DocumentInfo, EditorPalette, EditorSettings, HostMessage, StageColors, StageIndentation, ThemeMode, SyntaxVisibility, WikiLinkCandidate } from './messages';

export const VIEW_TYPE = 'notewise.editor';

// Refined-accent palette: headings descend through a single warm family
// (coral -> sunset orange -> amber -> sand). Lists keep a quiet neutral marker
// and blockquotes only tint their left border, so body text stays calm.
const DEFAULT_HEADING_COLORS = ['#ff6f61', '#ff855c', '#fb9a55', '#eaad5e', '#d3b176', '#c2b596'];
const DEFAULT_LIST_COLORS = ['#9b968f', '#9b968f', '#9b968f', '#9b968f', '#9b968f', '#9b968f'];
const DEFAULT_QUOTE_COLORS = ['#ff6f61', '#ef8467', '#dd966f', '#cba47e', '#bcab8f', '#b1ac9c'];

const BLACK_HEADING_COLORS = ['#ff6f61', '#ff855c', '#fb9a55', '#eaad5e', '#d3b176', '#c2b596'];
const BLACK_LIST_COLORS = ['#9b968f', '#9b968f', '#9b968f', '#9b968f', '#9b968f', '#9b968f'];
const BLACK_QUOTE_COLORS = ['#ff6f61', '#ef8467', '#dd966f', '#cba47e', '#bcab8f', '#b1ac9c'];
const WHITE_HEADING_COLORS = ['#c0392b', '#c2592c', '#b57328', '#9c7d2b', '#86763c', '#736850'];
const WHITE_LIST_COLORS = ['#a39888', '#a39888', '#a39888', '#a39888', '#a39888', '#a39888'];
const WHITE_QUOTE_COLORS = ['#c0392b', '#bd552f', '#b06f33', '#9e7d44', '#8d7d55', '#7e7460'];

export class MarkdownStageLiveProvider implements vscode.CustomTextEditorProvider {
  private readonly panels = new Set<vscode.WebviewPanel>();
  private readonly updateTimers = new Map<vscode.WebviewPanel, ReturnType<typeof setTimeout>>();
  private editTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingEdit: string | undefined;
  private applyingEdit = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          !event.affectsConfiguration('editor') &&
          !event.affectsConfiguration('noteWise.editor') &&
          !event.affectsConfiguration('breadcrumbs')
        )
          return;
        this.broadcastSettings();
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.broadcastSettings();
      })
    );
  }

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.panels.add(webviewPanel);
    this.notifyCalendarActiveFile(document, webviewPanel);

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.file(path.dirname(document.uri.fsPath)),
        ...(vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ?? []),
      ],
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    const documentSub = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== document.uri.toString()) return;
      if (this.applyingEdit) return;

      const existingTimer = this.updateTimers.get(webviewPanel);
      if (existingTimer) clearTimeout(existingTimer);

      this.updateTimers.set(
        webviewPanel,
        setTimeout(() => {
          this.post(webviewPanel, { type: 'update', content: document.getText() });
        }, 80)
      );
    });

    const messageSub = webviewPanel.webview.onDidReceiveMessage((message: ClientMessage) => {
      switch (message.type) {
        case 'ready':
          void this.initializePanel(document, webviewPanel);
          break;
        case 'edit':
          this.applyFullDocumentEdit(document, message.content);
          break;
        case 'focus':
        case 'blur':
          break;
        case 'selectFont':
          vscode.commands.executeCommand('noteWise.editor.selectFont');
          break;
        case 'pasteImage':
          this.savePastedImage(document, webviewPanel, message);
          break;
        case 'save':
          this.applyFullDocumentEdit(document, message.content);
          document.save();
          break;
        case 'info':
          vscode.window.showInformationMessage(message.content);
          break;
        case 'error':
          vscode.window.showErrorMessage(message.content);
          break;
        case 'openLink':
          void this.openLink(document, message.href).catch((error) => {
            vscode.window.showErrorMessage(`NoteWise link open failed: ${String(error)}`);
          });
          break;
        case 'openWikiLink':
          void this.openWikiLink(document, message.target).catch((error) => {
            vscode.window.showErrorMessage(`NoteWise wiki link open failed: ${String(error)}`);
          });
          break;
        case 'updateSetting':
          this.updateSetting(message.key, message.value);
          break;
        case 'updateColor':
          this.updateColor(message.role, message.value, message.index);
          break;
        case 'resetColors':
          this.resetColors();
          break;
      }
    });

    const viewStateSub = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        this.notifyCalendarActiveFile(document, webviewPanel);
      }
    });

    webviewPanel.onDidDispose(() => {
      documentSub.dispose();
      messageSub.dispose();
      viewStateSub.dispose();
      this.panels.delete(webviewPanel);
      const timer = this.updateTimers.get(webviewPanel);
      if (timer) clearTimeout(timer);
      this.updateTimers.delete(webviewPanel);
    });
  }

  private notifyCalendarActiveFile(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel) {
    if (!webviewPanel.active) return;
    if (document.uri.scheme !== 'file') return;
    vscode.commands.executeCommand('noteWise.calendar.setActiveFile', document.uri.fsPath);
  }

  private async initializePanel(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel) {
    this.notifyCalendarActiveFile(document, webviewPanel);
    this.post(webviewPanel, {
      type: 'init',
      content: document.getText(),
      settings: this.getEditorSettings(),
      document: await this.getDocumentInfo(document, webviewPanel.webview),
    });
  }

  private applyFullDocumentEdit(document: vscode.TextDocument, content: string) {
    if (content === document.getText()) return;
    this.pendingEdit = content;

    if (this.editTimer) clearTimeout(this.editTimer);
    this.editTimer = setTimeout(async () => {
      const nextContent = this.pendingEdit;
      this.pendingEdit = undefined;
      if (nextContent === undefined || nextContent === document.getText()) return;

      const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, fullRange, nextContent);

      this.applyingEdit = true;
      try {
        await vscode.workspace.applyEdit(edit);
      } finally {
        this.applyingEdit = false;
      }
    }, 80);
  }

  private broadcastSettings() {
    const settings = this.getEditorSettings();
    for (const panel of this.panels) {
      this.post(panel, { type: 'settings', settings });
    }
  }

  private post(panel: vscode.WebviewPanel, message: HostMessage) {
    panel.webview.postMessage(message);
  }

  private async updateSetting(key: string, value: string | number | boolean) {
    if (key === 'breadcrumbs.enabled') {
      await vscode.workspace
        .getConfiguration('breadcrumbs')
        .update('enabled', Boolean(value), vscode.ConfigurationTarget.Global);
      this.broadcastSettings();
      return;
    }

    const allowedKeys = new Set([
      'theme.mode',
      'livePreview.syntaxVisibility',
      'ui.contentScale',
      'ui.typographyScale',
      'indentation.headingStep',
      'indentation.listStep',
      'indentation.blockquoteStep',
    ]);
    if (!allowedKeys.has(key)) return;

    const config = vscode.workspace.getConfiguration('noteWise.editor');
    await config.update(key, value, vscode.ConfigurationTarget.Global);
    this.broadcastSettings();
  }

  private async updateColor(role: ColorRole, value: string, index?: number) {
    const color = normalizeHexColor(value);
    if (!color) return;

    const mode = this.getThemeMode();
    const config = vscode.workspace.getConfiguration('noteWise.editor');

    if (role === 'foreground' || role === 'mutedForeground') {
      await config.update(`theme.${mode}.${role}`, color, vscode.ConfigurationTarget.Global);
      this.broadcastSettings();
      return;
    }

    if (typeof index !== 'number' || index < 0 || index > 5) return;
    const arrayKey = role === 'heading' ? 'headings' : role === 'list' ? 'lists' : 'blockquotes';

    // Start from the currently effective colors so a single edit only changes one stage.
    const current = this.getStageColors()[arrayKey];
    const next = [...current];
    while (next.length < 6) next.push(next[next.length - 1] ?? color);
    next[index] = color;

    await config.update(`theme.${mode}.${arrayKey}`, next, vscode.ConfigurationTarget.Global);
    // Keep the legacy override in sync when the user has configured it, otherwise it would mask theme colors.
    if (hasConfiguredValue(config.inspect(`stageColors.${arrayKey}`))) {
      await config.update(`stageColors.${arrayKey}`, next, vscode.ConfigurationTarget.Global);
    }
    this.broadcastSettings();
  }

  private async resetColors() {
    const mode = this.getThemeMode();
    const config = vscode.workspace.getConfiguration('noteWise.editor');
    const keys = [
      `theme.${mode}.foreground`,
      `theme.${mode}.mutedForeground`,
      `theme.${mode}.headings`,
      `theme.${mode}.lists`,
      `theme.${mode}.blockquotes`,
      'stageColors.headings',
      'stageColors.lists',
      'stageColors.blockquotes',
    ];
    for (const key of keys) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
    this.broadcastSettings();
  }

  private getEditorSettings(): EditorSettings {
    const editor = vscode.workspace.getConfiguration('editor');
    const config = vscode.workspace.getConfiguration('noteWise.editor');
    const fontSize = clampNumber(editor.get<number>('fontSize', 14), 8, 48, 14);
    const rawLineHeight = editor.get<number>('lineHeight', 0);

    let lineHeight = 1.6;
    if (rawLineHeight > 0 && rawLineHeight < 4) {
      lineHeight = rawLineHeight;
    } else if (rawLineHeight >= 4) {
      lineHeight = rawLineHeight / Math.max(fontSize, 12);
    }

    return {
      fontFamily: this.getFontFamily(),
      fontSize,
      lineHeight: clampNumber(lineHeight, 1.2, 2.4, 1.6),
      tabSize: clampNumber(editor.get<number>('tabSize', 4), 1, 8, 4),
      contentScale: clampNumber(config.get<number>('ui.contentScale', 0.88), 0.7, 1.0, 0.88),
      typographyScale: clampNumber(config.get<number>('ui.typographyScale', 1), 0.85, 1.35, 1),
      syntaxVisibility: normalizeSyntaxVisibility(config.get<SyntaxVisibility>('livePreview.syntaxVisibility', 'auto')),
      themeMode: normalizeThemeMode(config.get<ThemeMode>('theme.mode', 'auto')),
      breadcrumbsEnabled: vscode.workspace.getConfiguration('breadcrumbs').get<boolean>('enabled', true),
      customCss: config.get<string>('customCss', ''),
      stageColors: this.getStageColors(),
      palette: this.getPalette(),
      indentation: {
        headingStep: clampNumber(config.get<number>('indentation.headingStep', 0), 0, 80, 0),
        listStep: clampNumber(config.get<number>('indentation.listStep', 18), 0, 80, 18),
        blockquoteStep: clampNumber(config.get<number>('indentation.blockquoteStep', 14), 0, 80, 14),
      } satisfies StageIndentation,
    };
  }

  private async getDocumentInfo(document: vscode.TextDocument, webview: vscode.Webview): Promise<DocumentInfo> {
    const fsPath = document.uri.fsPath;
    const name = path.basename(fsPath).replace(/\.(md|markdown)$/i, '');
    const folder = path.basename(path.dirname(fsPath));
    const resourceBaseUri = document.uri.scheme === 'file'
      ? `${webview.asWebviewUri(vscode.Uri.file(path.dirname(fsPath))).toString()}/`
      : null;
    const vditorCdnUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'vditor')).toString();
    const wikiLinks = await this.getWikiLinkCandidates(document);
    return { folder: folder || null, name, resourceBaseUri, vditorCdnUri, wikiLinks };
  }

  private async getWikiLinkCandidates(document: vscode.TextDocument): Promise<WikiLinkCandidate[]> {
    const files = await this.findMarkdownFiles();
    const currentPath = document.uri.scheme === 'file' ? normalizeFsPath(document.uri.fsPath) : '';
    const rawItems = files
      .filter((uri) => normalizeFsPath(uri.fsPath) !== currentPath)
      .map((uri) => {
        const label = stripMarkdownExtension(path.basename(uri.fsPath));
        const detail = this.getWorkspaceRelativeMarkdownTarget(uri);
        return { uri, label, detail };
      });

    const labelCounts = new Map<string, number>();
    for (const item of rawItems) {
      const key = item.label.toLocaleLowerCase();
      labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
    }

    return rawItems
      .map((item) => ({
        label: item.label,
        target: (labelCounts.get(item.label.toLocaleLowerCase()) ?? 0) > 1 ? item.detail : item.label,
        detail: item.detail,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ko'));
  }

  private getWorkspaceRelativeMarkdownTarget(uri: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const relativePath = folder ? path.relative(folder.uri.fsPath, uri.fsPath) : path.basename(uri.fsPath);
    return toMarkdownPath(stripMarkdownExtension(relativePath));
  }

  private async findMarkdownFiles(): Promise<vscode.Uri[]> {
    if (!vscode.workspace.workspaceFolders?.length) return [];
    return vscode.workspace.findFiles('**/*.{md,markdown}', '**/{node_modules,.git,.obsidian}/**', 10000);
  }

  private async savePastedImage(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    message: Extract<ClientMessage, { type: 'pasteImage' }>
  ) {
    if (document.uri.scheme !== 'file') return;

    const match = /^data:([^;]+);base64,(.+)$/.exec(message.dataUrl);
    if (!match) return;

    const configuredFolder = vscode.workspace
      .getConfiguration('noteWise.editor')
      .get<string>('imageSaveFolder', 'assets')
      .trim() || 'assets';
    const documentDir = path.dirname(document.uri.fsPath);
    const targetDir = configuredFolder.includes('${projectRoot}')
      ? configuredFolder.replace('${projectRoot}', vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? documentDir)
      : path.resolve(documentDir, configuredFolder);
    await fs.mkdir(targetDir, { recursive: true });

    const extension = imageExtension(message.mimeType || match[1]);
    const stem = sanitizeFileName(path.parse(message.name ?? '').name) || 'image';
    const fileName = `${stem}-${timestampForFile()}.${extension}`;
    const targetPath = path.join(targetDir, fileName);
    await fs.writeFile(targetPath, Buffer.from(match[2], 'base64'));

    const relativePath = toMarkdownPath(path.relative(documentDir, targetPath));
    const alt = stem === 'image' ? 'image' : stem;
    this.post(panel, { type: 'insertText', text: `![${alt}](${relativePath})` });
  }

  private async openLink(document: vscode.TextDocument, href: string) {
    const target = resolveMarkdownLinkUri(document, href);
    if (!target) return;

    if (isExternalLinkUri(target)) {
      const opened = await vscode.env.openExternal(target);
      if (!opened) throw new Error(`External link could not be opened: ${target.toString(true)}`);
      return;
    }

    if (target.scheme === 'file' && isMarkdownPath(target.fsPath)) {
      await this.openMarkdownDocument(target);
      return;
    }

    await vscode.commands.executeCommand('vscode.open', target);
  }

  private async openWikiLink(document: vscode.TextDocument, rawTarget: string) {
    const target = parseWikiLinkTarget(rawTarget);
    if (!target) return;

    const existing = await this.resolveWikiLinkTarget(document, target);
    if (existing) {
      await this.openMarkdownDocument(existing);
      return;
    }

    const action = await vscode.window.showWarningMessage(`NoteWise document not found: ${target}`, 'Create');
    if (action !== 'Create') return;

    const uri = this.getNewWikiLinkUri(document, target);
    await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
    if (!(await fileExists(uri.fsPath))) {
      await fs.writeFile(uri.fsPath, `# ${path.basename(stripMarkdownExtension(uri.fsPath))}\n`, 'utf8');
    }
    await this.openMarkdownDocument(uri);
  }

  private async resolveWikiLinkTarget(document: vscode.TextDocument, target: string): Promise<vscode.Uri | undefined> {
    const normalized = normalizeWikiPath(target);
    const candidates = markdownPathCandidates(normalized);
    const documentDir = document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined;
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

    if (isPathLikeWikiTarget(normalized)) {
      const roots = [
        ...(documentDir ? [documentDir] : []),
        ...workspaceFolders.map((folder) => folder.uri.fsPath),
      ];
      for (const root of roots) {
        for (const candidate of candidates) {
          const fsPath = path.resolve(root, candidate);
          if (await fileExists(fsPath)) return vscode.Uri.file(fsPath);
        }
      }
      return undefined;
    }

    const files = await this.findMarkdownFiles();
    const targetLower = normalized.toLocaleLowerCase();
    const matches = files.filter((uri) => stripMarkdownExtension(path.basename(uri.fsPath)).toLocaleLowerCase() === targetLower);
    if (matches.length === 0) return undefined;

    const sameDir = documentDir
      ? matches.find((uri) => normalizeFsPath(path.dirname(uri.fsPath)) === normalizeFsPath(documentDir))
      : undefined;
    if (sameDir) return sameDir;

    const exactCase = matches.find((uri) => stripMarkdownExtension(path.basename(uri.fsPath)) === normalized);
    return exactCase ?? matches[0];
  }

  private getNewWikiLinkUri(document: vscode.TextDocument, target: string): vscode.Uri {
    const normalized = normalizeWikiPath(target);
    const relativePath = hasMarkdownExtension(normalized) ? normalized : `${normalized}.md`;
    if (isPathLikeWikiTarget(normalized) && vscode.workspace.workspaceFolders?.length) {
      return vscode.Uri.file(path.resolve(vscode.workspace.workspaceFolders[0].uri.fsPath, relativePath));
    }
    const baseDir = document.uri.scheme === 'file'
      ? path.dirname(document.uri.fsPath)
      : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionPath;
    return vscode.Uri.file(path.resolve(baseDir, relativePath));
  }

  private async openMarkdownDocument(uri: vscode.Uri) {
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, {
      viewColumn: vscode.ViewColumn.Active,
      preview: false,
    });
  }

  private getFontFamily(): string {
    const configured = vscode.workspace.getConfiguration('noteWise.editor').get<string>('ui.fontFamily', '').trim();
    if (!configured) return defaultUiFontFamily();
    if (configured.includes(',') || configured.includes('"') || configured.includes("'")) return configured;
    return `"${configured}", ${defaultUiFontFamily()}`;
  }

  private getThemeMode(): Exclude<ThemeMode, 'auto'> {
    const configured = vscode.workspace.getConfiguration('noteWise.editor').get<ThemeMode>('theme.mode', 'auto');
    if (configured === 'black' || configured === 'white') return configured;

    const kind = vscode.window.activeColorTheme.kind;
    if (kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight) return 'white';
    return 'black';
  }

  private getStageColors(): StageColors {
    const config = vscode.workspace.getConfiguration('noteWise.editor');
    const mode = this.getThemeMode();
    const defaultHeadings = mode === 'black' ? BLACK_HEADING_COLORS : WHITE_HEADING_COLORS;
    const defaultLists = mode === 'black' ? BLACK_LIST_COLORS : WHITE_LIST_COLORS;
    const defaultBlockquotes = mode === 'black' ? BLACK_QUOTE_COLORS : WHITE_QUOTE_COLORS;

    const headings = normalizeColorArray(config.get<string[]>(`theme.${mode}.headings`), defaultHeadings);
    const lists = normalizeColorArray(config.get<string[]>(`theme.${mode}.lists`), defaultLists);
    const blockquotes = normalizeColorArray(config.get<string[]>(`theme.${mode}.blockquotes`), defaultBlockquotes);

    return {
      headings: hasConfiguredValue(config.inspect('stageColors.headings'))
        ? normalizeColorArray(config.get<string[]>('stageColors.headings'), DEFAULT_HEADING_COLORS)
        : headings,
      lists: hasConfiguredValue(config.inspect('stageColors.lists'))
        ? normalizeColorArray(config.get<string[]>('stageColors.lists'), DEFAULT_LIST_COLORS)
        : lists,
      blockquotes: hasConfiguredValue(config.inspect('stageColors.blockquotes'))
        ? normalizeColorArray(config.get<string[]>('stageColors.blockquotes'), DEFAULT_QUOTE_COLORS)
        : blockquotes,
    };
  }

  private getPalette(): EditorPalette {
    const config = vscode.workspace.getConfiguration('noteWise.editor');
    const mode = this.getThemeMode();
    const isBlack = mode === 'black';
    const background = config.get<string>(`theme.${mode}.background`, isBlack ? '#14151b' : '#faf8f3');
    const foreground = config.get<string>(`theme.${mode}.foreground`, isBlack ? '#cccfd6' : '#2f2c28');
    const mutedForeground = config.get<string>(`theme.${mode}.mutedForeground`, isBlack ? '#717784' : '#8d8579');

    return {
      mode,
      background,
      foreground,
      mutedForeground,
      activeLine: isBlack ? '#1b1c24' : '#f1ede4',
      gutterBackground: isBlack ? '#14151b' : '#faf8f3',
      gutterForeground: isBlack ? '#4b4f59' : '#b3ab9c',
      selectionBackground: isBlack ? '#34415e80' : '#d8cdbb80',
      cursor: isBlack ? '#ff7a6d' : '#c0392b',
    };
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'main.global.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'main.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: http: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>NoteWise Editor</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function parseWikiLinkTarget(rawTarget: string): string | undefined {
  const withoutAlias = rawTarget.split('|')[0]?.trim() ?? '';
  const fragmentIndex = withoutAlias.search(/[#^]/);
  const target = (fragmentIndex >= 0 ? withoutAlias.slice(0, fragmentIndex) : withoutAlias).trim();
  return target.length > 0 ? target : undefined;
}

function normalizeWikiPath(target: string): string {
  return target
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
}

function markdownPathCandidates(target: string): string[] {
  if (hasMarkdownExtension(target)) return [target];
  return [`${target}.md`, `${target}.markdown`];
}

function hasMarkdownExtension(value: string): boolean {
  return /\.(md|markdown)$/i.test(value);
}

function isMarkdownPath(value: string): boolean {
  return hasMarkdownExtension(value.split(/[?#]/, 1)[0] ?? value);
}

function resolveMarkdownLinkUri(document: vscode.TextDocument, href: string): vscode.Uri | undefined {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;
  if (trimmed.startsWith('//')) return vscode.Uri.parse(`https:${trimmed}`);
  if (hasUriScheme(trimmed)) return vscode.Uri.parse(trimmed);

  const pathPart = getLinkPathPart(trimmed);
  if (!pathPart) return undefined;

  const baseDir = document.uri.scheme === 'file'
    ? path.dirname(document.uri.fsPath)
    : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return vscode.Uri.file(path.resolve(baseDir, safeDecodeUriComponent(pathPart)));
}

function isExternalLinkUri(uri: vscode.Uri): boolean {
  return ['http', 'https', 'mailto', 'tel'].includes(uri.scheme.toLocaleLowerCase());
}

function hasUriScheme(value: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(value)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function getLinkPathPart(value: string): string {
  const markerIndex = value.search(/[?#]/);
  return markerIndex >= 0 ? value.slice(0, markerIndex) : value;
}

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isPathLikeWikiTarget(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function stripMarkdownExtension(value: string): string {
  return value.replace(/\.(md|markdown)$/i, '');
}

async function fileExists(fsPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(fsPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function normalizeFsPath(fsPath: string): string {
  return path.normalize(fsPath).toLocaleLowerCase();
}

function normalizeColorArray(value: readonly string[] | undefined, fallback: readonly string[]): string[] {
  const result = [...fallback];
  if (!Array.isArray(value)) return result;

  for (let index = 0; index < Math.min(6, value.length); index++) {
    const color = value[index];
    if (typeof color === 'string' && color.trim().length > 0) {
      result[index] = color.trim();
    }
  }
  return result;
}

function normalizeHexColor(value: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return undefined;
}

function normalizeSyntaxVisibility(value: string | undefined): SyntaxVisibility {
  return value === 'always' || value === 'never' ? value : 'auto';
}

function normalizeThemeMode(value: string | undefined): ThemeMode {
  return value === 'black' || value === 'white' ? value : 'auto';
}

interface ConfigurationInspection<T> {
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
  globalLanguageValue?: T;
  workspaceLanguageValue?: T;
  workspaceFolderLanguageValue?: T;
}

function hasConfiguredValue<T>(inspection: ConfigurationInspection<T> | undefined): boolean {
  if (!inspection) return false;
  return (
    inspection.globalValue !== undefined ||
    inspection.workspaceValue !== undefined ||
    inspection.workspaceFolderValue !== undefined ||
    inspection.globalLanguageValue !== undefined ||
    inspection.workspaceLanguageValue !== undefined ||
    inspection.workspaceFolderLanguageValue !== undefined
  );
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function imageExtension(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('gif')) return 'gif';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('svg')) return 'svg';
  return 'png';
}

function sanitizeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function timestampForFile(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function toMarkdownPath(value: string): string {
  return value.split(path.sep).join('/');
}
