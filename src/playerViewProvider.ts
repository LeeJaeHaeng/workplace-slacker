import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { PlayerWindow } from './playerWindow';
import { parseVideoId, VIDEO_ID_RE } from './youtube';

const LAST_VIDEO_KEY = 'lastVideo';

// 사이드바 뷰: 현재 영상 썸네일 + 미니 창 열기 (재생은 PlayerWindow가 담당)
export class PlayerViewProvider implements vscode.WebviewViewProvider {
	static readonly viewId = 'vscodetube.player';

	private view?: vscode.WebviewView;
	private videoId?: string;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly player: PlayerWindow,
	) {
		// 마지막 영상 복원 (창은 자동으로 띄우지 않음)
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
		view.webview.onDidReceiveMessage(m => {
			if (m?.type === 'open' && this.videoId) {
				this.openWindow(this.videoId);
			}
		});
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
			await this.view.webview.postMessage({ type: 'play', id });
		} else {
			// resolve 시 저장된 videoId로 렌더됨
			await vscode.commands.executeCommand(`${PlayerViewProvider.viewId}.focus`);
		}
		await this.openWindow(id);
	}

	async clear(): Promise<void> {
		this.videoId = undefined;
		await this.context.globalState.update(LAST_VIDEO_KEY, undefined);
		this.player.clear();
		await this.view?.webview.postMessage({ type: 'clear' });
	}

	private openWindow(id: string): Promise<void> {
		return this.player.show(id, config().get<boolean>('autoplay', true));
	}

	private getHtml(): string {
		const nonce = crypto.randomBytes(16).toString('hex');
		const id = this.videoId;
		const thumb = id ? thumbUrl(id) : '';
		const hasVideo = id ? '' : ' hidden';
		const noVideo = id ? ' hidden' : '';
		return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https://i.ytimg.com; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{margin:0;padding:4px}
#card{display:block;width:100%;padding:0;border:0;background:#000;cursor:pointer}
#card img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover}
#hint,#empty{color:var(--vscode-descriptionForeground);padding:4px}
</style>
</head><body>
<div id="now"${hasVideo}>
<button id="card" title="미니 창 열기"><img id="thumb" src="${thumb}" alt=""></button>
<div id="hint">미니 창에서 재생 중 · 썸네일을 누르면 창을 다시 열어요.</div>
</div>
<div id="empty"${noVideo}>상단 + 버튼으로 YouTube URL을 열어보세요.</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const now = document.getElementById('now');
const thumb = document.getElementById('thumb');
const empty = document.getElementById('empty');
document.getElementById('card').addEventListener('click', () => vscode.postMessage({ type: 'open' }));
window.addEventListener('message', e => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'play' && /^[\\w-]{11}$/.test(m.id)) {
    thumb.src = 'https://i.ytimg.com/vi/' + m.id + '/hqdefault.jpg'; now.hidden = false; empty.hidden = true;
  }
  if (m.type === 'clear') { thumb.src = ''; now.hidden = true; empty.hidden = false; }
});
</script>
</body></html>`;
	}
}

function thumbUrl(id: string): string {
	return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

function config(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('vscodetube');
}
