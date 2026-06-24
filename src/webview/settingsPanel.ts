import type { ColorRole, DocumentInfo, EditorSettings, SyntaxVisibility, ThemeMode } from '../messages';
import { previewDocColor } from './editor';
import { sendColorReset, sendColorUpdate, sendSelectFont, sendSettingUpdate } from './sync';

let topbarRoot: HTMLElement | undefined;
let currentSettings: EditorSettings | undefined;
let colorSaveTimer: ReturnType<typeof setTimeout> | undefined;

const GEAR_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"></path>
  <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.36a1.7 1.7 0 0 0-1 .92l-.03.08a2 2 0 0 1-3.82 0l-.03-.08a1.7 1.7 0 0 0-1-.92 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.76 15a1.7 1.7 0 0 0-.92-1l-.08-.03a2 2 0 0 1 0-3.82l.08-.03a1.7 1.7 0 0 0 .92-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9.1 4.76a1.7 1.7 0 0 0 1-.92l.03-.08a2 2 0 0 1 3.82 0l.03.08a1.7 1.7 0 0 0 1 .92 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.36 9c.08.4.39.75.92 1l.08.03a2 2 0 0 1 0 3.82l-.08.03a1.7 1.7 0 0 0-.88 1.12Z"></path>
</svg>`;

/** Builds the top menu bar inside the supplied topbar element. */
export function mountSettingsPanel(topbar: HTMLElement, settings: EditorSettings, doc: DocumentInfo) {
  currentSettings = settings;
  topbarRoot = topbar;

  const breadcrumb = doc.folder
    ? `<span class="msl-topbar__folder">${escapeHtml(doc.folder)}</span><span class="msl-topbar__sep">›</span><span class="msl-topbar__name">${escapeHtml(doc.name)}</span>`
    : `<span class="msl-topbar__name">${escapeHtml(doc.name)}</span>`;

  topbar.innerHTML = `
    <div class="msl-topbar__brand" title="${escapeHtml(doc.folder ? `${doc.folder} › ${doc.name}` : doc.name)}">
      <span class="msl-topbar__dot"></span>
      ${breadcrumb}
    </div>
    <div class="msl-topbar__spacer"></div>
    <button class="msl-iconbtn" type="button" data-action="font" title="Editor font">Aa</button>
    <button class="msl-iconbtn" type="button" data-action="more" title="More settings" aria-label="More settings">${GEAR_ICON}</button>
    <section class="msl-menu" aria-label="More settings">
      <div class="msl-menu__row">
        <span>Theme</span>
        <div class="msl-segmented" data-control="theme"></div>
      </div>
      <label class="msl-menu__row">
        <span>Syntax</span>
        <select data-control="syntax">
          <option value="auto">Auto</option>
          <option value="always">Show</option>
          <option value="never">Hide</option>
        </select>
      </label>
      <label class="msl-menu__row">
        <span>Size</span>
        <input data-control="contentScale" type="range" min="0.7" max="2.0" step="0.01">
      </label>
      <label class="msl-menu__row">
        <span>Scale</span>
        <input data-control="scale" type="range" min="0.85" max="2.7" step="0.01">
      </label>
      <label class="msl-menu__row">
        <span>Lists</span>
        <input data-control="listStep" type="range" min="0" max="56" step="1">
      </label>
      <label class="msl-menu__row">
        <span>Quotes</span>
        <input data-control="quoteStep" type="range" min="0" max="56" step="1">
      </label>
      <label class="msl-menu__row">
        <span title="VS Code breadcrumbs (top path bar)">Crumbs</span>
        <select data-control="breadcrumbs">
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </label>
      <div class="msl-menu__divider"></div>
      <div class="msl-menu__row msl-menu__row--head">
        <span>Colors</span>
        <button class="msl-color-reset" type="button" data-control="resetColors" title="Reset colors to theme default">Reset</button>
      </div>
      <label class="msl-menu__row">
        <span>Text</span>
        <input class="msl-color" data-color="foreground" type="color" aria-label="Body text color">
      </label>
      <label class="msl-menu__row">
        <span title="Faded text: front matter, list markers, blockquotes">Faded</span>
        <input class="msl-color" data-color="mutedForeground" type="color" aria-label="Muted text color">
      </label>
      <div class="msl-menu__row msl-menu__row--swatches">
        <span>Heads</span>
        <div class="msl-swatches" data-control="headings"></div>
      </div>
    </section>
  `;

  topbar.querySelector('[data-action="font"]')?.addEventListener('click', () => sendSelectFont());

  const moreButton = topbar.querySelector('[data-action="more"]');
  moreButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    topbar.classList.toggle('msl-topbar--menu-open');
  });
  document.addEventListener('click', (event) => {
    if (!topbar.classList.contains('msl-topbar--menu-open')) return;
    const target = event.target as Node;
    const menu = topbar.querySelector('.msl-menu');
    if (menu?.contains(target) || moreButton?.contains(target)) return;
    topbar.classList.remove('msl-topbar--menu-open');
  });

  topbar.querySelector('[data-control="syntax"]')?.addEventListener('change', (event) => {
    sendSettingUpdate('livePreview.syntaxVisibility', (event.target as HTMLSelectElement).value as SyntaxVisibility);
  });
  topbar.querySelector('[data-control="contentScale"]')?.addEventListener('input', (event) => {
    sendSettingUpdate('ui.contentScale', Number((event.target as HTMLInputElement).value));
  });
  topbar.querySelector('[data-control="scale"]')?.addEventListener('input', (event) => {
    sendSettingUpdate('ui.typographyScale', Number((event.target as HTMLInputElement).value));
  });
  topbar.querySelector('[data-control="listStep"]')?.addEventListener('input', (event) => {
    sendSettingUpdate('indentation.listStep', Number((event.target as HTMLInputElement).value));
  });
  topbar.querySelector('[data-control="quoteStep"]')?.addEventListener('input', (event) => {
    sendSettingUpdate('indentation.blockquoteStep', Number((event.target as HTMLInputElement).value));
  });
  topbar.querySelector('[data-control="breadcrumbs"]')?.addEventListener('change', (event) => {
    sendSettingUpdate('breadcrumbs.enabled', (event.target as HTMLSelectElement).value === 'on');
  });

  const menu = topbar.querySelector('.msl-menu');
  menu?.addEventListener('input', (event) => {
    const input = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('input[data-color]');
    if (!input) return;
    const role = input.dataset.color as ColorRole;
    const index = input.dataset.index ? Number(input.dataset.index) : undefined;
    previewDocColor(role, input.value, index);
    scheduleColorSave(role, input.value, index);
  });
  topbar.querySelector('[data-control="resetColors"]')?.addEventListener('click', () => sendColorReset());

  renderHeadingSwatches();
  renderThemeButtons();
  updateSettingsPanel(settings);
}

function scheduleColorSave(role: ColorRole, value: string, index?: number) {
  if (colorSaveTimer) clearTimeout(colorSaveTimer);
  colorSaveTimer = setTimeout(() => sendColorUpdate(role, value, index), 200);
}

function renderHeadingSwatches() {
  const target = topbarRoot?.querySelector('[data-control="headings"]');
  if (!target) return;
  target.innerHTML = Array.from(
    { length: 6 },
    (_, i) =>
      `<input class="msl-color msl-color--swatch" data-color="heading" data-index="${i}" type="color" title="Heading ${i + 1}" aria-label="Heading ${i + 1} color">`
  ).join('');
}

export function updateSettingsPanel(settings: EditorSettings) {
  currentSettings = settings;
  if (!topbarRoot) return;

  setValue<HTMLSelectElement>('[data-control="syntax"]', settings.syntaxVisibility);
  setValue<HTMLInputElement>('[data-control="contentScale"]', String(settings.contentScale));
  setValue<HTMLInputElement>('[data-control="scale"]', String(settings.typographyScale));
  setValue<HTMLInputElement>('[data-control="listStep"]', String(settings.indentation.listStep));
  setValue<HTMLInputElement>('[data-control="quoteStep"]', String(settings.indentation.blockquoteStep));
  setValue<HTMLSelectElement>('[data-control="breadcrumbs"]', settings.breadcrumbsEnabled ? 'on' : 'off');

  for (const button of Array.from(topbarRoot.querySelectorAll<HTMLButtonElement>('[data-theme]'))) {
    button.classList.toggle('msl-segmented__button--active', button.dataset.theme === settings.themeMode);
  }

  setColorValue('[data-color="foreground"]', settings.palette.foreground);
  setColorValue('[data-color="mutedForeground"]', settings.palette.mutedForeground);
  const headings = settings.stageColors.headings;
  for (let i = 0; i < 6; i++) {
    setColorValue(`[data-color="heading"][data-index="${i}"]`, headings[i] ?? headings[0]);
  }
}

function renderThemeButtons() {
  const target = topbarRoot?.querySelector('[data-control="theme"]');
  if (!target) return;
  const modes: Array<{ value: ThemeMode; label: string }> = [
    { value: 'auto', label: 'Auto' },
    { value: 'black', label: 'Black' },
    { value: 'white', label: 'White' },
  ];
  target.innerHTML = modes
    .map((mode) => `<button class="msl-segmented__button" type="button" data-theme="${mode.value}">${mode.label}</button>`)
    .join('');

  for (const button of Array.from(target.querySelectorAll<HTMLButtonElement>('[data-theme]'))) {
    button.addEventListener('click', () => {
      sendSettingUpdate('theme.mode', button.dataset.theme ?? 'auto');
    });
  }
}

function setValue<T extends HTMLInputElement | HTMLSelectElement>(selector: string, value: string) {
  const element = topbarRoot?.querySelector<T>(selector);
  if (element && element.value !== value) element.value = value;
}

function setColorValue(selector: string, value: string) {
  const element = topbarRoot?.querySelector<HTMLInputElement>(selector);
  if (!element) return;
  const hex = toHexColor(value);
  if (hex && element.value !== hex) element.value = hex;
}

/** Native color inputs only accept #rrggbb. Normalize 3-digit hex and ignore other formats. */
function toHexColor(value: string): string | undefined {
  const trimmed = (value ?? '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      default:
        return '&quot;';
    }
  });
}
