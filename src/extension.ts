import * as path from 'path';
import * as vscode from 'vscode';
import { startPlayerServer } from './playerServer';
import { PlayerViewProvider } from './playerViewProvider';
import { PlayerWindow } from './playerWindow';

export async function activate(context: vscode.ExtensionContext) {
	// 포트를 알아야 player URL을 만들 수 있으므로 서버 먼저
	let server;
	try {
		server = await startPlayerServer();
	} catch (err) {
		vscode.window.showErrorMessage(`VScodetube: 로컬 플레이어 서버를 시작하지 못했어요. (${err})`);
		return;
	}
	context.subscriptions.push(server);

	// 미니 창 전용 브라우저 프로필 (사용자 기본 브라우저 프로필과 분리)
	const player = new PlayerWindow(server, path.join(context.globalStorageUri.fsPath, 'browser-profile'));
	context.subscriptions.push(player);

	const provider = new PlayerViewProvider(context, player);

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
