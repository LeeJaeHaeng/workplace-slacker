import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { parseVideoId, VIDEO_ID_RE } from './youtube';

const LAST_VIDEO_KEY = 'lastVideo';
// IP(127.0.0.1) Referer는 일부 영상에서 YouTube가 거부하므로 호스트명 사용 (서버 바인드는 127.0.0.1 유지)
const PLAYER_HOST = 'localhost';

export class PlayerViewProvider implements vscode.WebviewViewProvider {
	static readonly viewId = 'vscodetube.player';

	private view?: vscode.WebviewView;
	private videoId?: string;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly port: number,
	) {
		// 마지막 영상 복원
		if (config().get<boolean>('restoreLastVideo', true)) {
			const last = context.globalState.get<string>(LAST_VIDEO_KEY);
			if (last && VIDEO_ID_RE.test(last)) {
				this.videoId = last;
			}
		}
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = this.getHtml();
		view.onDidDispose(() => {
			if (this.view === view) {
				this.view = undefined;
			}
		});
	}

	async play(input: string): Promise<void> {
		const id = parseVideoId(input);
		if (!id) {
			vscode.window.showWarningMessage('YouTube URL을 인식하지 못했어요.');
			return;
		}
		this.videoId = id;
		await this.context.globalState.update(LAST_VIDEO_KEY, id);

		if (this.view) {
			this.view.show(true);
			await this.view.webview.postMessage({ type: 'play', src: this.playerUrl(id) });
		} else {
			// resolve 시 저장된 videoId로 렌더됨
			await vscode.commands.executeCommand(`${PlayerViewProvider.viewId}.focus`);
		}
	}

	async clear(): Promise<void> {
		this.videoId = undefined;
		await this.context.globalState.update(LAST_VIDEO_KEY, undefined);
		await this.view?.webview.postMessage({ type: 'clear' });
	}

	private playerUrl(id: string): string {
		const autoplay = config().get<boolean>('autoplay', true);
		return `http://${PLAYER_HOST}:${this.port}/player?v=${id}&autoplay=${autoplay ? 1 : 0}`;
	}

	private getHtml(): string {
		const nonce = crypto.randomBytes(16).toString('hex');
		const src = this.videoId ? this.playerUrl(this.videoId) : '';
		const hasVideo = src ? '' : ' hidden';
		const noVideo = src ? ' hidden' : '';
		return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://${PLAYER_HOST}:${this.port}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{margin:0;padding:4px}
iframe{display:block;width:100%;aspect-ratio:16/9;border:0;background:#000}
#empty{color:var(--vscode-descriptionForeground);padding:4px}
</style>
</head><body>
<iframe id="yt" src="${src}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen${hasVideo}></iframe>
<div id="empty"${noVideo}>상단 + 버튼으로 YouTube URL을 열어보세요.</div>
<script nonce="${nonce}">
const f = document.getElementById('yt');
const empty = document.getElementById('empty');
window.addEventListener('message', e => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'play')  { f.src = m.src; f.hidden = false; empty.hidden = true; }
  if (m.type === 'clear') { f.src = '';    f.hidden = true;  empty.hidden = false; }
});
</script>
</body></html>`;
	}
}

function config(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('vscodetube');
}
