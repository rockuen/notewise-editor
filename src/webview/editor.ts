import Vditor from 'vditor';
import 'vditor/dist/index.css';
import type { ColorRole, DocumentInfo, EditorSettings, WikiLinkCandidate } from '../messages';
import { sendError, sendInfo, sendOpenLink, sendOpenWikiLink, sendPasteImage } from './sync';

export interface NoteWiseEditorView {
  dom: HTMLElement;
  getValue(): string;
  setValue(content: string): void;
  insertValue(content: string): void;
  focus(): void;
  destroy(): void;
}

let applyingRemoteUpdate = false;
let chromeStylesInjected = false;
let currentVditor: Vditor | undefined;
let currentSave: (() => void) | undefined;
let vditorCdnUri = '';
let resourceBaseUri = '';
let imagePreviewClosePatched = false;
let saveHotkeyPatched = false;
let wikiLinkDecorationFrame: number | undefined;
let wikiLinkRanges: WikiLinkRange[] = [];

interface SplitMarkdown {
  frontmatter: string;
  body: string;
}

interface WikiLinkRange {
  target: string;
  range: Range;
}

export function setVditorCdnUri(uri: string) {
  vditorCdnUri = uri.replace(/\/$/, '');
}

export function createMarkdownEditor(
  parent: HTMLElement,
  content: string,
  settings: EditorSettings,
  documentInfo: DocumentInfo,
  sendLocalChange: (content: string) => void,
  onReload: () => void,
  onSave: (content: string) => void
): NoteWiseEditorView {
  // Last text exchanged with the host, as vditor serializes it (vditor rewrites
  // markdown, so the raw document text is no baseline). vditor reports typing
  // only ~800ms later (undoDelay); Reload compares against this to catch it.
  let lastSyncedValue: string | undefined;
  const onLocalChange = (value: string) => {
    lastSyncedValue = value;
    sendLocalChange(value);
  };
  const reloadFromDisk = () => {
    const value = getFullValue();
    if (lastSyncedValue !== undefined && value !== lastSyncedValue) onLocalChange(value);
    onReload();
  };
  applyCssVariables(settings);
  scheduleHeadingPresentation(parent);
  patchImagePreviewClose();
  patchSaveHotkey();
  resourceBaseUri =documentInfo.resourceBaseUri ?? '';
  let visibleDocument = splitYamlFrontmatter(content);
  parent.innerHTML = '<div class="msl-vditor-host"></div>';
  const host = parent.querySelector<HTMLElement>('.msl-vditor-host');
  if (!host) throw new Error('Missing Vditor host.');
  let detachTabIndentHandling: (() => void) | undefined;
  let detachHeadingHotkeys: (() => void) | undefined;
  let detachInlineFormatHotkeys: (() => void) | undefined;
  let detachFindBar: (() => void) | undefined;

  const vditor = new Vditor(host, {
    width: '100%',
    height: '100%',
    minHeight: 0,
    cdn: vditorCdnUri,
    lang: 'ko_KR',
    icon: 'ant',
    value: visibleDocument.body,
    mode: 'ir',
    cache: { enable: false },
    toolbarConfig: { pin: true },
    preview: {
      math: {
        inlineDigit: true,
      },
      markdown: {
        // The webview origin cannot serve files from disk, so relative image and
        // link targets must be prefixed with the document folder's webview URI.
        linkBase: documentInfo.resourceBaseUri ?? '',
      },
      parse(element: HTMLElement) {
        decorateWikiLinks(element);
      },
      theme: {
        current: settings.palette.mode === 'black' ? 'dark' : 'light',
      },
    },
    theme: settings.palette.mode === 'black' ? 'dark' : 'classic',
    link: {
      // Vditor's built-in link opening uses window.open, which is blocked inside the
      // VS Code webview. Route every click through the host via openExternal instead.
      isOpen: false,
      click: (bom: Element | null) => openVditorLink(bom),
    },
    toolbar: createToolbar(reloadFromDisk),
    hint: createWikiLinkHint(documentInfo.wikiLinks),
    input(value: string) {
      if (applyingRemoteUpdate) return;
      scheduleWikiLinkDecorations(parent);
      scheduleHeadingPresentation(parent);
      scheduleImageWidthPresentation(parent);
      onLocalChange(joinYamlFrontmatter(visibleDocument.frontmatter, value));
    },
    upload: {
      url: '/notewise-upload-placeholder',
      handler(files: File[]) {
        void handleVditorUpload(files);
        return null;
      },
    },
    after() {
      // Like Obsidian, only `~~text~~` strikes through. lute also treats a single
      // `~text~` as strikethrough, which mangles ranges such as `8~10°C (4~7)`.
      // vditor exposes no option for it, so switch it off on its lute instance
      // and re-render what init already rendered with it on.
      getInternalVditor(vditor)?.lute?.SetGFMStrikethrough1?.(false);
      if (visibleDocument.body.includes('~')) vditor.setValue(visibleDocument.body, true);
      patchLinkOpening(parent);
      patchCodeBlockCopy(parent);
      dockVditorToolbar(parent);
      mountTableTools(parent, () => vditor.getValue(), () => {
        scheduleWikiLinkDecorations(parent);
        scheduleHeadingPresentation(parent);
        scheduleImageWidthPresentation(parent);
        onLocalChange(joinYamlFrontmatter(visibleDocument.frontmatter, vditor.getValue()));
      });
      detachFindBar?.();
      detachFindBar = mountFindBar(parent);
      detachTabIndentHandling?.();
      detachTabIndentHandling = patchTabIndentHandling(parent, vditor, () => {
        scheduleWikiLinkDecorations(parent);
        onLocalChange(joinYamlFrontmatter(visibleDocument.frontmatter, vditor.getValue()));
      });
      detachHeadingHotkeys?.();
      detachHeadingHotkeys = patchHeadingHotkeys(parent, () => {
        scheduleHeadingPresentation(parent);
        scheduleWikiLinkDecorations(parent);
        onLocalChange(joinYamlFrontmatter(visibleDocument.frontmatter, vditor.getValue()));
      });
      detachInlineFormatHotkeys?.();
      detachInlineFormatHotkeys = patchInlineFormatHotkeys(parent, vditor, () => {
        scheduleWikiLinkDecorations(parent);
        onLocalChange(joinYamlFrontmatter(visibleDocument.frontmatter, vditor.getValue()));
      });
      scheduleWikiLinkDecorations(parent);
      scheduleHeadingPresentation(parent);
      scheduleImageWidthPresentation(parent);
      lastSyncedValue = joinYamlFrontmatter(visibleDocument.frontmatter, vditor.getValue());
      vditor.focus();
    },
  });
  currentVditor = vditor;
  const detachImageResize = attachImageResizeHandling(parent, () => {
    if (applyingRemoteUpdate) return;
    onLocalChange(joinYamlFrontmatter(visibleDocument.frontmatter, vditor.getValue()));
  });
  const getFullValue = () => joinYamlFrontmatter(visibleDocument.frontmatter, vditor.getValue());
  const save = () => {
    const value = getFullValue();
    lastSyncedValue = value;
    onSave(value);
  };
  currentSave = save;

  return {
    dom: parent,
    getValue: getFullValue,
    setValue: (next) => {
      const split = splitYamlFrontmatter(next);
      if (visibleDocument.frontmatter === split.frontmatter && vditor.getValue() === split.body) return;
      visibleDocument = split;
      applyingRemoteUpdate = true;
      try {
        vditor.setValue(split.body);
        lastSyncedValue = getFullValue();
        scheduleWikiLinkDecorations(parent);
        scheduleHeadingPresentation(parent);
        scheduleImageWidthPresentation(parent);
      } finally {
        applyingRemoteUpdate = false;
      }
    },
    insertValue: (next) => vditor.insertValue(next),
    focus: () => vditor.focus(),
    destroy: () => {
      if (currentVditor === vditor) currentVditor = undefined;
      if (currentSave === save) currentSave = undefined;
      detachTabIndentHandling?.();
      detachTabIndentHandling = undefined;
      detachHeadingHotkeys?.();
      detachHeadingHotkeys = undefined;
      detachInlineFormatHotkeys?.();
      detachInlineFormatHotkeys = undefined;
      detachFindBar?.();
      detachFindBar = undefined;
      detachImageResize();
      clearWikiLinkDecorations();
      vditor.destroy();
    },
  };
}

export function updateEditorContent(view: NoteWiseEditorView, content: string) {
  view.setValue(content);
}

export function insertEditorText(view: NoteWiseEditorView, text: string) {
  view.insertValue(text);
  view.focus();
  scheduleImageWidthPresentation(view.dom);
}

export function applyEditorSettings(_view: NoteWiseEditorView, settings: EditorSettings) {
  applyCssVariables(settings);
  scheduleHeadingPresentation(document);
  const vditorRoot = document.querySelector<HTMLElement>('.vditor');
  if (vditorRoot) {
    vditorRoot.classList.toggle('vditor--dark', settings.palette.mode === 'black');
  }
  // The vditor content theme is only chosen at init, so a runtime palette change
  // would leave the stale content-theme stylesheet (e.g. dark tables) loaded.
  const isBlack = settings.palette.mode === 'black';
  currentVditor?.setTheme(isBlack ? 'dark' : 'classic', isBlack ? 'dark' : 'light');
}

/** Applies a single color to its CSS variable immediately, for live preview before the host persists it. */
export function previewDocColor(role: ColorRole, value: string, index?: number) {
  const root = document.documentElement;
  switch (role) {
    case 'foreground':
      root.style.setProperty('--msl-doc-fg', value);
      break;
    case 'mutedForeground':
      root.style.setProperty('--msl-doc-muted', value);
      break;
    case 'heading':
      if (typeof index === 'number') root.style.setProperty(`--msl-heading-${index + 1}-color`, value);
      scheduleHeadingPresentation(document);
      break;
    case 'list':
      if (typeof index === 'number') root.style.setProperty(`--msl-list-${index}-color`, value);
      break;
    case 'quote':
      if (typeof index === 'number') root.style.setProperty(`--msl-quote-${index}-color`, value);
      break;
  }
}

function createToolbar(onReload: () => void): any[] {
  const tool = (name: string, tipPosition = 's') => ({
    name,
    tipPosition,
    tip: TOOLTIP_LABELS[name] ?? name,
    icon: TOOLBAR_ICONS[name] ?? icon('circle'),
  });

  return [
    {
      name: 'save',
      tipPosition: 's',
      tip: TOOLTIP_LABELS['save'],
      icon: TOOLBAR_ICONS['save'],
      click: saveCurrentDocument,
    },
    {
      name: 'reload',
      tipPosition: 's',
      tip: TOOLTIP_LABELS['reload'],
      icon: TOOLBAR_ICONS['reload'],
      click: onReload,
    },
    '|',
    tool('bold'),
    tool('link'),
    {
      name: 'wiki-link',
      tipPosition: 's',
      tip: TOOLTIP_LABELS['wiki-link'],
      icon: TOOLBAR_ICONS['wiki-link'],
      click() {
        getCurrentVditor()?.insertValue('[[');
      },
    },
    '|',
    tool('list'),
    tool('ordered-list'),
    tool('check'),
    tool('outdent'),
    tool('indent'),
    '|',
    tool('quote'),
    tool('line'),
    tool('code'),
    tool('inline-code'),
    tool('insert-before'),
    tool('insert-after'),
    '|',
    tool('upload'),
    tool('table'),
    '|',
    tool('undo'),
    tool('redo'),
    '|',
    tool('edit-mode', 'e'),
    {
      name: 'more',
      tipPosition: 'e',
      icon: TOOLBAR_ICONS.more,
      toolbar: [
        tool('both'),
        tool('code-theme'),
        tool('content-theme'),
        tool('outline'),
        tool('preview'),
        {
          name: 'copy-markdown',
          icon: '<span class="msl-toolbar-label msl-toolbar-label--menu">Copy Markdown</span>',
          async click() {
            const current = getCurrentVditor();
            if (!current) return;
            try {
              await navigator.clipboard.writeText(current.getValue());
              sendInfo('Copied Markdown.');
            } catch (error) {
              sendError(`Copy Markdown failed: ${String(error)}`);
            }
          },
        },
        {
          name: 'copy-html',
          icon: '<span class="msl-toolbar-label msl-toolbar-label--menu">Copy HTML</span>',
          async click() {
            const current = getCurrentVditor();
            if (!current) return;
            try {
              await navigator.clipboard.writeText(current.getHTML());
              sendInfo('Copied HTML.');
            } catch (error) {
              sendError(`Copy HTML failed: ${String(error)}`);
            }
          },
        },
      ],
    },
  ].map((item: any) => (typeof item === 'string' ? { name: item, tipPosition: 's' } : { tipPosition: 's', ...item }));
}

/**
 * Saves the editor's live text, which may include typing vditor has not
 * reported yet (its input callback lags ~800ms); the host applies it before
 * saving so nothing typed just before the save is left out.
 */
function saveCurrentDocument() {
  currentSave?.();
}

/**
 * Ctrl/Cmd+S would otherwise reach VS Code's own save, which writes the host
 * document without the typing the webview has not synced yet. Consume it in the
 * capture phase (the Ctrl+B/Ctrl+F technique) and save the live text instead.
 */
function patchSaveHotkey() {
  if (saveHotkeyPatched) return;
  saveHotkeyPatched = true;
  document.addEventListener(
    'keydown',
    (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.code !== 'KeyS') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      saveCurrentDocument();
    },
    true
  );
}

function icon(name: string): string {
  return `<svg class="msl-toolbar-icon msl-toolbar-icon--${name}" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><use href="#msl-icon-${name}"></use></svg>`;
}

const TOOLBAR_ICONS: Record<string, string> = {
  save: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><path d="M17 21v-8H7v8"></path><path d="M7 3v5h8"></path></svg>`,
  reload: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"></path><path d="M21 3v5h-5"></path></svg>`,
  bold: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"></path><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"></path></svg>`,
  link: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"></path><path d="M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1"></path></svg>`,
  'wiki-link': `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5H4v14h3"></path><path d="M17 5h3v14h-3"></path><path d="M10 13a4 4 0 0 0 5.7 0l.8-.8a4 4 0 0 0-5.7-5.7l-.5.5"></path><path d="M14 11a4 4 0 0 0-5.7 0l-.8.8a4 4 0 0 0 5.7 5.7l.5-.5"></path></svg>`,
  list: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13"></path><path d="M8 12h13"></path><path d="M8 18h13"></path><path d="M3.5 6h.01"></path><path d="M3.5 12h.01"></path><path d="M3.5 18h.01"></path></svg>`,
  'ordered-list': `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6h11"></path><path d="M10 12h11"></path><path d="M10 18h11"></path><path d="M4 6h1v4"></path><path d="M4 10h2"></path><path d="M4 14h2l-2 4h2"></path></svg>`,
  check: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>`,
  outdent: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 6H11"></path><path d="M21 12H11"></path><path d="M21 18H11"></path><path d="M7 8l-4 4 4 4"></path></svg>`,
  indent: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 6H11"></path><path d="M21 12H11"></path><path d="M21 18H11"></path><path d="M3 8l4 4-4 4"></path></svg>`,
  quote: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 11H5a2 2 0 0 1 2-2h1V5H7a6 6 0 0 0-6 6v5h7z"></path><path d="M22 11h-3a2 2 0 0 1 2-2h1V5h-1a6 6 0 0 0-6 6v5h7z"></path></svg>`,
  line: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"></path></svg>`,
  code: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 18l6-6-6-6"></path><path d="M8 6l-6 6 6 6"></path></svg>`,
  'inline-code': `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-12"></path><path d="M6 8l-4 4 4 4"></path><path d="M18 8l4 4-4 4"></path></svg>`,
  'insert-before': `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"></path><path d="M5 12l7-7 7 7"></path></svg>`,
  'insert-after': `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"></path><path d="M19 12l-7 7-7-7"></path></svg>`,
  upload: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M17 8l-5-5-5 5"></path><path d="M12 3v12"></path></svg>`,
  table: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 10h18"></path><path d="M9 4v16"></path><path d="M15 4v16"></path></svg>`,
  undo: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14l-4-4 4-4"></path><path d="M5 10h10a5 5 0 1 1 0 10h-1"></path></svg>`,
  redo: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 14l4-4-4-4"></path><path d="M19 10H9a5 5 0 1 0 0 10h1"></path></svg>`,
  'edit-mode': `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16"></path><path d="M4 12h10"></path><path d="M4 19h16"></path><path d="M17 9l3 3-3 3"></path></svg>`,
  more: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12h.01"></path><path d="M19 12h.01"></path><path d="M5 12h.01"></path></svg>`,
  both: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M12 4v16"></path></svg>`,
  'code-theme': `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 9l-4 3 4 3"></path><path d="M16 9l4 3-4 3"></path><path d="M13 7l-2 10"></path></svg>`,
  'content-theme': `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9c0-1-1.4-1.3-2.2-.8-.9.5-2 .1-2.4-.8-.4-.9 0-2 .8-2.5.8-.4.5-1.9-.4-2.4A8.9 8.9 0 0 0 12 3Z"></path><path d="M7.5 10.5h.01"></path><path d="M10.5 7.5h.01"></path><path d="M14.5 7.5h.01"></path></svg>`,
  outline: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16"></path><path d="M4 12h10"></path><path d="M4 18h13"></path></svg>`,
  preview: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
  circle: `<svg class="msl-toolbar-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle></svg>`,
};

const TOOLTIP_LABELS: Record<string, string> = {
  save: 'Save',
  reload: 'Reload from disk',
  bold: /Mac|iP(hone|ad|od)/.test(navigator.platform) ? 'Bold (⌘B)' : 'Bold (Ctrl+B)',
  link: 'Link',
  'wiki-link': 'Internal note link',
  list: 'Bullet list',
  'ordered-list': 'Numbered list',
  check: 'Checklist',
  outdent: 'Outdent',
  indent: 'Indent',
  quote: 'Quote',
  line: 'Horizontal line',
  code: 'Code block',
  'inline-code': 'Inline code',
  'insert-before': 'Insert line above',
  'insert-after': 'Insert line below',
  upload: 'Insert image/file',
  table: 'Insert table',
  undo: 'Undo',
  redo: 'Redo',
  'edit-mode': 'Edit mode',
  more: 'More tools',
  both: 'Split view',
  'code-theme': 'Code theme',
  'content-theme': 'Content theme',
  outline: 'Outline',
  preview: 'Preview',
  'copy-markdown': 'Copy Markdown',
  'copy-html': 'Copy HTML',
};

function splitYamlFrontmatter(markdown: string): SplitMarkdown {
  const match = markdown.match(/^(---\r?\n[\s\S]*?\r?\n---)(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return { frontmatter: '', body: markdown };
  return { frontmatter: match[1], body: match[2] ?? '' };
}

function joinYamlFrontmatter(frontmatter: string, body: string): string {
  if (!frontmatter) return body;
  return body.trim().length > 0 ? `${frontmatter}\n${body}` : `${frontmatter}\n`;
}

function getCurrentVditor(): Vditor | undefined {
  return currentVditor;
}

async function handleVditorUpload(files: File[]) {
  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    sendPasteImage(dataUrl, file.type, file.name);
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function createWikiLinkHint(candidates: WikiLinkCandidate[]) {
  return {
    delay: 120,
    extend: [
      {
        key: '[[',
        hint(value: string) {
          return getWikiLinkHints(value, candidates);
        },
      },
    ],
  };
}

function getWikiLinkHints(value: string, candidates: WikiLinkCandidate[]) {
  const query = normalizeWikiQuery(value);
  const normalizedQuery = normalizeMatchText(query);
  const matches = candidates
    .map((candidate) => ({
      candidate,
      score: scoreWikiCandidate(candidate, normalizedQuery),
    }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => a.score - b.score || a.candidate.label.localeCompare(b.candidate.label, 'ko'))
    .slice(0, 8)
    .map(({ candidate }) => ({
      html: `<span class="msl-wikilink-hint__title">${escapeHtml(candidate.label)}</span><span class="msl-wikilink-hint__detail">${escapeHtml(candidate.detail)}</span>`,
      value: `[[${candidate.target}]]`,
    }));

  if (query && !matches.some((item) => normalizeMatchText(item.value) === normalizeMatchText(`[[${query}]]`))) {
    matches.push({
      html: `<span class="msl-wikilink-hint__title">${escapeHtml(query)}</span><span class="msl-wikilink-hint__detail">Create note link</span>`,
      value: `[[${query}]]`,
    });
  }

  return matches;
}

function normalizeWikiQuery(value: string) {
  return value.replace(/\]\][\s\S]*$/, '').replace(/^\s+/, '').slice(0, 80);
}

function scoreWikiCandidate(candidate: WikiLinkCandidate, query: string) {
  if (!query) return 100;
  const label = normalizeMatchText(candidate.label);
  const target = normalizeMatchText(candidate.target);
  const detail = normalizeMatchText(candidate.detail);
  if (label === query || target === query) return 0;
  if (label.startsWith(query)) return 1;
  if (target.startsWith(query)) return 2;
  if (detail.startsWith(query)) return 3;
  if (label.includes(query)) return 4;
  if (target.includes(query) || detail.includes(query)) return 5;
  return -1;
}

function normalizeMatchText(value: string) {
  return value.trim().toLocaleLowerCase();
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * Forward the link Vditor hands to its `link.click` callback to the host.
 * In IR mode `bom` is the `.vditor-ir__marker--link` span whose text is the URL;
 * in WYSIWYG/preview mode it is the real `<a>` whose `href` attribute is the URL.
 */
function openVditorLink(bom: Element | null) {
  if (!bom) return;
  const href = stripResourceBase((bom.getAttribute('href') ?? bom.textContent ?? '').trim());
  if (href) sendOpenLink(href);
}

/**
 * Rendered anchors carry the document-folder base URI prefixed by `linkBase`;
 * strip it again so the host resolves the raw markdown target as before.
 */
function stripResourceBase(href: string): string {
  if (resourceBaseUri && href.startsWith(resourceBaseUri)) return href.slice(resourceBaseUri.length);
  return href;
}

const IMAGE_RESIZE_MIN_WIDTH = 48;
const IMAGE_RESIZE_MAX_WIDTH = 3200;
const IMAGE_RESIZE_FACTOR = 1.1;

/**
 * Vditor's image-preview overlay closes itself through an inline onclick
 * attribute, which the webview CSP blocks (the rotate button survives because
 * it uses addEventListener). Close the overlay with delegated listeners instead.
 */
function patchImagePreviewClose() {
  if (imagePreviewClosePatched) return;
  imagePreviewClosePatched = true;

  const closePreview = (): boolean => {
    const overlay = document.querySelector('.vditor-img');
    if (!overlay) return false;
    overlay.remove();
    document.body.style.overflow = '';
    return true;
  };

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest('.vditor-img__btn');
    if (!button || button.hasAttribute('data-deg')) return;
    closePreview();
  });

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return;
      if (closePreview()) event.stopPropagation();
    },
    true
  );
}

/**
 * Ctrl+wheel over an image scales it proportionally. The width persists as an
 * Obsidian-compatible `![alt|width](src)` suffix so it round-trips through the
 * markdown document; applyImageWidths re-applies it after every re-render.
 */
function attachImageResizeHandling(root: HTMLElement, onResized: () => void): () => void {
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey || event.deltaY === 0) return;
    const img = event.target instanceof HTMLImageElement ? event.target : null;
    if (!img) return;
    event.preventDefault();
    event.stopPropagation();

    const factor = event.deltaY < 0 ? IMAGE_RESIZE_FACTOR : 1 / IMAGE_RESIZE_FACTOR;
    const current = img.getBoundingClientRect().width || img.naturalWidth || IMAGE_RESIZE_MIN_WIDTH;
    const width = Math.round(clampImageWidth(current * factor));
    img.style.width = `${width}px`;
    if (persistImageWidth(img, width)) onResized();
  };

  root.addEventListener('wheel', onWheel, { passive: false, capture: true });
  return () => root.removeEventListener('wheel', onWheel, { capture: true });
}

function clampImageWidth(width: number): number {
  return Math.min(IMAGE_RESIZE_MAX_WIDTH, Math.max(IMAGE_RESIZE_MIN_WIDTH, width));
}

/**
 * Writes the width into the IR alt marker (`![alt|width](src)`) — in IR mode the
 * marker text is what getValue() serializes, so this is the durable edit.
 */
function persistImageWidth(img: HTMLImageElement, width: number): boolean {
  const node = img.closest('[data-type="img"]');
  if (!node) return false;

  const brackets = node.querySelectorAll<HTMLElement>(':scope > .vditor-ir__marker--bracket');
  let altMarker: HTMLElement;
  if (brackets.length === 3) {
    altMarker = brackets[1];
  } else if (brackets.length === 2) {
    // `![](src)` renders no alt marker between the brackets; create one.
    altMarker = document.createElement('span');
    altMarker.className = 'vditor-ir__marker vditor-ir__marker--bracket';
    brackets[1].before(altMarker);
  } else {
    return false;
  }

  const baseAlt = (altMarker.textContent ?? '').replace(/\|\d+\s*$/, '');
  const nextAlt = `${baseAlt}|${width}`;
  altMarker.textContent = nextAlt;
  img.setAttribute('alt', nextAlt);
  img.dataset.mslSized = 'true';
  return true;
}

function scheduleImageWidthPresentation(root: ParentNode) {
  const run = () => applyImageWidths(root);
  requestAnimationFrame(run);
  setTimeout(run, 60);
  setTimeout(run, 180);
}

/** Re-applies `![alt|width](src)` widths, which re-renders drop from the DOM. */
function applyImageWidths(root: ParentNode) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
    const match = /\|(\d+)\s*$/.exec(img.getAttribute('alt') ?? '');
    if (match) {
      img.style.width = `${clampImageWidth(Number(match[1]))}px`;
      img.dataset.mslSized = 'true';
    } else if (img.dataset.mslSized) {
      img.style.width = '';
      delete img.dataset.mslSized;
    }
  });
}

function patchLinkOpening(root: HTMLElement) {
  root.addEventListener('mousemove', (event) => {
    const target = wikiLinkTargetFromPoint(event.clientX, event.clientY) ?? wikiLinkFromPoint(event.clientX, event.clientY);
    root.classList.toggle('msl-wikilink-hovering', Boolean(target));
  });

  root.addEventListener('mouseleave', () => {
    root.classList.remove('msl-wikilink-hovering');
  });

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const wikiLink = target?.closest<HTMLElement>('[data-notewise-wiki-link]');
    if (wikiLink) {
      event.preventDefault();
      sendOpenWikiLink(wikiLink.dataset.notewiseWikiLink ?? wikiLink.textContent ?? '');
      return;
    }

    const anchor = target?.closest('a');
    if (anchor) {
      // Vditor's own link.click handler fires first and calls preventDefault. Only
      // handle anchors it missed (e.g. nested markup in preview mode) so a link that
      // Vditor already forwarded is not opened a second time.
      if (!event.defaultPrevented) {
        event.preventDefault();
        sendOpenLink(stripResourceBase(anchor.getAttribute('href') ?? anchor.href));
      }
      return;
    }

    const rawWikiTarget = wikiLinkTargetFromPoint(event.clientX, event.clientY) ?? wikiLinkFromPoint(event.clientX, event.clientY);
    if (!rawWikiTarget) return;
    event.preventDefault();
    sendOpenWikiLink(rawWikiTarget);
  });

  root.addEventListener('dblclick', (event) => {
    const rawWikiTarget = wikiLinkFromPoint(event.clientX, event.clientY);
    if (!rawWikiTarget) return;
    event.preventDefault();
    sendOpenWikiLink(rawWikiTarget);
  });
}

/**
 * Vditor renders a per-code-block copy button (`.vditor-copy`) that copies via
 * `document.execCommand('copy')`, which is blocked inside the VS Code webview.
 * Intercept the click in the capture phase and copy with the async Clipboard API,
 * falling back to a temporary textarea + execCommand if that is unavailable.
 */
function patchCodeBlockCopy(root: HTMLElement) {
  root.addEventListener(
    'click',
    (event) => {
      const target = event.target as HTMLElement | null;
      const copyContainer = target?.closest<HTMLElement>('.vditor-copy');
      if (!copyContainer) return;

      const textarea = copyContainer.querySelector<HTMLTextAreaElement>('textarea');
      const code = textarea?.value ?? '';
      if (!code) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      void copyCodeBlock(code);
    },
    true
  );
}

async function copyCodeBlock(code: string) {
  try {
    await navigator.clipboard.writeText(code);
    sendInfo('Copied code block.');
    return;
  } catch {
    if (copyViaExecCommand(code)) {
      sendInfo('Copied code block.');
      return;
    }
    sendError('Copy code block failed.');
  }
}

function copyViaExecCommand(code: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = code;
  textarea.style.position = 'fixed';
  textarea.style.left = '-100000px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let succeeded = false;
  try {
    succeeded = document.execCommand('copy');
  } catch {
    succeeded = false;
  }
  document.body.removeChild(textarea);
  return succeeded;
}

function patchTabIndentHandling(root: HTMLElement, vditor: Vditor, afterCommand: () => void): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isPlainTabKey(event)) return;

    const target = event.target as Element | null;
    if (!target || !root.contains(target)) return;
    if (!target.closest('.vditor-ir, .vditor-wysiwyg')) return;
    // Leave auto-complete hints, table tools, and real form controls on native Tab.
    if (target.closest('select, textarea, button, .vditor-hint, .msl-table-tools')) return;

    // Inside the editor content Tab must never shift focus to surrounding UI. We
    // always consume it and apply either list-level indentation or plain
    // whitespace indentation depending on the caret context.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const listItem = getActiveListItem(root, target);
    if (listItem) {
      ensureSelectionInListItem(vditor, listItem);
      if (runVditorToolbarCommand(vditor, event.shiftKey ? 'outdent' : 'indent')) {
        window.setTimeout(afterCommand, 0);
      }
      return;
    }

    const changed = event.shiftKey ? outdentPlainText() : indentPlainText(vditor);
    if (changed) {
      window.setTimeout(afterCommand, 0);
    }
  };

  root.addEventListener('keydown', onKeyDown, true);
  return () => root.removeEventListener('keydown', onKeyDown, true);
}

// Alt+1..Alt+5 map the current block to a heading level (H2..H6). We deliberately
// offset by one — Alt+1 is H2, not H1 — because H1 is reserved for the note title.
const HEADING_HOTKEY_LEVELS: Record<string, number> = {
  Digit1: 2,
  Numpad1: 2,
  Digit2: 3,
  Numpad2: 3,
  Digit3: 4,
  Numpad3: 4,
  Digit4: 5,
  Numpad4: 5,
  Digit5: 6,
  Numpad5: 6,
};

const HEADING_BLOCK_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'BLOCKQUOTE', 'OL', 'UL']);

/**
 * Alt+1..Alt+5 set the caret's block to a heading (H2..H6). The listener runs in
 * the capture phase and consumes the event (preventDefault + stopPropagation), so
 * it wins over any VS Code keybinding bound to the same chord — the same technique
 * the Tab indent handler relies on. `event.code` is matched (not `event.key`) so
 * the mapping is keyboard-layout independent even when Alt mutates the character.
 */
function patchHeadingHotkeys(root: HTMLElement, afterCommand: () => void): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const level = HEADING_HOTKEY_LEVELS[event.code];
    if (!level) return;

    const target = event.target as Element | null;
    if (!target || !root.contains(target)) return;
    const editorEl = target.closest<HTMLElement>('.vditor-ir');
    if (!editorEl) return;
    // Leave hints, table tools, and real form controls alone.
    if (target.closest('.vditor-hint, .msl-table-tools, input, textarea, select, button')) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (applyHeadingLevel(editorEl, level)) {
      window.setTimeout(afterCommand, 0);
    }
  };

  root.addEventListener('keydown', onKeyDown, true);
  return () => root.removeEventListener('keydown', onKeyDown, true);
}

/**
 * Ctrl/Cmd+B toggles bold on the caret or selection. VS Code owns this chord for
 * its own sidebar toggle, so the listener runs in the capture phase and consumes
 * the event before the keybinding service can see it — the same technique the Tab
 * and heading handlers use. The toolbar button carries vditor's bold logic, so the
 * hotkey reuses it via a synthetic click instead of re-implementing the toggle.
 */
function patchInlineFormatHotkeys(root: HTMLElement, vditor: Vditor, afterCommand: () => void): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    if (event.code !== 'KeyB') return;

    const target = event.target as Element | null;
    if (!target || !root.contains(target)) return;
    if (!target.closest('.vditor-ir')) return;
    // Leave hints, table tools, and real form controls alone.
    if (target.closest('.vditor-hint, .msl-table-tools, input, textarea, select, button')) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    // A second Ctrl+B on the empty `**|**` pair a collapsed-caret bold leaves
    // behind should cancel it, not nest another pair inside.
    if (cancelEmptyBoldMarkers()) {
      window.setTimeout(afterCommand, 0);
      return;
    }

    if (runVditorToolbarCommand(vditor, 'bold')) {
      window.setTimeout(afterCommand, 0);
    }
  };

  // vditor only *removes* bold when the toolbar button carries the
  // `vditor-menu--current` highlight, but it refreshes that highlight on editor
  // keyup/click — never right before a toolbar action — so bold-then-bold-again
  // sees stale state and re-wraps instead of toggling off. Re-derive the
  // highlight from the live selection in the capture phase, before the button's
  // own click handler (ours is on an ancestor, so it runs first even for the
  // synthetic click the hotkey dispatches).
  const onToolbarClick = (event: MouseEvent) => {
    const target = event.target as Element | null;
    if (!target?.closest('.vditor-toolbar [data-type="bold"]')) return;
    syncBoldButtonFromSelection(vditor);
  };

  root.addEventListener('keydown', onKeyDown, true);
  // The toolbar gets docked into the topbar outside `root` (dockVditorToolbar),
  // so the click listener must sit on document to see toolbar buttons at all.
  document.addEventListener('click', onToolbarClick, true);
  return () => {
    root.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('click', onToolbarClick, true);
  };
}

/**
 * Mirrors vditor's `highlightToolbarIR` bold detection (closest ancestor with
 * `data-type="strong"` from the selection start) and stamps the result onto the
 * bold button, so the follow-up click takes vditor's remove path when the caret
 * is inside bold text. Selections outside the editor leave the button untouched.
 */
function syncBoldButtonFromSelection(vditor: Vditor): void {
  const item = getInternalVditor(vditor)?.toolbar?.elements?.bold;
  const button = item?.firstElementChild as HTMLElement | null | undefined;
  if (!button) return;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  if (!el || !el.closest('.vditor-ir')) return;

  let strongSpan = el.closest('[data-type="strong"]');

  // After wrapping a selection, vditor parks the caret just past the closing
  // `**`, *outside* the strong span, so a plain ancestor check misses it. Treat
  // that adjacent position as bold context and move the caret inside the span,
  // where vditor's removeInline can find it.
  if (!strongSpan && range.collapsed) {
    const before = nodeJustBeforeCaret(range);
    if (before instanceof Element && before.matches('[data-type="strong"]')) {
      strongSpan = before;
      const inner = before.querySelector('strong') ?? before;
      const moved = document.createRange();
      moved.selectNodeContents(inner);
      moved.collapse(false);
      selection.removeAllRanges();
      selection.addRange(moved);
    }
  }

  button.classList.toggle('vditor-menu--current', !!strongSpan);
}

/** The sibling node immediately left of a collapsed caret, if the caret sits on a node boundary. */
function nodeJustBeforeCaret(range: Range): Node | null {
  const node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    return range.startOffset === 0 ? node.previousSibling : null;
  }
  return range.startOffset > 0 ? (node.childNodes[range.startOffset - 1] ?? null) : null;
}

/**
 * A collapsed-caret bold leaves the raw pair `**|**` in a plain text node (an
 * empty bold is not valid markdown, so vditor never renders a strong span for
 * it). When the caret still sits between the pairs, remove both instead of
 * delegating to vditor, which would nest a fresh pair inside. The closing pair
 * may live in the same text node or spill into the next one.
 */
function cancelEmptyBoldMarkers(): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return false;

  const text = node as Text;
  const offset = range.startOffset;
  if ((text.textContent ?? '').slice(Math.max(0, offset - 2), offset) !== '**') return false;

  const sameNodeAfter = (text.textContent ?? '').slice(offset, offset + 2);
  if (sameNodeAfter === '**') {
    text.deleteData(offset - 2, 4);
  } else if (sameNodeAfter === '') {
    // The reconcile pass can leave empty text nodes between the pairs (wbr
    // removal debris) — skip them before looking for the closing `**`.
    let next: Node | null = text.nextSibling;
    while (next && next.nodeType === Node.TEXT_NODE && (next.textContent ?? '') === '') {
      next = next.nextSibling;
    }
    if (!next || next.nodeType !== Node.TEXT_NODE || !(next.textContent ?? '').startsWith('**')) {
      return false;
    }
    (next as Text).deleteData(0, 2);
    text.deleteData(offset - 2, 2);
  } else {
    return false;
  }

  const collapsed = document.createRange();
  collapsed.setStart(text, offset - 2);
  collapsed.collapse(true);
  selection.removeAllRanges();
  selection.addRange(collapsed);
  return true;
}

/**
 * Replicates vditor's IR `processHeading` for a fixed level: either rewrite the
 * existing heading marker or prepend a new one to the current block, then let
 * vditor reconcile the raw "## " text into a real heading via a native input
 * event (the exact path typing "## " takes). Returns false when nothing changed.
 */
function applyHeadingLevel(editorEl: HTMLElement, level: number): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!editorEl.contains(range.startContainer)) return false;

  const block = closestIrBlock(range.startContainer, editorEl);
  if (!block) return false;

  const value = `${'#'.repeat(level)} `;
  const marker = block.querySelector<HTMLElement>('.vditor-ir__marker--heading');
  if (marker) {
    const currentLevel = (marker.textContent ?? '').replace(/[^#]/g, '').length;
    if (currentLevel === level) return false; // already at this level — nothing to do
    marker.innerHTML = value;
  } else {
    block.insertAdjacentText('afterbegin', value);
    const collapsed = document.createRange();
    collapsed.selectNodeContents(block);
    collapsed.collapse(false);
    selection.removeAllRanges();
    selection.addRange(collapsed);
  }

  // vditor binds its IR reconciler to the contenteditable host; dispatch from the
  // edited block so the event bubbles up to that listener (the path typing takes).
  block.dispatchEvent(
    new InputEvent('input', { inputType: 'insertText', data: ' ', bubbles: true, cancelable: false })
  );
  return true;
}

/** Closest IR block element for a node, mirroring vditor's `hasClosestBlock`. */
function closestIrBlock(node: Node, editorEl: HTMLElement): HTMLElement | undefined {
  let el: HTMLElement | null =
    node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);

  const dataBlock = el?.closest<HTMLElement>('[data-block="0"]');
  if (dataBlock && editorEl.contains(dataBlock)) return dataBlock;

  while (el && !el.classList.contains('vditor-reset')) {
    if (HEADING_BLOCK_TAGS.has(el.tagName)) return editorEl.contains(el) ? el : undefined;
    el = el.parentElement;
  }
  return undefined;
}

const PLAIN_INDENT_UNIT = '\t';

/**
 * Insert a tab at the caret for non-list contexts so Tab behaves like a normal
 * editor indent. Multi-character selections are left untouched (we only stop the
 * focus change) to avoid replacing the selected text.
 */
function indentPlainText(vditor: Vditor): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  if (!selection.getRangeAt(0).collapsed) return false;
  vditor.insertValue(PLAIN_INDENT_UNIT);
  return true;
}

/**
 * Shift+Tab in a non-list context removes one level of leading whitespace in
 * front of the caret (a single tab, otherwise up to four spaces). The text node
 * is edited in place; the caller re-reads `vditor.getValue()` afterwards to keep
 * the markdown in sync.
 */
function outdentPlainText(): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return false;

  const textNode = node as Text;
  const text = textNode.textContent ?? '';
  const caret = range.startOffset;
  let remove = 0;
  if (caret > 0 && text[caret - 1] === '\t') {
    remove = 1;
  } else {
    while (remove < 4 && caret - remove - 1 >= 0 && text[caret - remove - 1] === ' ') {
      remove += 1;
    }
  }
  if (remove === 0) return false;

  textNode.deleteData(caret - remove, remove);
  const collapsed = document.createRange();
  collapsed.setStart(textNode, caret - remove);
  collapsed.collapse(true);
  selection.removeAllRanges();
  selection.addRange(collapsed);
  return true;
}

function isPlainTabKey(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key === 'Tab' || event.code === 'Tab' || event.keyCode === 9 || event.which === 9;
}

function getActiveListItem(root: HTMLElement, target: Element): HTMLElement | undefined {
  const targetListItem = target.closest<HTMLElement>('li') ?? undefined;
  if (targetListItem && target.closest('input, label')) return targetListItem;

  const selectedListItem = getSelectionListItem(root);
  if (selectedListItem) return selectedListItem;
  return targetListItem;
}

function getSelectionListItem(root: HTMLElement): HTMLElement | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return undefined;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return undefined;
  const startElement =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  return startElement?.closest<HTMLElement>('li') ?? undefined;
}

function ensureSelectionInListItem(vditor: Vditor, listItem: HTMLElement) {
  const internal = getInternalVditor(vditor);
  const mode = internal?.currentMode;
  const editor = mode ? internal?.[mode]?.element : undefined;
  if (!internal || !mode || !editor) return;

  const selection = window.getSelection();
  const currentRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
  if (currentRange && listItem.contains(currentRange.startContainer)) return;

  const range = document.createRange();
  const textNode = firstTextNode(listItem);
  if (textNode) {
    range.setStart(textNode, 0);
  } else {
    range.setStart(listItem, listItem.childNodes.length);
  }
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  internal[mode]!.range = range;
  editor.focus();
}

function firstTextNode(root: HTMLElement): Text | undefined {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  return walker.nextNode() as Text | null ?? undefined;
}

function runVditorToolbarCommand(vditor: Vditor, command: 'indent' | 'outdent' | 'bold'): boolean {
  const item = getInternalVditor(vditor)?.toolbar?.elements?.[command];
  const button = item?.firstElementChild as HTMLElement | null | undefined;
  if (!button || button.classList.contains('vditor-menu--disabled')) return false;

  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return true;
}

type VditorModeState = { element?: HTMLElement; range?: Range };
type VditorInternal = {
  currentMode?: 'ir' | 'wysiwyg' | 'sv';
  ir?: VditorModeState;
  wysiwyg?: VditorModeState;
  sv?: VditorModeState;
  toolbar?: { elements?: Record<string, HTMLElement> };
  lute?: { SetGFMStrikethrough1?(enable: boolean): void };
};

function getInternalVditor(vditor: Vditor): VditorInternal | undefined {
  return (vditor as unknown as { vditor?: VditorInternal }).vditor;
}

function scheduleWikiLinkDecorations(root: HTMLElement) {
  if (wikiLinkDecorationFrame !== undefined) {
    cancelAnimationFrame(wikiLinkDecorationFrame);
  }
  wikiLinkDecorationFrame = requestAnimationFrame(() => {
    wikiLinkDecorationFrame = undefined;
    refreshWikiLinkDecorations(root);
  });
}

function refreshWikiLinkDecorations(root: HTMLElement) {
  const editorRoot = root.querySelector<HTMLElement>('.vditor-ir .vditor-reset, .vditor-wysiwyg .vditor-reset');
  if (!editorRoot) {
    clearWikiLinkDecorations();
    return;
  }

  const nextRanges: WikiLinkRange[] = [];
  const walker = document.createTreeWalker(editorRoot, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.includes('[[')) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('a, code, textarea, input, .vditor-hint, .msl-table-tools')) return NodeFilter.FILTER_REJECT;
      if (parent.closest('[data-type="code-block"], [data-type="code-span"], [data-type="html-block"]')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const text = node.textContent ?? '';
    for (const match of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      const index = match.index ?? 0;
      const rawTarget = match[1]?.trim();
      if (!rawTarget) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + match[0].length);
      nextRanges.push({ target: rawTarget, range });
    }
  }

  wikiLinkRanges = nextRanges;
  applyWikiLinkHighlight(nextRanges.map((item) => item.range));
}

function applyWikiLinkHighlight(ranges: Range[]) {
  const cssHighlights = (CSS as typeof CSS & { highlights?: Map<string, Highlight> }).highlights;
  const HighlightConstructor = (window as Window & { Highlight?: new (...ranges: Range[]) => Highlight }).Highlight;
  if (!cssHighlights || !HighlightConstructor) return;

  if (ranges.length === 0) {
    cssHighlights.delete('notewise-wikilink-raw');
    return;
  }
  cssHighlights.set('notewise-wikilink-raw', new HighlightConstructor(...ranges));
}

function clearWikiLinkDecorations() {
  if (wikiLinkDecorationFrame !== undefined) {
    cancelAnimationFrame(wikiLinkDecorationFrame);
    wikiLinkDecorationFrame = undefined;
  }
  wikiLinkRanges = [];
  const cssHighlights = (CSS as typeof CSS & { highlights?: Map<string, Highlight> }).highlights;
  cssHighlights?.delete('notewise-wikilink-raw');
}

function wikiLinkTargetFromPoint(clientX: number, clientY: number): string | undefined {
  for (const item of wikiLinkRanges) {
    for (const rect of Array.from(item.range.getClientRects())) {
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        return item.target;
      }
    }
  }
  return undefined;
}

function decorateWikiLinks(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.includes('[[')) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('a, code, pre, textarea, input, [contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  for (const node of nodes) {
    const text = node.textContent ?? '';
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let matched = false;

    for (const match of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      const index = match.index ?? 0;
      const rawTarget = match[1]?.trim();
      if (!rawTarget) continue;
      matched = true;
      fragment.append(document.createTextNode(text.slice(lastIndex, index)));
      const link = document.createElement('a');
      link.className = 'msl-wikilink';
      link.href = '#';
      link.dataset.notewiseWikiLink = rawTarget;
      link.textContent = displayWikiLink(rawTarget);
      fragment.append(link);
      lastIndex = index + match[0].length;
    }

    if (!matched) continue;
    fragment.append(document.createTextNode(text.slice(lastIndex)));
    node.replaceWith(fragment);
  }
}

function displayWikiLink(target: string) {
  const [pathPart, alias] = target.split('|');
  return alias?.trim() || pathPart.split(/[\\/]/).pop()?.replace(/[#^].*$/, '').trim() || pathPart.trim();
}

function wikiLinkFromPoint(clientX: number, clientY: number): string | undefined {
  const range = caretRangeFromPoint(clientX, clientY);
  if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return undefined;
  const text = range.startContainer.textContent ?? '';
  const offset = range.startOffset;

  for (const match of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) return match[1]?.trim();
  }
  return undefined;
}

function caretRangeFromPoint(clientX: number, clientY: number): Range | undefined {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const range = doc.caretRangeFromPoint?.(clientX, clientY);
  if (range) return range;

  const position = doc.caretPositionFromPoint?.(clientX, clientY);
  if (!position) return undefined;
  const next = document.createRange();
  next.setStart(position.offsetNode, position.offset);
  next.collapse(true);
  return next;
}

function dockVditorToolbar(root: HTMLElement) {
  const toolbar = root.querySelector<HTMLElement>('.vditor-toolbar');
  const topbar = root.closest('.msl-card')?.querySelector<HTMLElement>('.msl-topbar');
  if (!toolbar || !topbar || topbar.querySelector('.msl-editor-toolbar-dock')) return;

  applyToolbarTooltips(toolbar);

  const dock = document.createElement('div');
  dock.className = 'msl-editor-toolbar-dock';
  dock.appendChild(toolbar);

  const spacer = topbar.querySelector('.msl-topbar__spacer');
  topbar.insertBefore(dock, spacer);
  topbar.classList.add('msl-topbar--editor-toolbar');
}

function applyToolbarTooltips(toolbar: HTMLElement) {
  const items = toolbar.querySelectorAll<HTMLElement>('[data-type], .vditor-toolbar__item');
  for (const item of Array.from(items)) {
    const type = item.dataset.type ?? item.getAttribute('data-name') ?? '';
    const label = TOOLTIP_LABELS[type] ?? item.getAttribute('aria-label') ?? item.getAttribute('title') ?? '';
    if (!label) continue;
    item.title = label;
    item.setAttribute('aria-label', label);
    const button = item.querySelector<HTMLElement>('button, .vditor-tooltipped, .vditor-icon');
    if (button) {
      button.title = label;
      button.setAttribute('aria-label', label);
    }
  }
}

function mountTableTools(root: HTMLElement, getMarkdown: () => string, onApplied: () => void) {
  const ir = root.querySelector<HTMLElement>('.vditor-ir');
  if (!ir || ir.querySelector('.msl-table-tools')) return;

  const tools = document.createElement('div');
  tools.className = 'msl-table-tools';
  tools.innerHTML = `
    <button type="button" data-action="align-left" title="Align left">L</button>
    <button type="button" data-action="align-center" title="Align center">C</button>
    <button type="button" data-action="align-right" title="Align right">R</button>
    <span></span>
    <button type="button" data-action="row-before" title="Insert row above">+R↑</button>
    <button type="button" data-action="row-after" title="Insert row below">+R↓</button>
    <button type="button" data-action="col-before" title="Insert column left">+C←</button>
    <button type="button" data-action="col-after" title="Insert column right">+C→</button>
    <span></span>
    <button type="button" data-action="delete-row" title="Delete row">-R</button>
    <button type="button" data-action="delete-col" title="Delete column">-C</button>
  `;
  ir.appendChild(tools);

  let activeCell: HTMLTableCellElement | null = null;
  let activeTableIndex = -1;
  root.addEventListener('click', (event) => {
    const cell = (event.target as HTMLElement | null)?.closest('td,th') as HTMLTableCellElement | null;
    if (!cell || !root.contains(cell)) {
      tools.classList.remove('msl-table-tools--visible');
      activeCell = null;
      return;
    }
    activeCell = cell;
    // Capture which table was clicked while the cell is still attached — the IR
    // reconciler may swap the table element out before a tools button is pressed.
    activeTableIndex = editableTables(ir).indexOf(cell.closest('table') as HTMLTableElement);
    const irRect = ir.getBoundingClientRect();
    const rect = cell.getBoundingClientRect();
    tools.style.left = `${Math.max(8, rect.left - irRect.left)}px`;
    tools.style.top = `${Math.max(8, rect.top - irRect.top + ir.scrollTop - 30)}px`;
    tools.classList.add('msl-table-tools--visible');
  });

  tools.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest('button');
    if (!button || !activeCell) return;
    event.preventDefault();
    const table = activeCell.closest('table');
    if (!table) return;

    const action = button.dataset.action ?? '';
    const rows = Array.from(table.rows);
    const rowIndex = activeCell.parentElement ? rows.indexOf(activeCell.parentElement as HTMLTableRowElement) : -1;
    const colIndex = activeCell.cellIndex;
    if (rowIndex < 0 || colIndex < 0) return;

    const transformed = transformMarkdownTableAt(getMarkdown(), activeTableIndex, action, rowIndex, colIndex);
    if (!transformed) {
      sendInfo('표 소스를 찾지 못했습니다. 표 안에서 한 번 더 클릭한 뒤 시도해 주세요.');
      return;
    }
    // vditor's programmatic setValue renders with enableInput:false, so the
    // options.input callback never fires — without onApplied the transform would
    // live only in the webview DOM and never reach the host document.
    getCurrentVditor()?.setValue(transformed);
    onApplied();
  });
}

/** Tables in the editable IR content, in document order (rendered previews excluded). */
function editableTables(ir: HTMLElement): HTMLTableElement[] {
  return Array.from(ir.querySelectorAll<HTMLTableElement>('table')).filter(
    (table) => !table.closest('.vditor-ir__preview')
  );
}

/**
 * Rewrites the markdown source of the table at `tableIndex` (counting tables the
 * same way the DOM renders them, so fenced code blocks don't shift the index).
 */
function transformMarkdownTableAt(
  markdown: string,
  tableIndex: number,
  action: string,
  rowIndex: number,
  colIndex: number
): string | null {
  if (tableIndex < 0) return null;
  const lines = markdown.split(/\r?\n/);
  let seen = 0;
  let fenceMarker: string | null = null;
  for (let index = 0; index < lines.length - 1; index++) {
    const fence = lines[index].trim().match(/^(`{3,}|~{3,})/)?.[1];
    if (fence) {
      if (!fenceMarker) fenceMarker = fence[0];
      else if (fence[0] === fenceMarker) fenceMarker = null;
      continue;
    }
    if (fenceMarker) continue;
    if (!looksLikeTableRow(lines[index]) || !isTableSeparator(lines[index + 1])) continue;
    const start = index;
    let end = index + 1;
    while (end + 1 < lines.length && looksLikeTableRow(lines[end + 1])) end++;

    if (seen === tableIndex) {
      const next = transformMarkdownTable(lines.slice(start, end + 1), action, rowIndex, colIndex);
      if (!next) return null;
      return [...lines.slice(0, start), ...next, ...lines.slice(end + 1)].join('\n');
    }
    seen++;
    index = end;
  }
  return null;
}

function transformMarkdownTable(lines: string[], action: string, visualRowIndex: number, colIndex: number): string[] | null {
  const rows = lines.map(splitTableRow);
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalRows = rows.map((row) => padRow(row, columnCount));
  const bodyIndex = Math.max(0, visualRowIndex - 1);
  const sourceRowIndex = visualRowIndex === 0 ? 0 : bodyIndex + 2;

  if (action.startsWith('align-')) {
    const separator = normalRows[1] ?? [];
    separator[colIndex] = action === 'align-center' ? ':---:' : action === 'align-right' ? '---:' : ':---';
  } else if (action === 'row-before' || action === 'row-after') {
    const insertAt = Math.max(2, sourceRowIndex + (action === 'row-after' ? 1 : 0));
    normalRows.splice(insertAt, 0, Array(columnCount).fill(''));
  } else if (action === 'delete-row') {
    if (sourceRowIndex < 2 || normalRows.length <= 3) return null;
    normalRows.splice(sourceRowIndex, 1);
  } else if (action === 'col-before' || action === 'col-after') {
    const insertAt = colIndex + (action === 'col-after' ? 1 : 0);
    for (const row of normalRows) row.splice(insertAt, 0, row === normalRows[1] ? '---' : '');
  } else if (action === 'delete-col') {
    if (columnCount <= 1) return null;
    for (const row of normalRows) row.splice(colIndex, 1);
  } else {
    return null;
  }

  return normalRows.map(formatTableRow);
}

function looksLikeTableRow(text: string): boolean {
  return text.includes('|') && text.trim().length > 0;
}

function isTableSeparator(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.includes('-')) return false;
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(trimmed);
}

function splitTableRow(text: string): string[] {
  let trimmed = text.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function padRow(row: string[], size: number): string[] {
  const next = [...row];
  while (next.length < size) next.push('');
  return next;
}

function formatTableRow(row: string[]): string {
  return `| ${row.join(' | ')} |`;
}

interface FindTextSegment {
  node: Text;
  start: number;
  length: number;
}

/**
 * Ctrl/Cmd+F in-page search over the editable note content. Matches are painted
 * with the CSS Custom Highlight API, which styles ranges without touching the
 * DOM — inserting highlight spans into the contenteditable would be reconciled
 * straight into the markdown by vditor. The chord is consumed in the capture
 * phase so the VS Code keybinding service never sees it (Tab/Ctrl+B technique).
 */
function mountFindBar(root: HTMLElement): () => void {
  const host = root.querySelector<HTMLElement>('.msl-vditor-host') ?? root;
  host.querySelector('.msl-find-bar')?.remove();

  const bar = document.createElement('div');
  bar.className = 'msl-find-bar';
  bar.innerHTML = `
    <input type="text" class="msl-find-input" placeholder="Find" spellcheck="false">
    <span class="msl-find-count">0/0</span>
    <button type="button" data-find="prev" title="Previous match (Shift+Enter)">↑</button>
    <button type="button" data-find="next" title="Next match (Enter)">↓</button>
    <button type="button" data-find="close" title="Close (Escape)">✕</button>
  `;
  host.appendChild(bar);
  const input = bar.querySelector<HTMLInputElement>('.msl-find-input');
  const counter = bar.querySelector<HTMLElement>('.msl-find-count');
  if (!input || !counter) return () => bar.remove();

  const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

  let open = false;
  let matches: Range[] = [];
  let current = -1;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const collectMatches = (query: string): Range[] => {
    // vditor keeps hidden .vditor-reset elements for its other modes around, so
    // the IR editable must be addressed through its .vditor-ir container.
    const editable = root.querySelector<HTMLElement>('.vditor-ir .vditor-reset');
    if (!editable || !query) return [];

    // Concatenate the *visible* text nodes into one haystack so matches may span
    // inline formatting boundaries (e.g. a bolded word inside the phrase).
    // Hidden IR marker text (collapsed `**`, link URLs, …) is skipped so what
    // you see is what you match; block boundaries get a '\n' separator so a
    // paragraph's last word never fuses with the next paragraph's first.
    const segments: FindTextSegment[] = [];
    let haystack = '';
    let lastBlock: Element | null = null;
    const visibilityCache = new Map<HTMLElement, boolean>();
    const isVisible = (el: HTMLElement): boolean => {
      const cached = visibilityCache.get(el);
      if (cached !== undefined) return cached;
      const visible = el.offsetParent !== null;
      visibilityCache.set(el, visible);
      return visible;
    };

    const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? '';
      const parent = (node as Text).parentElement;
      if (!text || !parent || !isVisible(parent)) continue;
      const block = parent.closest('[data-block="0"], p, h1, h2, h3, h4, h5, h6, li, td, th, pre');
      if (lastBlock && block !== lastBlock) haystack += '\n';
      lastBlock = block;
      segments.push({ node: node as Text, start: haystack.length, length: text.length });
      haystack += text;
    }

    const ranges: Range[] = [];
    const lowered = haystack.toLowerCase();
    const needle = query.toLowerCase();
    let segmentCursor = 0;
    const segmentAt = (offset: number): FindTextSegment | undefined => {
      while (segmentCursor < segments.length && segments[segmentCursor].start + segments[segmentCursor].length <= offset) {
        segmentCursor++;
      }
      const segment = segments[segmentCursor];
      return segment && segment.start <= offset ? segment : undefined;
    };

    let at = lowered.indexOf(needle);
    while (at !== -1) {
      const startSegment = segmentAt(at);
      const savedCursor = segmentCursor;
      const endSegment = segmentAt(at + needle.length - 1);
      segmentCursor = savedCursor;
      if (startSegment && endSegment) {
        const range = document.createRange();
        range.setStart(startSegment.node, at - startSegment.start);
        range.setEnd(endSegment.node, at + needle.length - endSegment.start);
        ranges.push(range);
      }
      at = lowered.indexOf(needle, at + needle.length);
    }
    return ranges;
  };

  const applyHighlights = () => {
    if (!highlights || !HighlightCtor) return;
    if (matches.length === 0) {
      highlights.delete('msl-find-match');
      highlights.delete('msl-find-current');
      return;
    }
    highlights.set('msl-find-match', new HighlightCtor(...matches));
    const active = matches[current];
    if (active) highlights.set('msl-find-current', new HighlightCtor(active));
    else highlights.delete('msl-find-current');
  };

  const updateCount = () => {
    counter.textContent = matches.length === 0 ? '0/0' : `${current + 1}/${matches.length}`;
  };

  const revealCurrent = () => {
    const range = matches[current];
    if (range) scrollRangeIntoView(range, root);
  };

  const runSearch = (keepIndex = false) => {
    const previous = current;
    matches = collectMatches(input.value);
    current = matches.length === 0 ? -1 : keepIndex ? Math.min(Math.max(previous, 0), matches.length - 1) : 0;
    applyHighlights();
    updateCount();
    if (!keepIndex) revealCurrent();
  };

  const navigate = (direction: 1 | -1) => {
    if (matches.length === 0) return;
    current = (current + direction + matches.length) % matches.length;
    applyHighlights();
    updateCount();
    revealCurrent();
  };

  const openBar = () => {
    open = true;
    bar.classList.add('msl-find-bar--visible');
    const selection = window.getSelection();
    const selected = selection && !selection.isCollapsed ? selection.toString() : '';
    if (selected && selected.length <= 200 && !selected.includes('\n')) input.value = selected;
    input.focus();
    input.select();
    runSearch();
  };

  const closeBar = () => {
    open = false;
    bar.classList.remove('msl-find-bar--visible');
    matches = [];
    current = -1;
    highlights?.delete('msl-find-match');
    highlights?.delete('msl-find-current');
    getCurrentVditor()?.focus();
  };

  const consume = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const onGlobalKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === 'KeyF') {
      consume(event);
      openBar();
      return;
    }
    if (!open) return;
    if (event.code === 'F3') {
      consume(event);
      navigate(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.code === 'Escape') {
      consume(event);
      closeBar();
    }
  };

  const onInputKeyDown = (event: KeyboardEvent) => {
    if (event.code === 'Enter' || event.code === 'NumpadEnter') {
      consume(event);
      navigate(event.shiftKey ? -1 : 1);
    }
  };

  const onInput = () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(), 80);
  };

  const onBarClick = (event: MouseEvent) => {
    const action = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-find]')?.dataset.find;
    if (!action) return;
    event.preventDefault();
    if (action === 'prev') navigate(-1);
    else if (action === 'next') navigate(1);
    else closeBar();
  };

  // Document edits replace the text nodes our ranges point into; refresh the
  // search against the new DOM while keeping the user's position in the list.
  const observer = new MutationObserver(() => {
    if (!open || !input.value) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => runSearch(true), 150);
  });
  const editable = root.querySelector<HTMLElement>('.vditor-ir .vditor-reset');
  if (editable) observer.observe(editable, { childList: true, subtree: true, characterData: true });

  document.addEventListener('keydown', onGlobalKeyDown, true);
  input.addEventListener('keydown', onInputKeyDown);
  input.addEventListener('input', onInput);
  bar.addEventListener('click', onBarClick);

  return () => {
    document.removeEventListener('keydown', onGlobalKeyDown, true);
    observer.disconnect();
    if (searchTimer) clearTimeout(searchTimer);
    if (refreshTimer) clearTimeout(refreshTimer);
    highlights?.delete('msl-find-match');
    highlights?.delete('msl-find-current');
    bar.remove();
  };
}

/**
 * Centers a range inside every scrollable ancestor up to `boundary`, innermost
 * first (a wide table's horizontal scroller, then the note's vertical one). The
 * scroller is found from computed style instead of assumed: in IR mode it is the
 * `pre.vditor-reset` (vditor gives it `height: 100%` + `overflow: auto`), not the
 * `.vditor-ir` wrapper, which never overflows.
 */
function scrollRangeIntoView(range: Range, boundary: HTMLElement) {
  // A match whose text node a re-render replaced collapses to a 0×0 rect at the
  // viewport origin; scrolling to it would jump. The find refresh re-resolves it.
  if (range.collapsed) return;
  const margin = 40;
  for (let el = range.startContainer.parentElement; el && boundary.contains(el); el = el.parentElement) {
    const style = getComputedStyle(el);
    const rect = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    if (/auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight && (rect.top < box.top + margin || rect.bottom > box.bottom - margin)) {
      el.scrollTop += rect.top - box.top - (el.clientHeight - rect.height) / 2;
    }
    if (/auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth && (rect.left < box.left || rect.right > box.right)) {
      el.scrollLeft += rect.left - box.left - (el.clientWidth - rect.width) / 2;
    }
  }
}

function applyCssVariables(settings: EditorSettings) {
  const root = document.documentElement;
  root.style.setProperty('--msl-doc-bg', settings.palette.background);
  root.style.setProperty('--msl-doc-fg', settings.palette.foreground);
  root.style.setProperty('--msl-doc-muted', settings.palette.mutedForeground);
  root.style.setProperty('--msl-doc-selection', settings.palette.selectionBackground);
  root.style.setProperty('--msl-doc-cursor', settings.palette.cursor);
  root.style.setProperty('--msl-editor-font-family', settings.fontFamily);
  root.style.setProperty('--msl-editor-font-size', `${settings.fontSize}px`);
  root.style.setProperty('--msl-editor-line-height', String(settings.lineHeight));
  root.style.setProperty('--msl-content-scale', String(settings.contentScale));
  root.style.setProperty('--msl-typography-scale', String(settings.typographyScale));
  root.style.setProperty('--msl-heading-indent-step', `${settings.indentation.headingStep || 12}px`);
  root.style.setProperty('--msl-list-indent-step', `${settings.indentation.listStep}px`);
  root.style.setProperty('--msl-quote-indent-step', `${settings.indentation.blockquoteStep}px`);
  root.style.setProperty('--msl-cursor', settings.palette.cursor || settings.stageColors.headings[0] || '#ff6f61');
  root.dataset.mslTheme = settings.palette.mode;
  applyCustomCss(settings.customCss);

  for (let index = 0; index < 6; index++) {
    root.style.setProperty(`--msl-heading-${index + 1}-color`, settings.stageColors.headings[index] ?? settings.stageColors.headings[0]);
    root.style.setProperty(`--msl-list-${index}-color`, settings.stageColors.lists[index] ?? settings.stageColors.lists[0]);
    root.style.setProperty(`--msl-quote-${index}-color`, settings.stageColors.blockquotes[index] ?? settings.stageColors.blockquotes[0]);
  }
}

function scheduleHeadingPresentation(root: ParentNode) {
  const target = root || document;
  const run = () => applyHeadingPresentation(target);
  requestAnimationFrame(run);
  setTimeout(run, 60);
  setTimeout(run, 180);
}

function applyHeadingPresentation(root: ParentNode) {
  if (!root?.querySelectorAll) return;
  const colors = getHeadingColors();
  const blocks = new Map<HTMLElement, number>();

  root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach((element) => {
    const level = Number(element.tagName.slice(1));
    if (level >= 1 && level <= 6) blocks.set(element, level);
  });

  root.querySelectorAll<HTMLElement>('.vditor-ir__marker--heading,[data-type="heading-marker"]').forEach((marker) => {
    const markerText = marker.textContent || '';
    const level = Math.max(1, Math.min(6, (markerText.match(/#/g) || []).length || 1));
    const block = marker.closest<HTMLElement>('h1,h2,h3,h4,h5,h6,[data-block="0"],p,div');
    if (block) blocks.set(block, level);
  });

  for (const [element, level] of blocks) {
    applyHeadingColor(element, level, colors[level - 1]);
  }
}

function getHeadingColors() {
  const fallback = ['#ff7af2', '#ffcc3d', '#22d3ee', '#8bd450', '#c4b5fd', '#f5a524'];
  const styles = getComputedStyle(document.documentElement);
  return fallback.map((color, index) => styles.getPropertyValue(`--msl-heading-${index + 1}-color`).trim() || color);
}

function applyHeadingColor(element: HTMLElement, level: number, color: string) {
  element.dataset.notewiseHeadingLevel = String(level);
  element.style.setProperty('color', color, 'important');
  if (/^H[1-6]$/.test(element.tagName)) {
    const indent = Math.max(0, level - 2);
    element.style.setProperty(
      'margin-left',
      indent > 0 ? `calc(var(--msl-heading-indent-step, 12px) * ${indent})` : '0',
      'important'
    );
  }
  element.querySelectorAll<HTMLElement>('*').forEach((child) => {
    child.style.setProperty('color', color, 'important');
  });
}

function applyCustomCss(css: string) {
  let style = document.getElementById('msl-custom-css') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'msl-custom-css';
    document.head.appendChild(style);
  }
  style.textContent = css;
}

export function injectChromeStyles() {
  if (chromeStylesInjected) return;
  chromeStylesInjected = true;

  const style = document.createElement('style');
  style.id = 'msl-chrome-styles';
  style.textContent = `
:root {
  color-scheme: dark;
  --msl-shell-bg: var(--vscode-editor-background, #101112);
  --msl-card-bg: var(--vscode-editor-background, var(--msl-doc-bg, #1b1b1d));
  --msl-doc-surface: color-mix(in srgb, var(--msl-card-bg) 94%, white 6%);
  --msl-doc-rule: rgba(255,255,255,0.11);
  --msl-doc-rule-soft: rgba(255,255,255,0.07);
  --msl-doc-table-header: rgba(255,255,255,0.045);
  --msl-doc-table-hover: rgba(255,255,255,0.035);
  --msl-link-color: #ff9a7a;
  --msl-link-hover: #ffb08f;
  --msl-topbar-bg: #252527;
  --msl-menu-bg: #252527;
  --msl-border: rgba(255,255,255,0.105);
  --msl-soft-border: rgba(255,255,255,0.075);
}
:root[data-msl-theme="white"] {
  color-scheme: light;
  --msl-shell-bg: var(--vscode-editor-background, #f3f3f1);
  --msl-card-bg: var(--vscode-editor-background, var(--msl-doc-bg, #ffffff));
  --msl-doc-surface: color-mix(in srgb, var(--msl-card-bg) 96%, black 4%);
  --msl-doc-rule: rgba(0,0,0,0.14);
  --msl-doc-rule-soft: rgba(0,0,0,0.08);
  --msl-doc-table-header: rgba(0,0,0,0.045);
  --msl-doc-table-hover: rgba(0,0,0,0.03);
  --msl-link-color: #b84d36;
  --msl-link-hover: #8f3428;
  --msl-topbar-bg: #f6f6f4;
  --msl-menu-bg: #ffffff;
  --msl-border: rgba(0,0,0,0.12);
  --msl-soft-border: rgba(0,0,0,0.08);
}
html, body {
  margin: 0;
  height: 100%;
  background: var(--msl-shell-bg);
  color: var(--msl-doc-fg, var(--vscode-editor-foreground, #cccfd6));
}
body {
  box-sizing: border-box;
  padding: 12px;
  overflow: hidden;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
}
#app { height: 100%; }
.msl-card {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
  background: var(--msl-card-bg);
  border: 1px solid var(--msl-border);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 10px 30px rgba(0,0,0,0.28);
}
:root[data-msl-theme="white"] .msl-card {
  box-shadow: 0 10px 30px rgba(0,0,0,0.10);
}
:root[data-msl-theme="white"] .msl-menu {
  box-shadow: 0 16px 40px rgba(0,0,0,0.14);
}
.msl-topbar {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  height: 34px;
  padding: 0 14px;
  border-bottom: 1px solid var(--msl-soft-border);
  background: var(--msl-topbar-bg);
  font-family: var(--msl-editor-font-family, var(--vscode-font-family, system-ui, sans-serif));
  font-size: 12px;
  user-select: none;
  z-index: 5;
}
.msl-topbar__brand { display: flex; align-items: center; gap: 6px; min-width: 132px; max-width: 34%; flex: 0 1 auto; overflow: hidden; font-size: 12px; }
.msl-topbar__dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: var(--msl-heading-1-color, #ff6f61); }
.msl-topbar__folder { flex: 0 0 auto; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.msl-topbar__sep { flex: 0 0 auto; margin: 0 1px; color: var(--vscode-descriptionForeground); }
.msl-topbar__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; letter-spacing: -0.01em; color: var(--vscode-foreground); }
.msl-topbar__spacer { flex: 1 1 auto; }
.msl-topbar--editor-toolbar .msl-topbar__spacer { display: none; }
.msl-editor-toolbar-dock {
  display: flex;
  align-items: center;
  min-width: 80px;
  flex: 1 1 auto;
  height: 28px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.msl-editor-toolbar-dock::-webkit-scrollbar { display: none; }
.msl-editor-toolbar-dock .vditor-toolbar {
  position: static !important;
  display: flex !important;
  align-items: center !important;
  gap: 2px !important;
  width: max-content !important;
  min-width: max-content !important;
  height: 28px !important;
  margin: 0 !important;
  padding: 0 6px !important;
  border: 0 !important;
  background: transparent !important;
  overflow: visible !important;
}
.msl-editor-toolbar-dock .vditor-toolbar::before,
.msl-editor-toolbar-dock .vditor-toolbar::after { display: none !important; }
.msl-editor-toolbar-dock .vditor-toolbar__item,
.msl-editor-toolbar-dock .vditor-toolbar__item .vditor-tooltipped,
.msl-editor-toolbar-dock .vditor-toolbar button,
.msl-editor-toolbar-dock .vditor-icon {
  display: grid !important;
  place-items: center !important;
  width: 24px !important;
  min-width: 24px !important;
  height: 24px !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 6px !important;
  color: var(--vscode-descriptionForeground, #b8bcc6) !important;
  background: transparent !important;
  opacity: 1 !important;
  box-sizing: border-box !important;
  float: none !important;
  font-size: 0 !important;
  line-height: 1 !important;
}
.msl-editor-toolbar-dock .vditor-toolbar__item:hover,
.msl-editor-toolbar-dock .vditor-toolbar__item .vditor-tooltipped:hover,
.msl-editor-toolbar-dock .vditor-toolbar button:hover {
  color: var(--vscode-foreground, #f0f0f0) !important;
  background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent) !important;
}
.msl-editor-toolbar-dock .vditor-toolbar__item--current,
.msl-editor-toolbar-dock .vditor-toolbar__item--active,
.msl-editor-toolbar-dock .vditor-icon--current {
  color: var(--msl-heading-1-color, #ff6f61) !important;
  background: color-mix(in srgb, var(--msl-heading-1-color, #ff6f61) 20%, transparent) !important;
}
.msl-editor-toolbar-dock .vditor-toolbar svg,
.msl-editor-toolbar-dock .vditor-icon svg {
  width: 15px !important;
  height: 15px !important;
  color: currentColor !important;
  fill: none !important;
  stroke: currentColor !important;
  stroke-width: 1.9 !important;
  stroke-linecap: round !important;
  stroke-linejoin: round !important;
  display: block !important;
  visibility: visible !important;
  opacity: 1 !important;
  float: none !important;
  pointer-events: none !important;
}
.msl-editor-toolbar-dock .vditor-toolbar svg use,
.msl-editor-toolbar-dock .vditor-icon svg use {
  color: currentColor !important;
  fill: none !important;
  stroke: currentColor !important;
  visibility: visible !important;
  opacity: 1 !important;
}
.msl-editor-toolbar-dock .msl-toolbar-icon,
.msl-editor-toolbar-dock .msl-toolbar-icon path,
.msl-editor-toolbar-dock .msl-toolbar-icon rect,
.msl-editor-toolbar-dock .msl-toolbar-icon circle {
  fill: none !important;
  stroke: currentColor !important;
  stroke-width: 1.9 !important;
  stroke-linecap: round !important;
  stroke-linejoin: round !important;
}
.msl-editor-toolbar-dock .msl-toolbar-label {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  min-width: 14px !important;
  height: 14px !important;
  color: currentColor !important;
  font-family: var(--vscode-font-family, system-ui, sans-serif) !important;
  font-size: 11px !important;
  font-weight: 750 !important;
  line-height: 1 !important;
  letter-spacing: 0 !important;
  text-transform: none !important;
  opacity: 1 !important;
  visibility: visible !important;
  pointer-events: none !important;
}
.msl-editor-toolbar-dock .msl-toolbar-label--command,
.msl-editor-toolbar-dock .vditor-toolbar__item[data-type="link"] .msl-toolbar-label,
.msl-editor-toolbar-dock .vditor-toolbar__item[data-type="list"] .msl-toolbar-label,
.msl-editor-toolbar-dock .vditor-toolbar__item[data-type="check"] .msl-toolbar-label,
.msl-editor-toolbar-dock .vditor-toolbar__item[data-type="quote"] .msl-toolbar-label,
.msl-editor-toolbar-dock .vditor-toolbar__item[data-type="upload"] .msl-toolbar-label,
.msl-editor-toolbar-dock .vditor-toolbar__item[data-type="table"] .msl-toolbar-label {
  min-width: 20px !important;
  font-size: 9.5px !important;
  font-weight: 760 !important;
}
.msl-editor-toolbar-dock .vditor-toolbar__item[data-type="bold"] .msl-toolbar-label {
  font-weight: 900 !important;
}
.msl-editor-toolbar-dock .vditor-toolbar__item[data-type="italic"] .msl-toolbar-label {
  font-style: italic !important;
}
.msl-editor-toolbar-dock .vditor-toolbar__item[data-type="ordered-list"] .msl-toolbar-label,
.msl-editor-toolbar-dock .vditor-toolbar__item[data-type="code"] .msl-toolbar-label,
.msl-editor-toolbar-dock .vditor-toolbar__item[data-type="edit-mode"] .msl-toolbar-label {
  font-size: 10px !important;
}
.msl-editor-toolbar-dock .vditor-toolbar__divider {
  width: 1px !important;
  min-width: 1px !important;
  height: 16px !important;
  margin: 0 4px !important;
  padding: 0 !important;
  background: var(--msl-soft-border) !important;
}
.msl-editor-toolbar-dock .vditor-toolbar__br { display: none !important; }
.msl-segmented { display: inline-flex; gap: 2px; padding: 2px; border-radius: 7px; background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); }
.msl-segmented__button { border: 0; border-radius: 5px; padding: 2px 8px; font: inherit; font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); background: transparent; cursor: pointer; transition: background-color .12s ease, color .12s ease; }
.msl-segmented__button:hover { color: var(--vscode-foreground); }
.msl-segmented__button--active { background: color-mix(in srgb, var(--msl-heading-1-color, #ff6f61) 26%, transparent); color: var(--vscode-foreground); }
.msl-iconbtn { display: grid; place-items: center; min-width: 26px; height: 24px; padding: 0 7px; border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent); border-radius: 7px; color: var(--vscode-descriptionForeground); background: transparent; cursor: pointer; font: inherit; font-size: 12px; font-weight: 650; transition: color .12s ease, border-color .12s ease, background-color .12s ease; }
.msl-iconbtn svg { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.msl-iconbtn:hover { color: var(--msl-heading-1-color, #ff6f61); border-color: color-mix(in srgb, var(--msl-heading-1-color, #ff6f61) 50%, transparent); }
.msl-menu { position: absolute; top: 40px; right: 14px; width: 256px; max-height: calc(100% - 54px); overflow-y: auto; overflow-x: hidden; display: none; flex-direction: column; gap: 11px; padding: 14px; border: 1px solid var(--msl-border); border-radius: 12px; background: var(--msl-menu-bg); box-shadow: 0 16px 40px rgba(0,0,0,0.32); z-index: 30; }
.msl-menu::-webkit-scrollbar { width: 8px; }
.msl-menu::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--vscode-foreground) 18%, transparent); border-radius: 4px; }
.msl-menu::-webkit-scrollbar-track { background: transparent; }
.msl-topbar--menu-open .msl-menu { display: flex; }
.msl-menu__row { display: grid; grid-template-columns: 56px 1fr; gap: 10px; align-items: center; color: var(--vscode-descriptionForeground); font-size: 12px; }
.msl-menu__row > span { font-weight: 600; }
.msl-menu select { width: 100%; min-height: 26px; border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent); border-radius: 6px; background: var(--vscode-dropdown-background, transparent); color: var(--vscode-foreground); font: inherit; font-size: 12px; cursor: pointer; }
.msl-menu input[type="range"] { width: 100%; accent-color: var(--msl-heading-1-color, #ff6f61); }
.msl-menu .msl-segmented { display: flex; width: 100%; }
.msl-menu .msl-segmented__button { flex: 1 1 0; text-align: center; }
.msl-menu__divider { height: 1px; margin: 3px 0; background: var(--msl-soft-border); }
.msl-menu__row--head { color: var(--vscode-foreground); }
.msl-menu__row--head > span { font-weight: 700; }
.msl-menu__row--swatches { align-items: center; }
.msl-color-reset { justify-self: end; border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent); border-radius: 6px; padding: 2px 10px; color: var(--vscode-descriptionForeground); background: transparent; font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; transition: color .12s ease, border-color .12s ease; }
.msl-color-reset:hover { color: var(--msl-heading-1-color, #ff6f61); border-color: color-mix(in srgb, var(--msl-heading-1-color, #ff6f61) 50%, transparent); }
.msl-menu input[type="color"].msl-color { width: 100%; height: 24px; padding: 2px; border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent); border-radius: 6px; background: transparent; cursor: pointer; box-sizing: border-box; }
.msl-menu .msl-swatches { display: flex; gap: 4px; width: 100%; }
.msl-menu input[type="color"].msl-color--swatch { flex: 1 1 0; min-width: 0; height: 22px; padding: 1px; }
.msl-menu input[type="color"].msl-color::-webkit-color-swatch-wrapper { padding: 0; }
.msl-menu input[type="color"].msl-color::-webkit-color-swatch { border: 0; border-radius: 3px; }
.msl-editor-host { flex: 1 1 auto; min-height: 0; overflow: hidden; background: var(--msl-card-bg); }
.msl-vditor-host, .vditor { height: 100%; border: 0 !important; background: transparent !important; }
.msl-editor-host > .vditor > .vditor-toolbar { display: none !important; }
.vditor-content, .vditor-ir, .vditor-wysiwyg {
  background: var(--msl-card-bg) !important;
  color: var(--msl-doc-fg, var(--vscode-editor-foreground)) !important;
}
.vditor-content {
  overflow: hidden !important;
}
.vditor-ir,
.vditor-wysiwyg {
  overflow-y: auto !important;
  scrollbar-gutter: stable;
  padding-right: 0 !important;
}
.vditor-ir::-webkit-scrollbar,
.vditor-wysiwyg::-webkit-scrollbar {
  width: 8px;
}
.vditor-ir::-webkit-scrollbar-thumb,
.vditor-wysiwyg::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
  border-radius: 4px;
}
.vditor-ir::-webkit-scrollbar-track,
.vditor-wysiwyg::-webkit-scrollbar-track {
  background: transparent;
}
.vditor-reset {
  box-sizing: border-box;
  width: 100%;
  max-width: none;
  min-height: 100%;
  margin: 0 !important;
  padding: 32px 12px 120px 38px !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  font-family: var(--msl-editor-font-family) !important;
  font-size: calc(var(--msl-editor-font-size) * var(--msl-content-scale, 1)) !important;
  line-height: var(--msl-editor-line-height) !important;
}
:root[data-msl-theme="white"] .vditor-reset {
  box-shadow: none !important;
}
.vditor-reset,
.vditor-reset p,
.vditor-reset li,
.vditor-reset td,
.vditor-reset th,
.vditor-reset div,
.vditor-ir pre,
.vditor-ir .vditor-reset {
  color: var(--msl-doc-fg, var(--vscode-editor-foreground)) !important;
}
.vditor-reset hr,
.vditor-reset blockquote,
.vditor-reset .vditor-ir__marker,
.vditor-reset .vditor-ir__node,
.vditor-ir .vditor-ir__marker,
.vditor-ir .vditor-ir__node {
  color: var(--msl-doc-muted, var(--vscode-descriptionForeground)) !important;
}
.vditor-ir,
.vditor-wysiwyg {
  caret-color: var(--msl-doc-cursor, var(--msl-cursor, #ff6f61)) !important;
}
.vditor-reset ::selection,
.vditor-ir ::selection,
.vditor-wysiwyg ::selection {
  background: var(--msl-doc-selection, rgba(255,111,97,.25)) !important;
}
.vditor-reset h1,
.vditor-reset h2,
.vditor-reset h3,
.vditor-reset h4,
.vditor-reset h5,
.vditor-reset h6 {
  margin: 1.45em 0 .62em !important;
  border: 0 !important;
  letter-spacing: 0 !important;
  line-height: 1.22 !important;
  font-weight: 780 !important;
}
.vditor-reset h1:first-child,
.vditor-reset h2:first-child,
.vditor-reset h3:first-child { margin-top: 0 !important; }
.vditor-reset h1,
.vditor-reset h1 * { color: var(--msl-heading-1-color) !important; }
.vditor-reset h2,
.vditor-reset h2 * { color: var(--msl-heading-2-color) !important; }
.vditor-reset h3,
.vditor-reset h3 * { color: var(--msl-heading-3-color) !important; }
.vditor-reset h4,
.vditor-reset h4 * { color: var(--msl-heading-4-color) !important; }
.vditor-reset h5,
.vditor-reset h5 * { color: var(--msl-heading-5-color) !important; }
.vditor-reset h6,
.vditor-reset h6 * { color: var(--msl-heading-6-color) !important; }
.vditor-ir .vditor-reset h1 .vditor-ir__node,
.vditor-ir .vditor-reset h1 .vditor-ir__marker,
.vditor-ir .vditor-reset h1 [data-type],
.vditor-wysiwyg .vditor-reset h1 [data-type] { color: var(--msl-heading-1-color) !important; }
.vditor-ir .vditor-reset h2 .vditor-ir__node,
.vditor-ir .vditor-reset h2 .vditor-ir__marker,
.vditor-ir .vditor-reset h2 [data-type],
.vditor-wysiwyg .vditor-reset h2 [data-type] { color: var(--msl-heading-2-color) !important; }
.vditor-ir .vditor-reset h3 .vditor-ir__node,
.vditor-ir .vditor-reset h3 .vditor-ir__marker,
.vditor-ir .vditor-reset h3 [data-type],
.vditor-wysiwyg .vditor-reset h3 [data-type] { color: var(--msl-heading-3-color) !important; }
.vditor-ir .vditor-reset h4 .vditor-ir__node,
.vditor-ir .vditor-reset h4 .vditor-ir__marker,
.vditor-ir .vditor-reset h4 [data-type],
.vditor-wysiwyg .vditor-reset h4 [data-type] { color: var(--msl-heading-4-color) !important; }
.vditor-ir .vditor-reset h5 .vditor-ir__node,
.vditor-ir .vditor-reset h5 .vditor-ir__marker,
.vditor-ir .vditor-reset h5 [data-type],
.vditor-wysiwyg .vditor-reset h5 [data-type] { color: var(--msl-heading-5-color) !important; }
.vditor-ir .vditor-reset h6 .vditor-ir__node,
.vditor-ir .vditor-reset h6 .vditor-ir__marker,
.vditor-ir .vditor-reset h6 [data-type],
.vditor-wysiwyg .vditor-reset h6 [data-type] { color: var(--msl-heading-6-color) !important; }
.vditor-reset h1 { margin-left: 0 !important; font-size: calc(var(--msl-editor-font-size) * var(--msl-content-scale, 1) * var(--msl-typography-scale) * 2.02) !important; }
.vditor-reset h2 { margin-left: 0 !important; font-size: calc(var(--msl-editor-font-size) * var(--msl-content-scale, 1) * var(--msl-typography-scale) * 1.62) !important; }
.vditor-reset h3 { margin-left: var(--msl-heading-indent-step, 12px) !important; font-size: calc(var(--msl-editor-font-size) * var(--msl-content-scale, 1) * var(--msl-typography-scale) * 1.34) !important; }
.vditor-reset h4 { margin-left: calc(var(--msl-heading-indent-step, 12px) * 2) !important; font-size: calc(var(--msl-editor-font-size) * var(--msl-content-scale, 1) * var(--msl-typography-scale) * 1.14) !important; }
.vditor-reset h5 { margin-left: calc(var(--msl-heading-indent-step, 12px) * 3) !important; font-size: calc(var(--msl-editor-font-size) * var(--msl-content-scale, 1) * var(--msl-typography-scale) * 1.02) !important; }
.vditor-reset h6 { margin-left: calc(var(--msl-heading-indent-step, 12px) * 4) !important; font-size: calc(var(--msl-editor-font-size) * var(--msl-content-scale, 1) * var(--msl-typography-scale) * .94) !important; text-transform: uppercase; }
.vditor-reset p,
.vditor-reset ul,
.vditor-reset ol,
.vditor-reset blockquote,
.vditor-reset table,
.vditor-reset pre {
  margin-top: .75em !important;
  margin-bottom: .9em !important;
}
.vditor-reset a {
  color: var(--msl-link-color) !important;
  text-decoration: none !important;
  border-bottom: 1px solid color-mix(in srgb, var(--msl-link-color) 38%, transparent);
}
.vditor-reset a:hover {
  color: var(--msl-link-hover) !important;
  border-bottom-color: color-mix(in srgb, var(--msl-link-hover) 62%, transparent);
}
.vditor-reset a.msl-wikilink {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  padding: 0 .2em;
  border: 1px solid color-mix(in srgb, var(--msl-link-color) 26%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--msl-link-color) 10%, transparent);
  color: var(--msl-link-color) !important;
  font-weight: 650;
}
.vditor-reset a.msl-wikilink:hover {
  background: color-mix(in srgb, var(--msl-link-hover) 16%, transparent);
  color: var(--msl-link-hover) !important;
}
.msl-editor-host.msl-wikilink-hovering .vditor-ir,
.msl-editor-host.msl-wikilink-hovering .vditor-wysiwyg {
  cursor: pointer;
}
::highlight(notewise-wikilink-raw) {
  color: var(--msl-link-color);
  background-color: color-mix(in srgb, var(--msl-link-color) 12%, transparent);
  text-decoration-line: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}
.vditor-hint .msl-wikilink-hint__title {
  display: block;
  font-weight: 650;
}
.vditor-hint .msl-wikilink-hint__detail {
  display: block;
  margin-top: 2px;
  color: var(--vscode-descriptionForeground);
  font-size: 10px;
}
.vditor-reset blockquote {
  padding: .35em 0 .35em 1em !important;
  border-left: 2px solid color-mix(in srgb, var(--msl-doc-muted, #8f949e) 70%, transparent) !important;
  border-radius: 0 !important;
  background: transparent !important;
  color: var(--msl-doc-fg, var(--vscode-editor-foreground)) !important;
}
.vditor-reset blockquote p,
.vditor-reset blockquote li {
  color: var(--msl-doc-fg, var(--vscode-editor-foreground)) !important;
}
.vditor-reset table {
  /* Vditor turns tables into display:block for scrollability, so cells keep their
     intrinsic width while width:100% would stretch only the border box — size the
     box to its content instead, and scroll inside it when wider than the page. */
  width: max-content !important;
  max-width: 100% !important;
  border-collapse: separate !important;
  border-spacing: 0 !important;
  overflow-x: auto;
  overflow-y: hidden;
  border: 1px solid var(--msl-doc-rule) !important;
  border-radius: 9px;
  font-size: .95em;
}
/* Vditor's content-theme stylesheet (e.g. dark.css) paints row backgrounds; if it
   gets out of sync with the palette the table turns dark on a light page. The
   extension owns table chrome, so pin row backgrounds to the card regardless. */
.vditor-reset table tr,
.vditor-reset table tbody tr:nth-child(2n) {
  background: transparent !important;
}
.vditor-reset th,
.vditor-reset td {
  padding: 8px 10px !important;
  border-right: 1px solid var(--msl-doc-rule-soft) !important;
  border-bottom: 1px solid var(--msl-doc-rule-soft) !important;
  vertical-align: top;
}
.vditor-reset th:last-child,
.vditor-reset td:last-child { border-right: 0 !important; }
.vditor-reset tr:last-child > th,
.vditor-reset tr:last-child > td { border-bottom: 0 !important; }
.vditor-reset th {
  background: var(--msl-doc-table-header) !important;
  color: var(--msl-doc-fg, var(--vscode-editor-foreground)) !important;
  font-weight: 720 !important;
}
.vditor-reset tr:hover > td {
  background: var(--msl-doc-table-hover) !important;
}
.vditor-reset code:not(pre code),
.vditor-reset p code:not(.hljs):not(.highlight-chroma),
.vditor-reset li code:not(.hljs):not(.highlight-chroma),
.vditor-reset td code:not(.hljs):not(.highlight-chroma),
.vditor-reset th code:not(.hljs):not(.highlight-chroma),
.vditor-reset blockquote code:not(.hljs):not(.highlight-chroma) {
  padding: 0 .24em !important;
  border: 0 !important;
  border-radius: 3px !important;
  background: color-mix(in srgb, var(--msl-doc-fg, #e8eaed) 8%, transparent) !important;
  color: var(--msl-doc-fg, var(--vscode-editor-foreground)) !important;
  font-family: inherit !important;
  font-size: 1em !important;
  font-weight: inherit !important;
  line-height: 1.08 !important;
  vertical-align: baseline !important;
}
.vditor-reset pre {
  border: 1px solid color-mix(in srgb, var(--msl-doc-fg, #e8eaed) 13%, transparent) !important;
  border-radius: 9px !important;
  background: #2a2b2f !important;
  color: #f1f3f4 !important;
}
.vditor-reset pre > code,
.vditor-reset pre code,
.vditor-reset pre code.hljs,
.vditor-reset pre .hljs,
.vditor-reset .hljs {
  background: transparent !important;
  color: #f1f3f4 !important;
  font-size: 1em !important;
}
/* The bundled highlight.js theme renders string/number tokens in dark navy
   (#032f62 / #005cc5), which is nearly invisible on the dark code background.
   Brighten them so quoted literals stay readable. */
.vditor-reset pre .hljs-string,
.vditor-reset pre .hljs-string *,
.vditor-reset .hljs-string,
.vditor-reset pre .hljs-meta .hljs-string {
  color: #98c379 !important;
}
.vditor-reset pre .hljs-number,
.vditor-reset pre .hljs-literal,
.vditor-reset .hljs-number,
.vditor-reset .hljs-literal {
  color: #6cb6ff !important;
}
.vditor-panel { z-index: 40; }
.msl-table-tools { position: absolute; display: none; align-items: center; gap: 2px; padding: 3px; border: 1px solid var(--msl-border); border-radius: 7px; background: var(--msl-menu-bg); box-shadow: 0 8px 24px rgba(0,0,0,.28); z-index: 50; }
.msl-table-tools--visible { display: flex; }
.msl-table-tools button { height: 22px; min-width: 24px; border: 0; border-radius: 5px; padding: 0 5px; color: var(--vscode-foreground); background: transparent; font: 600 10px var(--vscode-font-family); cursor: pointer; }
.msl-table-tools button:hover { background: color-mix(in srgb, var(--msl-heading-1-color, #ff6f61) 22%, transparent); }
.msl-table-tools span { width: 1px; height: 14px; background: var(--msl-soft-border); }
.msl-vditor-host { position: relative; }
.msl-find-bar { position: absolute; top: 8px; right: 18px; display: none; align-items: center; gap: 4px; padding: 4px 6px; border: 1px solid var(--msl-border); border-radius: 8px; background: var(--msl-menu-bg); box-shadow: 0 8px 24px rgba(0,0,0,.28); z-index: 60; }
.msl-find-bar--visible { display: flex; }
.msl-find-input { width: 190px; height: 24px; border: 1px solid var(--msl-soft-border); border-radius: 5px; padding: 0 8px; color: var(--vscode-foreground); background: transparent; font: 12px var(--vscode-font-family); outline: none; }
.msl-find-input:focus { border-color: color-mix(in srgb, var(--msl-heading-1-color, #ff6f61) 55%, transparent); }
.msl-find-count { min-width: 38px; text-align: center; color: var(--vscode-descriptionForeground, #9a9a9a); font: 11px var(--vscode-font-family); }
.msl-find-bar button { height: 24px; min-width: 24px; border: 0; border-radius: 5px; padding: 0; color: var(--vscode-foreground); background: transparent; font: 600 12px var(--vscode-font-family); cursor: pointer; }
.msl-find-bar button:hover { background: color-mix(in srgb, var(--msl-heading-1-color, #ff6f61) 22%, transparent); }
::highlight(msl-find-match) { background-color: rgba(255, 204, 61, 0.4); }
::highlight(msl-find-current) { background-color: rgba(255, 111, 97, 0.65); }
`;
  document.head.appendChild(style);
}
