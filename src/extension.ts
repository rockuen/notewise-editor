import * as vscode from 'vscode';
import { selectEditorFont } from './fonts';
import { MarkdownStageLiveProvider, VIEW_TYPE } from './provider';

const { activateDateWise, deactivateDateWise } = require('./datewise') as {
  activateDateWise: (context: vscode.ExtensionContext) => void;
  deactivateDateWise?: () => void;
};

export function activate(context: vscode.ExtensionContext) {
  activateDateWise(context);

  const provider = new MarkdownStageLiveProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
      supportsMultipleEditorsPerDocument: true,
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('noteWise.editor.open', async (uri?: vscode.Uri) => {
      if (uri?.scheme === 'file') {
        await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, {
          viewColumn: vscode.ViewColumn.Active,
          preview: false,
        });
        return;
      }

      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        await vscode.window.showInformationMessage('Open a Markdown file first.');
        return;
      }

      await vscode.commands.executeCommand('vscode.openWith', activeEditor.document.uri, VIEW_TYPE, {
        viewColumn: vscode.ViewColumn.Active,
        preview: false,
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('noteWise.editor.switchEditor', async () => {
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const tabInput = activeTab?.input as { viewType?: string; uri?: vscode.Uri } | undefined;

      if (tabInput?.viewType === VIEW_TYPE && tabInput.uri) {
        await vscode.commands.executeCommand('vscode.openWith', tabInput.uri, 'default');
        return;
      }

      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        await vscode.commands.executeCommand('vscode.openWith', activeEditor.document.uri, VIEW_TYPE);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('noteWise.editor.selectFont', async () => {
      await selectEditorFont();
    })
  );
}

export function deactivate() {
  deactivateDateWise?.();
}
