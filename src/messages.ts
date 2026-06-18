export type SyntaxVisibility = 'auto' | 'always' | 'never';
export type ThemeMode = 'auto' | 'black' | 'white';

/** Editable document color roles. Array roles (heading/list/quote) require an index. */
export type ColorRole = 'foreground' | 'mutedForeground' | 'heading' | 'list' | 'quote';

export interface StageColors {
  headings: string[];
  lists: string[];
  blockquotes: string[];
}

export interface EditorPalette {
  mode: Exclude<ThemeMode, 'auto'>;
  background: string;
  foreground: string;
  mutedForeground: string;
  activeLine: string;
  gutterBackground: string;
  gutterForeground: string;
  selectionBackground: string;
  cursor: string;
}

export interface StageIndentation {
  headingStep: number;
  listStep: number;
  blockquoteStep: number;
}

export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  tabSize: number;
  contentScale: number;
  typographyScale: number;
  syntaxVisibility: SyntaxVisibility;
  themeMode: ThemeMode;
  breadcrumbsEnabled: boolean;
  customCss: string;
  stageColors: StageColors;
  palette: EditorPalette;
  indentation: StageIndentation;
}

export interface DocumentInfo {
  folder: string | null;
  name: string;
  resourceBaseUri: string | null;
  vditorCdnUri: string;
  wikiLinks: WikiLinkCandidate[];
}

export interface WikiLinkCandidate {
  label: string;
  target: string;
  detail: string;
}

export type HostMessage =
  | { type: 'init'; content: string; settings: EditorSettings; document: DocumentInfo }
  | { type: 'update'; content: string }
  | { type: 'settings'; settings: EditorSettings }
  | { type: 'insertText'; text: string };

export type ClientMessage =
  | { type: 'ready' }
  | { type: 'edit'; content: string }
  | { type: 'focus' }
  | { type: 'blur' }
  | { type: 'selectFont' }
  | { type: 'pasteImage'; dataUrl: string; mimeType: string; name?: string }
  | { type: 'save'; content: string }
  | { type: 'info'; content: string }
  | { type: 'error'; content: string }
  | { type: 'openLink'; href: string }
  | { type: 'openWikiLink'; target: string }
  | { type: 'updateSetting'; key: string; value: string | number | boolean }
  | { type: 'updateColor'; role: ColorRole; value: string; index?: number }
  | { type: 'resetColors' };
