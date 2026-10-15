import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { Mirror, MirrorInput, MirrorSize } from './mirror';
import { parseVideoId, VIDEO_ID_RE } from './youtube';

const LAST_VIDEO_KEY = 'lastVideo';

type ViewMessage =
	| { type: 'ready' }
	| ({ type: 'size' } & MirrorSize)
	| { type: 'input'; ev: MirrorInput };

export class PlayerViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = 'vscodetube.player';

	private view?: vscode.WebviewView;
	private videoId?: string;
	/** 브라우저에 영상이 열려 있는지 */
	private opened = false;
	/** 뷰가 resolve되기 전에 play()가 불린 경우 true (복원과 구분) */
	private pendingPlay = false;
	private readonly mirror: Mirror;

	constructor(
		private readonly context: vscode.ExtensionContext,
		port: number,
		private readonly log: vscode.LogOutputChannel,
	) {
		// 미러링 전용 브라우저 프로필 (사용자 기본 프로필과 분리)
		const profileDir = path.join(context.globalStorageUri.fsPath, 'browser-profile');
		this.mirror = new Mirror(
			port,
			profileDir,
			data => this.view?.webview.postMessage({ type: 'frame', data }),
			() => {
				this.opened = false;
				this.view?.webview.postMessage({ type: 'clear' });
			},
			log,
		);

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
		view.webview.onDidReceiveMessage((m: ViewMessage) => this.onMessage(m));
		view.onDidChangeVisibility(() => this.mirror.setVisible(view.visible).catch(() => {}));
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
			await this.view.webview.postMessage({ type: 'loading' });
			await this.open(id, config().get<boolean>('autoplay', true));
		} else {
			// resolve 후 웹뷰의 'ready' 메시지에서 저장된 videoId로 열림
			this.pendingPlay = true;
			await vscode.commands.executeCommand(`${PlayerViewProvider.viewId}.focus`);
		}
	}

	async clear(): Promise<void> {
		this.videoId = undefined;
		this.opened = false;
		await this.context.globalState.update(LAST_VIDEO_KEY, undefined);
		this.mirror.close();
		await this.view?.webview.postMessage({ type: 'clear' });
	}

	dispose(): void {
		this.mirror.dispose();
	}

	private async onMessage(m: ViewMessage): Promise<void> {
		try {
			if (m.type === 'size') {
				await this.mirror.resize({ width: m.width, height: m.height, dpr: m.dpr });
			} else if (m.type === 'input') {
				await this.mirror.input(m.ev);
			} else if (m.type === 'ready' && this.videoId && !this.opened) {
				// 복원 시에는 자동 재생하지 않음
				const autoplay = this.pendingPlay && config().get<boolean>('autoplay', true);
				this.pendingPlay = false;
				await this.view?.webview.postMessage({ type: 'loading' });
				await this.open(this.videoId, autoplay);
			}
		} catch (err) {
			// 브라우저 종료 중 입력 등은 기록만
			this.log.debug(`${m.type} 처리 실패: ${err}`);
		}
	}

	private async open(id: string, autoplay: boolean): Promise<void> {
		this.log.info(`열기 ${id} (autoplay=${autoplay})`);
		try {
			await this.mirror.open(id, autoplay);
			this.opened = true;
		} catch (err) {
			this.opened = false;
			this.log.error(`열기 실패: ${err instanceof Error ? err.stack : err}`);
			await this.view?.webview.postMessage({ type: 'clear' });
			vscode.window.showErrorMessage(`VScodetube: ${err instanceof Error ? err.message : err}`);
		}
	}

	private getHtml(): string {
		const nonce = crypto.randomBytes(16).toString('hex');
		const hasVideo = this.videoId ? '' : ' hidden';
		const noVideo = this.videoId ? ' hidden' : '';
		return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{margin:0;padding:4px}
#screen{position:relative;width:100%;aspect-ratio:16/9;background:#000;outline:none;user-select:none}
#screen:focus-visible{outline:1px solid var(--vscode-focusBorder)}
#frame{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none}
#status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:12px}
#empty{color:var(--vscode-descriptionForeground);padding:4px}
</style>
</head><body>
<div id="screen" tabindex="0"${hasVideo}><img id="frame" alt="" hidden><div id="status">불러오는 중…</div></div>
<div id="empty"${noVideo}>상단 + 버튼으로 YouTube URL을 열어보세요.</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const screen = document.getElementById('screen');
const frame = document.getElementById('frame');
const status = document.getElementById('status');
const empty = document.getElementById('empty');
let size = { width: 0, height: 0 };

// 화면 크기를 브라우저 뷰포트에 맞춤
function reportSize() {
  const width = Math.max(1, Math.round(screen.clientWidth));
  const height = Math.max(1, Math.round(width * 9 / 16));
  if (width === size.width && height === size.height) return;
  size = { width, height };
  vscode.postMessage({ type: 'size', width, height, dpr: window.devicePixelRatio || 1 });
}
new ResizeObserver(reportSize).observe(document.body);

window.addEventListener('message', e => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'frame')   { frame.src = 'data:image/jpeg;base64,' + m.data; frame.hidden = false; status.hidden = true; }
  if (m.type === 'loading') { frame.hidden = true; status.hidden = false; screen.hidden = false; empty.hidden = true; reportSize(); }
  if (m.type === 'clear')   { frame.hidden = true; frame.removeAttribute('src'); screen.hidden = true; empty.hidden = false; }
});

// 입력 전달 (좌표는 화면 영역 기준 CSS px)
const pos = e => {
  const r = screen.getBoundingClientRect();
  return { x: (e.clientX - r.left) * size.width / r.width, y: (e.clientY - r.top) * size.height / r.height };
};
const BUTTONS = ['left', 'middle', 'right'];
const send = ev => vscode.postMessage({ type: 'input', ev });
screen.addEventListener('mousedown', e => { screen.focus(); send({ kind: 'mouse', type: 'mousePressed', ...pos(e), button: BUTTONS[e.button] || 'left', clickCount: e.detail || 1 }); e.preventDefault(); });
screen.addEventListener('mouseup', e => send({ kind: 'mouse', type: 'mouseReleased', ...pos(e), button: BUTTONS[e.button] || 'left', clickCount: e.detail || 1 }));
let moveQueued = null;
screen.addEventListener('mousemove', e => {
  if (!moveQueued) requestAnimationFrame(() => { send(moveQueued); moveQueued = null; });
  moveQueued = { kind: 'mouse', type: 'mouseMoved', ...pos(e), button: 'none', clickCount: 0 };
});
screen.addEventListener('wheel', e => { send({ kind: 'wheel', ...pos(e), deltaX: e.deltaX, deltaY: e.deltaY }); e.preventDefault(); }, { passive: false });
screen.addEventListener('contextmenu', e => e.preventDefault());
screen.addEventListener('dragstart', e => e.preventDefault());
for (const type of ['keydown', 'keyup']) {
  screen.addEventListener(type, e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // VS Code 단축키는 통과
    send({ kind: 'key', type: type === 'keydown' ? 'keyDown' : 'keyUp', key: e.key, code: e.code, keyCode: e.keyCode, text: e.key.length === 1 ? e.key : undefined });
    e.preventDefault();
  });
}

reportSize();
vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
	}
}

function config(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('vscodetube');
}
