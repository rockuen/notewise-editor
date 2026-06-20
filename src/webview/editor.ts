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
let vditorCdnUri = '';
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
  onLocalChange: (content: string) => void
): NoteWiseEditorView {
  applyCssVariables(settings);
  let visibleDocument = splitYamlFrontmatter(content);
  parent.innerHTML = '<div class="msl-vditor-host"></div>';
  const host = parent.querySelector<HTMLElement>('.msl-vditor-host');
  if (!host) throw new Error('Missing Vditor host.');
  let detachTabIndentHandling: (() => void) | undefined;

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
      parse(element: HTMLElement) {
        decorateWikiLinks(element);
      },
      theme: {
        current: settings.palette.mode === 'black' ? 'dark' : 'light',
      },
    },
    theme: settings.palette.mode === 'black' ? 'dark' : 'classic',
    toolbar: createToolbar(),
    hint: createWikiLinkHint(documentInfo.wikiLinks),
    input(value: string) {
      if (applyingRemoteUpdate) return;
      scheduleWikiLinkDecorations(parent);
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
      patchLinkOpening(parent);
      dockVditorToolbar(parent);
      mountTableTools(parent, () => vditor.getValue());
      detachTabIndentHandling?.();
      detachTabIndentHandling = patchTabIndentHandling(parent, vditor, () => {
        scheduleWikiLinkDecorations(parent);
        onLocalChange(joinYamlFrontmatter(visibleDocument.frontmatter, vditor.getValue()));
      });
      scheduleWikiLinkDecorations(parent);
      vditor.focus();
    },
  });
  currentVditor = vditor;

  return {
    dom: parent,
    getValue: () => joinYamlFrontmatter(visibleDocument.frontmatter, vditor.getValue()),
    setValue: (next) => {
      const split = splitYamlFrontmatter(next);
      if (visibleDocument.frontmatter === split.frontmatter && vditor.getValue() === split.body) return;
      visibleDocument = split;
      applyingRemoteUpdate = true;
      try {
        vditor.setValue(split.body);
        scheduleWikiLinkDecorations(parent);
      } finally {
        applyingRemoteUpdate = false;
      }
    },
    insertValue: (next) => vditor.insertValue(next),
    focus: () => vditor.focus(),
    destroy: () => {
      if (currentVditor === vditor) currentVditor = undefined;
      detachTabIndentHandling?.();
      detachTabIndentHandling = undefined;
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
}

export function applyEditorSettings(_view: NoteWiseEditorView, settings: EditorSettings) {
  applyCssVariables(settings);
  const vditorRoot = document.querySelector<HTMLElement>('.vditor');
  if (vditorRoot) {
    vditorRoot.classList.toggle('vditor--dark', settings.palette.mode === 'black');
  }
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
      break;
    case 'list':
      if (typeof index === 'number') root.style.setProperty(`--msl-list-${index}-color`, value);
      break;
    case 'quote':
      if (typeof index === 'number') root.style.setProperty(`--msl-quote-${index}-color`, value);
      break;
  }
}

function createToolbar(): any[] {
  const tool = (name: string, tipPosition = 's') => ({
    name,
    tipPosition,
    tip: TOOLTIP_LABELS[name] ?? name,
    icon: TOOLBAR_ICONS[name] ?? icon('circle'),
  });

  return [
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

function icon(name: string): string {
  return `<svg class="msl-toolbar-icon msl-toolbar-icon--${name}" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><use href="#msl-icon-${name}"></use></svg>`;
}

const TOOLBAR_ICONS: Record<string, string> = {
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
      event.preventDefault();
      sendOpenLink(anchor.getAttribute('href') ?? anchor.href);
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

function patchTabIndentHandling(root: HTMLElement, vditor: Vditor, afterCommand: () => void): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isPlainTabKey(event)) return;

    const target = event.target as Element | null;
    if (!target || !root.contains(target)) return;
    if (!target.closest('.vditor-ir, .vditor-wysiwyg')) return;
    if (target.closest('select, textarea, button, .vditor-hint, .msl-table-tools')) return;

    const listItem = getActiveListItem(root, target);
    if (!listItem) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    ensureSelectionInListItem(vditor, listItem);
    if (runVditorToolbarCommand(vditor, event.shiftKey ? 'outdent' : 'indent')) {
      window.setTimeout(afterCommand, 0);
    }
  };

  root.addEventListener('keydown', onKeyDown, true);
  return () => root.removeEventListener('keydown', onKeyDown, true);
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

function runVditorToolbarCommand(vditor: Vditor, command: 'indent' | 'outdent'): boolean {
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

function mountTableTools(root: HTMLElement, getMarkdown: () => string) {
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
  root.addEventListener('click', (event) => {
    const cell = (event.target as HTMLElement | null)?.closest('td,th') as HTMLTableCellElement | null;
    if (!cell || !root.contains(cell)) {
      tools.classList.remove('msl-table-tools--visible');
      activeCell = null;
      return;
    }
    activeCell = cell;
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

    const transformed = transformFirstMatchingMarkdownTable(getMarkdown(), action, rowIndex, colIndex);
    if (!transformed) {
      sendInfo('표 소스를 찾지 못했습니다. 표 안에서 한 번 더 클릭한 뒤 시도해 주세요.');
      return;
    }
    getCurrentVditor()?.setValue(transformed);
  });
}

function transformFirstMatchingMarkdownTable(markdown: string, action: string, rowIndex: number, colIndex: number): string | null {
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index++) {
    if (!looksLikeTableRow(lines[index]) || !isTableSeparator(lines[index + 1])) continue;
    const start = index;
    let end = index + 1;
    while (end + 1 < lines.length && looksLikeTableRow(lines[end + 1])) end++;

    const tableLines = lines.slice(start, end + 1);
    const next = transformMarkdownTable(tableLines, action, rowIndex, colIndex);
    if (!next) return null;
    return [...lines.slice(0, start), ...next, ...lines.slice(end + 1)].join('\n');
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
  root.style.setProperty('--msl-cursor', settings.palette.cursor || settings.stageColors.headings[0] || '#ff6f61');
  root.dataset.mslTheme = settings.palette.mode;
  applyCustomCss(settings.customCss);

  for (let index = 0; index < 6; index++) {
    root.style.setProperty(`--msl-heading-${index + 1}-color`, settings.stageColors.headings[index] ?? settings.stageColors.headings[0]);
    root.style.setProperty(`--msl-list-${index}-color`, settings.stageColors.lists[index] ?? settings.stageColors.lists[0]);
    root.style.setProperty(`--msl-quote-${index}-color`, settings.stageColors.blockquotes[index] ?? settings.stageColors.blockquotes[0]);
  }
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
  color-scheme: light dark;
  --msl-shell-bg: #101112;
  --msl-card-bg: #1b1b1d;
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
  --msl-shell-bg: var(--vscode-editor-background, #f3f3f3);
  --msl-card-bg: var(--vscode-editor-background, #ffffff);
  --msl-doc-surface: color-mix(in srgb, var(--msl-card-bg) 96%, #f2eadc 4%);
  --msl-doc-rule: rgba(53,45,35,0.16);
  --msl-doc-rule-soft: rgba(53,45,35,0.09);
  --msl-doc-table-header: rgba(192,57,43,0.055);
  --msl-doc-table-hover: rgba(192,57,43,0.035);
  --msl-link-color: #b84d36;
  --msl-link-hover: #8f3428;
  --msl-topbar-bg: var(--vscode-editorWidget-background, #f6f6f6);
  --msl-menu-bg: var(--vscode-editorWidget-background, #ffffff);
  --msl-border: var(--vscode-panel-border, rgba(0,0,0,0.12));
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
.vditor-reset h1 { color: var(--msl-heading-1-color) !important; font-size: calc(var(--msl-editor-font-size) * var(--msl-content-scale, 1) * var(--msl-typography-scale) * 2.02) !important; }
.vditor-reset h2 { color: var(--msl-heading-2-color) !important; font-size: calc(var(--msl-editor-font-size) * var(--msl-content-scale, 1) * var(--msl-typography-scale) * 1.62) !important; }
.vditor-reset h3 { color: var(--msl-heading-3-color) !important; font-size: calc(var(--msl-editor-font-size) * var(--msl-content-scale, 1) * var(--msl-typography-scale) * 1.34) !important; }
.vditor-reset h4 { color: var(--msl-heading-4-color) !important; font-size: calc(var(--msl-editor-font-size) * var(--msl-content-scale, 1) * var(--msl-typography-scale) * 1.14) !important; }
.vditor-reset h5 { color: var(--msl-heading-5-color) !important; font-size: calc(var(--msl-editor-font-size) * var(--msl-content-scale, 1) * var(--msl-typography-scale) * 1.02) !important; }
.vditor-reset h6 { color: var(--msl-heading-6-color) !important; font-size: calc(var(--msl-editor-font-size) * var(--msl-content-scale, 1) * var(--msl-typography-scale) * .94) !important; text-transform: uppercase; }
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
  padding: 10px 14px !important;
  border-left: 3px solid var(--msl-quote-0-color, var(--msl-heading-1-color)) !important;
  border-radius: 0 8px 8px 0 !important;
  background: color-mix(in srgb, var(--msl-heading-1-color) 7%, transparent) !important;
  color: var(--msl-doc-muted, var(--vscode-descriptionForeground)) !important;
}
.vditor-reset blockquote p,
.vditor-reset blockquote li {
  color: var(--msl-doc-muted, var(--vscode-descriptionForeground)) !important;
}
.vditor-reset table {
  width: 100%;
  border-collapse: separate !important;
  border-spacing: 0 !important;
  overflow: hidden;
  border: 1px solid var(--msl-doc-rule) !important;
  border-radius: 9px;
  font-size: .95em;
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
.vditor-reset code:not(pre code) {
  padding: .12em .38em !important;
  border: 1px solid var(--msl-doc-rule-soft);
  border-radius: 5px;
  background: color-mix(in srgb, var(--msl-doc-fg) 8%, transparent) !important;
  color: var(--msl-link-color) !important;
  font-size: 1em !important;
}
.vditor-reset pre {
  border: 1px solid var(--msl-doc-rule-soft) !important;
  border-radius: 9px !important;
  background: color-mix(in srgb, var(--msl-card-bg) 86%, black 14%) !important;
}
:root[data-msl-theme="white"] .vditor-reset pre {
  background: color-mix(in srgb, var(--msl-card-bg) 94%, #e8ddcb 6%) !important;
}
.vditor-panel { z-index: 40; }
.msl-table-tools { position: absolute; display: none; align-items: center; gap: 2px; padding: 3px; border: 1px solid var(--msl-border); border-radius: 7px; background: var(--msl-menu-bg); box-shadow: 0 8px 24px rgba(0,0,0,.28); z-index: 50; }
.msl-table-tools--visible { display: flex; }
.msl-table-tools button { height: 22px; min-width: 24px; border: 0; border-radius: 5px; padding: 0 5px; color: var(--vscode-foreground); background: transparent; font: 600 10px var(--vscode-font-family); cursor: pointer; }
.msl-table-tools button:hover { background: color-mix(in srgb, var(--msl-heading-1-color, #ff6f61) 22%, transparent); }
.msl-table-tools span { width: 1px; height: 14px; background: var(--msl-soft-border); }
`;
  document.head.appendChild(style);
}
