import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { Mirror, MirrorInput, MirrorSize } from './mirror';
import { isYouTubeUrl, resolveInput, YOUTUBE_HOME } from './youtube';

const LAST_URL_KEY = 'lastUrl';

type ViewMessage =
	| { type: 'ready' }
	| { type: 'home' }
	| { type: 'paste' }
	| ({ type: 'size' } & MirrorSize)
	| { type: 'input'; ev: MirrorInput };

// 사이드바 뷰: headless 브라우저의 YouTube 화면을 비추고 입력을 전달
export class PlayerViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = 'vscodetube.player';

	private view?: vscode.WebviewView;
	private readonly mirror: Mirror;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly log: vscode.LogOutputChannel,
	) {
		// 미러링 전용 브라우저 프로필 (사용자 기본 프로필과 분리)
		const profileDir = path.join(context.globalStorageUri.fsPath, 'browser-profile');
		this.mirror = new Mirror(
			profileDir,
			data => this.view?.webview.postMessage({ type: 'frame', data }),
			url => this.onUrl(url),
			() => this.view?.webview.postMessage({ type: 'clear' }),
			log,
		);
		this.disposables.push(
			vscode.window.onDidChangeActiveColorTheme(() => this.mirror.setDark(isDarkTheme()).catch(() => {})),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('vscodetube.pageWidth')) {
					this.mirror.relayout().catch(() => {});
				}
			}),
		);
		this.mirror.setDark(isDarkTheme()).catch(() => {});
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

	/** 검색어, 영상 URL/ID, YouTube 주소 열기 */
	async openInput(input: string): Promise<void> {
		const target = resolveInput(input);
		if (!target) {
			if (input.trim()) {
				vscode.window.showWarningMessage('YouTube 주소나 검색어를 입력해 주세요.');
			}
			return;
		}
		const pause = target.video && !config().get<boolean>('autoplay', true);
		await this.open(target.url, pause);
	}

	home(): Promise<void> {
		return this.open(YOUTUBE_HOME);
	}

	async back(): Promise<void> {
		await this.mirror.back().catch(() => {});
	}

	async clear(): Promise<void> {
		this.mirror.close();
		await this.context.globalState.update(LAST_URL_KEY, undefined);
		await this.view?.webview.postMessage({ type: 'clear' });
	}

	dispose(): void {
		this.mirror.dispose();
		this.disposables.forEach(d => d.dispose());
	}

	private async open(url: string, pause = false): Promise<void> {
		if (!this.view) {
			// 뷰가 열리면 'ready'에서 마지막 주소로 열리도록 저장
			await this.context.globalState.update(LAST_URL_KEY, url);
			await vscode.commands.executeCommand(`${PlayerViewProvider.viewId}.focus`);
			return;
		}
		this.view.show(true);
		await this.view.webview.postMessage({ type: 'loading' });
		this.log.info(`열기 ${url}${pause ? ' (일시정지)' : ''}`);
		try {
			await this.mirror.open(url, pause);
		} catch (err) {
			this.log.error(`열기 실패: ${err instanceof Error ? err.stack : err}`);
			await this.view?.webview.postMessage({ type: 'clear' });
			vscode.window.showErrorMessage(`VScodetube: ${err instanceof Error ? err.message : err}`);
		}
	}

	private async onMessage(m: ViewMessage): Promise<void> {
		try {
			if (m.type === 'size') {
				await this.mirror.resize({ width: m.width, height: m.height, dpr: m.dpr });
			} else if (m.type === 'input') {
				await this.mirror.input(m.ev);
			} else if (m.type === 'paste') {
				const text = await vscode.env.clipboard.readText();
				if (text) {
					await this.mirror.input({ kind: 'text', text });
				}
			} else if (m.type === 'home') {
				await this.home();
			} else if (m.type === 'ready' && !this.mirror.running) {
				// 마지막으로 보던 페이지 복원 (영상은 자동 재생하지 않음)
				const last = this.context.globalState.get<string>(LAST_URL_KEY);
				if (last && isYouTubeUrl(last) && config().get<boolean>('restoreLastVideo', true)) {
					await this.open(last, true);
				}
			}
		} catch (err) {
			// 브라우저 종료 중 입력 등은 기록만
			this.log.debug(`${m.type} 처리 실패: ${err}`);
		}
	}

	private onUrl(url: string): void {
		if (isYouTubeUrl(url)) {
			this.context.globalState.update(LAST_URL_KEY, url);
		}
	}

	private getHtml(): string {
		const nonce = crypto.randomBytes(16).toString('hex');
		const hasPage = this.context.globalState.get<string>(LAST_URL_KEY) && config().get<boolean>('restoreLastVideo', true);
		return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
html,body{margin:0;height:100%;overflow:hidden}
[hidden]{display:none !important}
#screen{position:absolute;inset:0;background:#000;user-select:none}
#frame{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none}
#status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:12px}
#ime{position:absolute;left:-1000px;top:0;width:1px;height:1px;opacity:0}
#empty{padding:8px;color:var(--vscode-descriptionForeground)}
#empty button{margin-top:8px;padding:4px 10px;border:0;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}
#empty button:hover{background:var(--vscode-button-hoverBackground)}
</style>
</head><body>
<div id="screen"${hasPage ? '' : ' hidden'}><img id="frame" alt="" hidden><div id="status">불러오는 중…</div></div>
<textarea id="ime" aria-label="YouTube 입력"></textarea>
<div id="empty"${hasPage ? ' hidden' : ''}>
  <div>YouTube를 열어 검색하고 재생해 보세요.</div>
  <button id="home">YouTube 홈 열기</button>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const screen = $('screen'), frame = $('frame'), status = $('status'), empty = $('empty'), ime = $('ime');
let size = { width: 0, height: 0 };

// 사이드바 크기를 브라우저 뷰포트로
function reportSize() {
  const width = Math.max(1, Math.round(document.body.clientWidth));
  const height = Math.max(1, Math.round(document.body.clientHeight));
  if (width === size.width && height === size.height) return;
  size = { width, height };
  vscode.postMessage({ type: 'size', width, height, dpr: window.devicePixelRatio || 1 });
}
new ResizeObserver(reportSize).observe(document.body);

window.addEventListener('message', e => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'frame')   { frame.src = 'data:image/jpeg;base64,' + m.data; frame.hidden = false; status.hidden = true; }
  if (m.type === 'loading') { if (frame.hidden) status.hidden = false; screen.hidden = false; empty.hidden = true; reportSize(); }
  if (m.type === 'clear')   { frame.hidden = true; frame.removeAttribute('src'); screen.hidden = true; empty.hidden = false; }
});
$('home').addEventListener('click', () => vscode.postMessage({ type: 'home' }));

const send = ev => vscode.postMessage({ type: 'input', ev });

// 마우스 (좌표는 화면 영역 기준 CSS px)
const pos = e => {
  const r = screen.getBoundingClientRect();
  return { x: (e.clientX - r.left) * size.width / r.width, y: (e.clientY - r.top) * size.height / r.height };
};
const BUTTONS = ['left', 'middle', 'right'];
screen.addEventListener('mousedown', e => {
  ime.focus();
  send({ kind: 'mouse', type: 'mousePressed', ...pos(e), button: BUTTONS[e.button] || 'left', clickCount: e.detail || 1 });
  e.preventDefault();
});
screen.addEventListener('mouseup', e => send({ kind: 'mouse', type: 'mouseReleased', ...pos(e), button: BUTTONS[e.button] || 'left', clickCount: e.detail || 1 }));
let moveQueued = null;
screen.addEventListener('mousemove', e => {
  if (!moveQueued) requestAnimationFrame(() => { send(moveQueued); moveQueued = null; });
  moveQueued = { kind: 'mouse', type: 'mouseMoved', ...pos(e), button: 'none', clickCount: 0 };
});
screen.addEventListener('wheel', e => { send({ kind: 'wheel', ...pos(e), deltaX: e.deltaX, deltaY: e.deltaY }); e.preventDefault(); }, { passive: false });
screen.addEventListener('contextmenu', e => e.preventDefault());

// 키보드: 숨은 textarea로 받아 전달 (한글 등 IME는 조합이 끝난 글자를 insertText)
let enterAfterCompose = false;
const key = (type, e, text) => send({ kind: 'key', type, key: e.key, code: e.code, keyCode: e.keyCode, text });
ime.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'v' || e.key === 'V') { vscode.postMessage({ type: 'paste' }); e.preventDefault(); }
    return; // 나머지 Ctrl 단축키는 VS Code로
  }
  if (e.altKey) return;
  if (e.isComposing || e.keyCode === 229) {
    if (e.key === 'Enter') enterAfterCompose = true;
    return;
  }
  key('keyDown', e, e.key === 'Enter' ? '\\r' : e.key.length === 1 ? e.key : undefined);
  e.preventDefault();
});
ime.addEventListener('keyup', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.keyCode === 229) return;
  key('keyUp', e);
});
ime.addEventListener('compositionend', e => {
  if (e.data) send({ kind: 'text', text: e.data });
  ime.value = '';
  if (enterAfterCompose) {
    enterAfterCompose = false;
    const enter = { key: 'Enter', code: 'Enter', keyCode: 13 };
    key('keyDown', enter, '\\r');
    key('keyUp', enter);
  }
});
ime.addEventListener('input', e => { if (!e.isComposing) ime.value = ''; });

reportSize();
vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
	}
}

function isDarkTheme(): boolean {
	const kind = vscode.window.activeColorTheme.kind;
	return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
}

function config(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('vscodetube');
}
