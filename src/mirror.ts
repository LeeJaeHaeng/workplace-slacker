import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import * as vscode from 'vscode';

// VS Code 웹뷰는 Opus 오디오를 지원한다고 보고하지만 실제로는 디코딩하지 못해 YouTube 재생이 멈춘다.
// 그래서 시스템 Chrome/Edge를 headless로 띄워 YouTube 사이트를 그대로 열고(소리도 브라우저에서 출력),
// DevTools Protocol 스크린캐스트로 화면을 사이드바에 비추며 입력을 되돌려 보낸다.

/** 웹뷰에서 전달되는 입력 이벤트 (좌표는 화면 영역 기준 CSS px) */
export type MirrorInput =
	| { kind: 'mouse'; type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number; button: 'left' | 'right' | 'middle' | 'none'; clickCount: number }
	| { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
	| { kind: 'key'; type: 'keyDown' | 'keyUp'; key: string; code: string; keyCode: number; text?: string }
	| { kind: 'text'; text: string };

export interface MirrorSize { width: number; height: number; dpr: number }

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** --remote-debugging-pipe 용 최소 CDP 클라이언트 (메시지는 '\0'으로 구분된 JSON) */
class Cdp {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private chunks: Buffer[] = [];

	constructor(
		private readonly out: Writable,
		inp: Readable,
		private readonly onEvent: (method: string, params: any, sessionId?: string) => void,
	) {
		inp.on('data', (chunk: Buffer) => this.onData(chunk));
		inp.on('close', () => this.failAll(new Error('브라우저 연결이 끊어졌어요.')));
	}

	send(method: string, params: object = {}, sessionId?: string): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.out.write(JSON.stringify({ id, method, params, sessionId }) + '\0');
		});
	}

	private onData(chunk: Buffer): void {
		let end = chunk.indexOf(0);
		while (end >= 0) {
			this.chunks.push(chunk.subarray(0, end));
			this.handle(Buffer.concat(this.chunks).toString('utf8'));
			this.chunks = [];
			chunk = chunk.subarray(end + 1);
			end = chunk.indexOf(0);
		}
		if (chunk.length) {
			this.chunks.push(chunk);
		}
	}

	private handle(raw: string): void {
		const msg = JSON.parse(raw);
		if (msg.id === undefined) {
			this.onEvent(msg.method, msg.params, msg.sessionId);
			return;
		}
		const p = this.pending.get(msg.id);
		this.pending.delete(msg.id);
		if (msg.error) {
			p?.reject(new Error(msg.error.message));
		} else {
			p?.resolve(msg.result);
		}
	}

	private failAll(err: Error): void {
		for (const p of this.pending.values()) {
			p.reject(err);
		}
		this.pending.clear();
	}
}

// 모든 YouTube 페이지에 주입. YouTube가 <style>/<html> 클래스를 지우므로 adoptedStyleSheets 사용
// - 유료 광고 포함 표시 숨김
// - 플레이어 꽉 채우기(fill) 모드
const BASE_CSS = `
.ytp-paid-content-overlay, .ytp-paid-content-overlay-link, ytd-paid-content-overlay-renderer,
ytm-paid-content-overlay-renderer { display: none !important; }
`;
const FILL_CSS = `
html, body { overflow: hidden !important; }
#masthead-container, ytd-masthead, #masthead, tp-yt-app-drawer#guide, ytd-mini-guide-renderer { display: none !important; }
#movie_player {
  position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
  z-index: 2147483647 !important; background: #000 !important;
}
`;
const INJECT_SCRIPT = `(() => {
  const base = new CSSStyleSheet();
  base.replaceSync(${JSON.stringify(BASE_CSS)});
  const fill = new CSSStyleSheet();
  let filled = false;
  const ensure = () => {
    const list = document.adoptedStyleSheets;
    if (!list.includes(base)) document.adoptedStyleSheets = [...list, base, fill];
  };
  ensure();
  document.addEventListener('DOMContentLoaded', ensure);

  // fill 모드 전환: 플레이어 크기 재계산을 위해 resize 이벤트를 보내고 익스텐션에 알림
  window.__vscodetubeFill = on => {
    ensure();
    if (filled === on) return;
    filled = on;
    fill.replaceSync(on ? ${JSON.stringify(FILL_CSS)} : '');
    const kick = () => window.dispatchEvent(new Event('resize'));
    kick(); requestAnimationFrame(kick); setTimeout(kick, 300);
    try { window.vscodetubeFill(on ? '1' : '0'); } catch {}
  };
  // Esc로 해제, 다른 페이지로 이동하면 해제
  document.addEventListener('keydown', e => { if (e.key === 'Escape') window.__vscodetubeFill(false); }, true);
  document.addEventListener('yt-navigate-start', () => window.__vscodetubeFill(false));
})();`;

// 영상 페이지면 fill 모드 켜기. 'wait'면 아직 플레이어 준비 전
const FILL_SCRIPT = `(() => {
  if (location.pathname !== '/watch') return 'skip';
  if (!document.querySelector('#movie_player video') || !window.__vscodetubeFill) return 'wait';
  window.__vscodetubeFill(true);
  return 'done';
})()`;

// 곧 재생되는 영상을 한 번만 일시정지 (자동 재생 끄기/복원용)
const PAUSE_ONCE_SCRIPT = `(() => {
  const until = Date.now() + 15000;
  const tick = () => {
    const v = document.querySelector('video');
    if (v && !v.paused) { v.pause(); return; }
    if (Date.now() < until) setTimeout(tick, 200);
  };
  tick();
})();`;

export class Mirror implements vscode.Disposable {
	private proc?: ChildProcess;
	private cdp?: Cdp;
	private session?: string;
	private starting?: Promise<void>;
	private size: MirrorSize = { width: 400, height: 600, dpr: 1 };
	private casting = false;
	private visible = true;
	private frames = 0;
	private dark = true;
	private fill = false;
	private loadWaiters: (() => void)[] = [];

	constructor(
		private readonly profileDir: string,
		private readonly onFrame: (jpegBase64: string) => void,
		/** newDocument: 새 문서 로드(새로고침 포함), false면 SPA 내부 이동 */
		private readonly onUrl: (url: string, newDocument: boolean) => void,
		private readonly onClosed: () => void,
		private readonly log: vscode.LogOutputChannel,
	) {}

	get running(): boolean {
		return !!this.proc;
	}

	/** 페이지 열기: 브라우저가 없으면 띄우고 이동. pause면 첫 재생을 멈춤 */
	async open(url: string, pause = false): Promise<void> {
		if (!this.session) {
			this.starting ??= this.start().finally(() => (this.starting = undefined));
			await this.starting;
		}
		const loaded = this.waitLoad();
		await this.send('Page.navigate', { url });
		if (pause) {
			await loaded;
			await this.send('Runtime.evaluate', { expression: PAUSE_ONCE_SCRIPT });
		}
	}

	async back(): Promise<void> {
		await this.send('Runtime.evaluate', { expression: 'history.back()' });
	}

	/** 영상 페이지면 플레이어를 화면에 꽉 채움 (플레이어가 준비될 때까지 최대 10초 재시도) */
	async enterFill(): Promise<void> {
		for (let i = 0; i < 20 && this.session; i++) {
			const r = await this.send('Runtime.evaluate', { expression: FILL_SCRIPT, returnByValue: true });
			if (r?.result?.value !== 'wait') {
				return;
			}
			await new Promise(res => setTimeout(res, 500));
		}
	}

	/** 사이드바 → 페이지 좌표 배율. PC 레이아웃 폭으로 렌더링하고 사이드바 크기로 축소해 보여줌 */
	private get scale(): number {
		if (this.fill) {
			// 꽉 채운 플레이어는 사이드바 실제 크기로 (컨트롤이 읽을 만한 크기)
			return 1;
		}
		const pageWidth = vscode.workspace.getConfiguration('vscodetube').get<number>('pageWidth', 1280);
		return Math.max(1, pageWidth / this.size.width);
	}

	async resize(size: MirrorSize): Promise<void> {
		this.size = size;
		if (!this.session) {
			return;
		}
		const s = this.scale;
		await this.send('Emulation.setDeviceMetricsOverride', {
			width: Math.round(size.width * s), height: Math.round(size.height * s),
			// 축소돼도 사이드바 실제 픽셀만큼은 선명하게
			deviceScaleFactor: Math.max(1, size.dpr / s), mobile: false,
		});
		if (this.casting) {
			await this.restartCast();
		}
	}

	/** 설정(pageWidth) 변경 등으로 레이아웃 다시 계산 */
	relayout(): Promise<void> {
		return this.resize(this.size);
	}

	/** VS Code 테마에 맞춰 YouTube 다크/라이트 */
	async setDark(dark: boolean): Promise<void> {
		this.dark = dark;
		await this.send('Emulation.setEmulatedMedia', {
			features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
		});
	}

	/** 사이드바가 안 보이면 프레임 전송만 멈춤 (재생은 계속) */
	async setVisible(visible: boolean): Promise<void> {
		this.visible = visible;
		if (!this.session) {
			return;
		}
		if (visible && !this.casting) {
			await this.startCast();
		} else if (!visible && this.casting) {
			this.casting = false;
			await this.send('Page.stopScreencast');
		}
	}

	async input(ev: MirrorInput): Promise<void> {
		const s = this.scale;
		if (ev.kind === 'mouse') {
			await this.send('Input.dispatchMouseEvent', {
				type: ev.type, x: ev.x * s, y: ev.y * s, button: ev.button, clickCount: ev.clickCount,
			});
		} else if (ev.kind === 'wheel') {
			await this.send('Input.dispatchMouseEvent', {
				type: 'mouseWheel', x: ev.x * s, y: ev.y * s, deltaX: ev.deltaX * s, deltaY: ev.deltaY * s,
			});
		} else if (ev.kind === 'text') {
			await this.send('Input.insertText', { text: ev.text });
		} else {
			await this.send('Input.dispatchKeyEvent', {
				type: ev.type === 'keyUp' ? 'keyUp' : ev.text ? 'keyDown' : 'rawKeyDown',
				key: ev.key, code: ev.code, windowsVirtualKeyCode: ev.keyCode, text: ev.text,
			});
		}
	}

	/** 브라우저 종료 */
	close(): void {
		this.proc?.kill();
		this.reset();
	}

	dispose(): void {
		this.close();
	}

	private async start(): Promise<void> {
		const browser = findBrowser();
		this.log.info(`브라우저: ${browser ?? '(없음)'}`);
		if (!browser) {
			throw new Error('Chrome 또는 Edge를 찾지 못했어요. 설정 vscodetube.browserPath를 지정해 주세요.');
		}
		// 브라우저마다 프로필 분리 (Edge/Chrome 프로필 혼용 방지)
		const profile = `${this.profileDir}-${path.parse(browser).name}`;
		fs.mkdirSync(profile, { recursive: true });
		const proc = spawn(browser, [
			'--headless=new',
			'--remote-debugging-pipe',
			`--user-data-dir=${profile}`,
			`--window-size=${this.size.width},${this.size.height}`,
			'--autoplay-policy=no-user-gesture-required',
			'--hide-scrollbars',
			'--no-first-run',
			'--no-default-browser-check',
			'--enable-logging=stderr',
			`--lang=${vscode.env.language}`,
			'about:blank',
		], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], env: browserEnv() });
		// 브라우저 로그는 마지막 일부만 보관 (파이프가 차서 멈추지 않도록 항상 읽음)
		let stderrTail = '';
		proc.stderr?.on('data', (d: Buffer) => (stderrTail = (stderrTail + d.toString()).slice(-4000)));
		this.proc = proc;
		this.frames = 0;
		proc.on('exit', (code, signal) => {
			this.log.info(`브라우저 종료 (code=${code}, signal=${signal})`);
			if (this.frames === 0 && stderrTail) {
				this.log.warn(`브라우저 출력:\n${stderrTail}`);
			}
			if (this.proc === proc) {
				this.reset();
				this.onClosed();
			}
		});
		await new Promise<void>((resolve, reject) => {
			proc.once('spawn', resolve);
			proc.once('error', reject);
		});
		this.log.info(`브라우저 실행 pid=${proc.pid}`);

		this.cdp = new Cdp(proc.stdio[3] as Writable, proc.stdio[4] as Readable, (m, p, s) => this.onEvent(m, p, s));
		const { userAgent } = await this.cdp.send('Browser.getVersion');
		const targetId = await this.waitForPage();
		const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
		this.session = sessionId;
		this.log.info('페이지 연결됨');
		await this.send('Page.enable');
		// headless 표시가 있으면 YouTube가 다르게 동작할 수 있어 일반 Chrome UA 사용
		await this.send('Emulation.setUserAgentOverride', {
			userAgent: String(userAgent).replace('HeadlessChrome', 'Chrome'),
			acceptLanguage: vscode.env.language,
		});
		await this.send('Runtime.enable');
		await this.send('Runtime.addBinding', { name: 'vscodetubeFill' });
		await this.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT_SCRIPT });
		await this.setDark(this.dark);
		await this.resize(this.size);
		if (this.visible) {
			await this.startCast();
		}
	}

	private async waitForPage(): Promise<string> {
		for (let i = 0; i < 50; i++) {
			const { targetInfos } = await this.cdp!.send('Target.getTargets');
			const page = targetInfos.find((t: any) => t.type === 'page');
			if (page) {
				return page.targetId;
			}
			await new Promise(r => setTimeout(r, 100));
		}
		throw new Error('브라우저 페이지를 찾지 못했어요.');
	}

	/** 다음 load 이벤트(최대 10초) 대기 */
	private waitLoad(): Promise<void> {
		return new Promise(r => {
			this.loadWaiters.push(r);
			setTimeout(r, 10000);
		});
	}

	private async startCast(): Promise<void> {
		this.casting = true;
		await this.send('Page.startScreencast', {
			format: 'jpeg', quality: 80,
			maxWidth: Math.round(this.size.width * this.size.dpr),
			maxHeight: Math.round(this.size.height * this.size.dpr),
		});
	}

	private async restartCast(): Promise<void> {
		await this.send('Page.stopScreencast');
		await this.startCast();
	}

	private onEvent(method: string, params: any, sessionId?: string): void {
		if (sessionId !== this.session) {
			return;
		}
		if (method === 'Page.screencastFrame') {
			this.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
			if (this.frames++ === 0) {
				this.log.info('첫 프레임 수신');
			}
			this.onFrame(params.data);
		} else if (method === 'Page.frameNavigated' && !params.frame.parentId) {
			// 새 문서에선 fill 스타일이 사라지므로 상태 초기화
			if (this.fill) {
				this.fill = false;
				this.relayout().catch(() => {});
			}
			this.onUrl(params.frame.url, true);
		} else if (method === 'Page.navigatedWithinDocument') {
			// YouTube는 SPA라 페이지 이동 대부분이 여기로 옴
			this.onUrl(params.url, false);
		} else if (method === 'Runtime.bindingCalled' && params.name === 'vscodetubeFill') {
			this.fill = params.payload === '1';
			this.relayout().catch(() => {});
		} else if (method === 'Page.loadEventFired') {
			this.loadWaiters.splice(0).forEach(r => r());
		}
	}

	private send(method: string, params: object = {}): Promise<any> {
		if (!this.cdp || !this.session) {
			return Promise.resolve();
		}
		return this.cdp.send(method, params, this.session);
	}

	private reset(): void {
		this.proc = undefined;
		this.cdp = undefined;
		this.session = undefined;
		this.casting = false;
		this.fill = false;
		this.loadWaiters.splice(0).forEach(r => r());
	}
}

/** VS Code(Electron)가 물려주는 환경 변수를 빼고 브라우저 실행 */
function browserEnv(): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !/^(ELECTRON_|VSCODE_|CHROME_CRASHPAD)/i.test(k)),
	);
}

/** 설정값 → Chrome → Edge 순으로 실행 파일 탐색 */
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
		const rel = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe'];
		return rel.flatMap(r => roots.map(root => path.join(root, r)));
	}
	if (process.platform === 'darwin') {
		return [
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
			'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
		];
	}
	return ['/usr/bin/google-chrome', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}
