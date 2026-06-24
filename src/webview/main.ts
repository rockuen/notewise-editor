import type { EditorSettings } from '../messages';
import { applyEditorSettings, createMarkdownEditor, injectChromeStyles, insertEditorText, setVditorCdnUri, type NoteWiseEditorView, updateEditorContent } from './editor';
import { mountSettingsPanel, updateSettingsPanel } from './settingsPanel';
import { onHostMessage, sendBlur, sendEdit, sendFocus, sendPasteImage, sendReady } from './sync';

let editorView: NoteWiseEditorView | undefined;
let localChangeTimer: ReturnType<typeof setTimeout> | undefined;

onHostMessage((message) => {
  switch (message.type) {
    case 'init': {
      const app = document.getElementById('app');
      if (!app) throw new Error('Missing #app mount node.');
      injectChromeStyles();
      setVditorCdnUri(message.document.vditorCdnUri);
      app.innerHTML = '';

      const card = document.createElement('div');
      card.className = 'msl-card';

      const topbar = document.createElement('div');
      topbar.className = 'msl-topbar';

      const host = document.createElement('div');
      host.className = 'msl-editor-host';

      card.append(topbar, host);
      app.appendChild(card);

      mountSettingsPanel(topbar, message.settings, message.document);
      editorView = createMarkdownEditor(host, message.content, message.settings, message.document, (content) => {
        if (localChangeTimer) clearTimeout(localChangeTimer);
        localChangeTimer = setTimeout(() => sendEdit(content), 60);
      });
      setupFocusTracking(editorView);
      setupPasteImageHandling(editorView);
      break;
    }

    case 'update':
      if (editorView) updateEditorContent(editorView, message.content);
      break;

    case 'insertText':
      if (editorView) {
        insertEditorText(editorView, message.text);
      }
      break;

    case 'settings':
      if (editorView) applyEditorSettings(editorView, normalizeSettings(message.settings));
      updateSettingsPanel(message.settings);
      break;
  }
});

function setupFocusTracking(view: NoteWiseEditorView) {
  view.dom.addEventListener('focusin', () => sendFocus());
  view.dom.addEventListener('focusout', (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (next && view.dom.contains(next)) return;
    sendBlur();
  });
}

function setupPasteImageHandling(view: NoteWiseEditorView) {
  view.dom.addEventListener('paste', (event: ClipboardEvent) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageItem = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
    if (!imageItem) return;

    const file = imageItem.getAsFile();
    if (!file) return;

    event.preventDefault();
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      sendPasteImage(reader.result, file.type || imageItem.type, file.name);
    };
    reader.readAsDataURL(file);
  });
}

function normalizeSettings(settings: EditorSettings): EditorSettings {
  return {
    ...settings,
    fontSize: clamp(settings.fontSize, 8, 48, 14),
    lineHeight: clamp(settings.lineHeight, 1.2, 2.4, 1.6),
    tabSize: clamp(settings.tabSize, 1, 8, 4),
    contentScale: clamp(settings.contentScale, 0.7, 2, 0.88),
    typographyScale: clamp(settings.typographyScale, 0.85, 2.7, 1),
  };
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

sendReady();
