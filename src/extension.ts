import * as vscode from 'vscode';
import { startPlayerServer } from './playerServer';
import { PlayerViewProvider } from './playerViewProvider';

export async function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('VScodetube', { log: true });
	context.subscriptions.push(log);

	// 포트를 알아야 player URL을 만들 수 있으므로 서버 먼저
	let server;
	try {
		server = await startPlayerServer();
	} catch (err) {
		log.error(`서버 시작 실패: ${err}`);
		vscode.window.showErrorMessage(`VScodetube: 로컬 플레이어 서버를 시작하지 못했어요. (${err})`);
		return;
	}
	context.subscriptions.push(server);
	log.info(`플레이어 서버 127.0.0.1:${server.port}`);

	const provider = new PlayerViewProvider(context, server.port, log);
	context.subscriptions.push(provider);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(PlayerViewProvider.viewId, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand('vscodetube.open', async () => {
			const input = await vscode.window.showInputBox({
				prompt: 'YouTube URL 또는 video ID',
				ignoreFocusOut: true,
			});
			if (input) {
				await provider.play(input);
			}
		}),
		vscode.commands.registerCommand('vscodetube.clear', () => provider.clear()),
	);
}

export function deactivate() {}
