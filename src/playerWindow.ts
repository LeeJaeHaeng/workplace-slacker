import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PlayerServer } from './playerServer';

// VS Code 내장 Electron은 독점 코덱이 빠져 YouTube 재생이 멈추므로
// 시스템의 Edge/Chrome을 주소창 없는 앱 창(--app)으로 띄워 재생한다
export class PlayerWindow implements vscode.Disposable {
	private proc?: ChildProcess;

	constructor(
		private readonly server: PlayerServer,
		private readonly profileDir: string,
	) {}

	/** 열린 창이 있으면 영상만 교체, 없으면 새 창 */
	async show(id: string, autoplay: boolean): Promise<void> {
		if (this.server.clientCount() > 0) {
			this.server.broadcast({ type: 'play', id, autoplay });
			return;
		}
		this.kill();
		// 서버는 127.0.0.1에 바인드하지만 IP Referer는 일부 영상에서 거부되므로 localhost 사용
		const url = `http://localhost:${this.server.port}/player?v=${id}&autoplay=${autoplay ? 1 : 0}`;
		const browser = findBrowser();
		if (!browser) {
			await vscode.env.openExternal(vscode.Uri.parse(url));
			return;
		}
		const proc = spawn(browser, [
			`--app=${url}`,
			`--user-data-dir=${this.profileDir}`,
			'--window-size=480,300',
			'--autoplay-policy=no-user-gesture-required',
			'--no-first-run',
			'--no-default-browser-check',
		], { stdio: 'ignore' });
		proc.on('error', err => {
			vscode.window.showErrorMessage(`VScodetube: 브라우저를 실행하지 못했어요. (${err.message})`);
		});
		proc.on('exit', () => {
			if (this.proc === proc) {
				this.proc = undefined;
			}
		});
		this.proc = proc;
	}

	/** 재생 중지 + 창 닫기 */
	clear(): void {
		this.server.broadcast({ type: 'clear' });
		this.kill();
	}

	dispose(): void {
		this.kill();
	}

	private kill(): void {
		this.proc?.kill();
		this.proc = undefined;
	}
}

/** 설정값 → Edge → Chrome 순으로 실행 파일 탐색 */
function findBrowser(): string | undefined {
	const custom = vscode.workspace.getConfiguration('vscodetube').get<string>('browserPath', '').trim();
	if (custom) {
		return custom;
	}
	return candidates().find(p => fs.existsSync(p));
}

function candidates(): string[] {
	if (process.platform === 'win32') {
		const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]
			.filter((r): r is string => !!r);
		const rel = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe'];
		return rel.flatMap(r => roots.map(root => path.join(root, r)));
	}
	if (process.platform === 'darwin') {
		return [
			'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		];
	}
	return ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}
