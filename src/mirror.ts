import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import * as vscode from 'vscode';

// VS Code 웹뷰는 Opus 오디오를 지원한다고 보고하지만 실제로는 디코딩하지 못해 YouTube 재생이 멈춘다.
// 그래서 시스템 Edge/Chrome을 headless로 띄워 공식 플레이어를 재생하고(소리도 브라우저에서 출력),
// DevTools Protocol 스크린캐스트로 화면을 사이드바에 비추며 입력을 되돌려 보낸다.

/** 웹뷰에서 전달되는 입력 이벤트 (좌표는 화면 영역 기준 CSS px) */
export type MirrorInput =
	| { kind: 'mouse'; type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number; button: 'left' | 'right' | 'middle' | 'none'; clickCount: number }
	| { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
	| { kind: 'key'; type: 'keyDown' | 'keyUp'; key: string; code: string; keyCode: number; text?: string };

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

export class Mirror implements vscode.Disposable {
	private proc?: ChildProcess;
	private cdp?: Cdp;
	private session?: string;
	private starting?: Promise<void>;
	private size: MirrorSize = { width: 480, height: 270, dpr: 1 };
	private casting = false;
	private visible = true;
	private frames = 0;

	constructor(
		private readonly port: number,
		private readonly profileDir: string,
		private readonly onFrame: (jpegBase64: string) => void,
		private readonly onClosed: () => void,
		private readonly log: vscode.LogOutputChannel,
	) {}

	/** 영상 열기: 브라우저가 없으면 띄우고, 있으면 페이지만 이동 */
	async open(id: string, autoplay: boolean): Promise<void> {
		// 서버는 127.0.0.1에 바인드하지만 IP Referer는 일부 영상에서 거부되므로 localhost 사용
		const url = `http://localhost:${this.port}/player?v=${id}&autoplay=${autoplay ? 1 : 0}`;
		if (this.session) {
			await this.send('Page.navigate', { url });
			return;
		}
		this.starting ??= this.start(url).finally(() => (this.starting = undefined));
		await this.starting;
	}

	async resize(size: MirrorSize): Promise<void> {
		this.size = size;
		if (!this.session) {
			return;
		}
		await this.send('Emulation.setDeviceMetricsOverride', {
			width: size.width, height: size.height, deviceScaleFactor: size.dpr, mobile: false,
		});
		if (this.casting) {
			await this.restartCast();
		}
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
		if (!this.session) {
			return;
		}
		if (ev.kind === 'mouse') {
			await this.send('Input.dispatchMouseEvent', {
				type: ev.type, x: ev.x, y: ev.y, button: ev.button, clickCount: ev.clickCount,
			});
		} else if (ev.kind === 'wheel') {
			await this.send('Input.dispatchMouseEvent', {
				type: 'mouseWheel', x: ev.x, y: ev.y, deltaX: ev.deltaX, deltaY: ev.deltaY,
			});
		} else {
			await this.send('Input.dispatchKeyEvent', {
				type: ev.text && ev.type === 'keyDown' ? 'keyDown' : ev.type === 'keyDown' ? 'rawKeyDown' : 'keyUp',
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

	private async start(url: string): Promise<void> {
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
			'--no-first-run',
			'--enable-logging=stderr',
			'--no-default-browser-check',
			`--lang=${vscode.env.language}`,
			url,
		], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], env: browserEnv() });
		// 브라우저 로그는 마지막 일부만 보관 (파이프가 차서 멈추지 않도록 항상 읽음)
		let stderrTail = '';
		proc.stderr?.on('data', (d: Buffer) => (stderrTail = (stderrTail + d.toString()).slice(-4000)));
		this.proc = proc;
		this.frames = 0;
		proc.on('exit', (code, signal) => {
			this.log.info(`브라우저 종료 (code=${code}, signal=${signal})`);
			if (this.frames === 0 && stderrTail) {
				this.log.warn(`브라우저 출력:
${stderrTail}`);
			}
			if (this.proc === proc) {
				this.reset();
				this.onClosed();
			}
		});
		const spawned = new Promise<void>((resolve, reject) => {
			proc.once('spawn', resolve);
			proc.once('error', reject);
		});
		await spawned;
		this.log.info(`브라우저 실행 pid=${proc.pid} ${url}`);

		this.cdp = new Cdp(proc.stdio[3] as Writable, proc.stdio[4] as Readable, (m, p, s) => this.onEvent(m, p, s));
		const targetId = await this.waitForPage();
		const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
		this.session = sessionId;
		this.log.info('페이지 연결됨');
		await this.send('Page.enable');
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
		if (method === 'Page.screencastFrame' && sessionId === this.session) {
			this.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
			if (this.frames++ === 0) {
				this.log.info('첫 프레임 수신');
			}
			this.onFrame(params.data);
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
