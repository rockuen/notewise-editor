import type { ClientMessage, ColorRole, HostMessage } from '../messages';

interface VsCodeApi {
  postMessage(message: ClientMessage): void;
}

declare const acquireVsCodeApi: () => VsCodeApi;

const vscode = acquireVsCodeApi();
const listeners = new Set<(message: HostMessage) => void>();

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  for (const listener of listeners) {
    listener(event.data);
  }
});

export function onHostMessage(listener: (message: HostMessage) => void) {
  listeners.add(listener);
}

export function sendReady() {
  vscode.postMessage({ type: 'ready' });
}

export function sendEdit(content: string) {
  vscode.postMessage({ type: 'edit', content });
}

export function sendFocus() {
  vscode.postMessage({ type: 'focus' });
}

export function sendBlur() {
  vscode.postMessage({ type: 'blur' });
}

export function sendSelectFont() {
  vscode.postMessage({ type: 'selectFont' });
}

export function sendPasteImage(dataUrl: string, mimeType: string, name?: string) {
  vscode.postMessage({ type: 'pasteImage', dataUrl, mimeType, name });
}

export function sendSave(content: string) {
  vscode.postMessage({ type: 'save', content });
}

export function sendInfo(content: string) {
  vscode.postMessage({ type: 'info', content });
}

export function sendError(content: string) {
  vscode.postMessage({ type: 'error', content });
}

export function sendOpenLink(href: string) {
  vscode.postMessage({ type: 'openLink', href });
}

export function sendOpenWikiLink(target: string) {
  vscode.postMessage({ type: 'openWikiLink', target });
}

export function sendSettingUpdate(key: string, value: string | number | boolean) {
  vscode.postMessage({ type: 'updateSetting', key, value });
}

export function sendColorUpdate(role: ColorRole, value: string, index?: number) {
  vscode.postMessage({ type: 'updateColor', role, value, index });
}

export function sendColorReset() {
  vscode.postMessage({ type: 'resetColors' });
}
