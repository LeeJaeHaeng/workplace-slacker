import * as vscode from 'vscode';
import { PlayerViewProvider } from './playerViewProvider';

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('VScodetube', { log: true });
	const provider = new PlayerViewProvider(context, log);

	context.subscriptions.push(
		log,
		provider,
		vscode.window.registerWebviewViewProvider(PlayerViewProvider.viewId, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand('vscodetube.open', async () => {
			const input = await vscode.window.showInputBox({
				prompt: 'YouTube 검색어 또는 URL / video ID',
				ignoreFocusOut: true,
			});
			if (input) {
				await provider.openInput(input);
			}
		}),
		vscode.commands.registerCommand('vscodetube.back', () => provider.back()),
		vscode.commands.registerCommand('vscodetube.home', () => provider.home()),
		vscode.commands.registerCommand('vscodetube.clear', () => provider.clear()),
	);
}

export function deactivate() {}
