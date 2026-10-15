import * as http from 'http';
import { AddressInfo } from 'net';
import { VIDEO_ID_RE } from './youtube';

/** player 페이지로 보내는 명령 */
export type PlayerCommand = { type: 'play'; id: string; autoplay: boolean } | { type: 'clear' };

export interface PlayerServer {
	port: number;
	/** /events 에 연결된 player 페이지 수 */
	clientCount(): number;
	/** 연결된 player 페이지 전체에 명령 전송 */
	broadcast(cmd: PlayerCommand): void;
	dispose(): void;
}

// YouTube iframe을 감싼 player 페이지 (Referer를 보내기 위한 중간 계층)
// /events(SSE)로 명령을 받아 창을 새로 열지 않고 영상을 교체한다
function playerHtml(videoId: string, autoplay: 0 | 1): string {
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>VScodetube</title>
<style>html,body{margin:0;height:100%;background:#000}iframe{width:100%;height:100%;border:0}</style>
</head><body>
<iframe
  id="yt"
  src="${embedUrl(videoId, autoplay)}"
  referrerpolicy="strict-origin-when-cross-origin"
  allow="autoplay; encrypted-media; picture-in-picture"
  allowfullscreen></iframe>
<script>
const f = document.getElementById('yt');
new EventSource('/events').onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.type === 'play' && /^[\\w-]{11}$/.test(m.id)) {
    f.src = 'https://www.youtube-nocookie.com/embed/' + m.id + '?autoplay=' + (m.autoplay ? 1 : 0) + '&enablejsapi=1&rel=0';
  }
  if (m.type === 'clear') { f.src = 'about:blank'; }
};
</script>
</body></html>`;
}

function embedUrl(videoId: string, autoplay: 0 | 1): string {
	return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=${autoplay}&enablejsapi=1&rel=0`;
}

function send(res: http.ServerResponse, status: number, body: string): void {
	res.writeHead(status, {
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store',
	});
	res.end(body);
}

/** 127.0.0.1 임의 포트에 player 페이지 서버를 띄운다 */
export function startPlayerServer(): Promise<PlayerServer> {
	const clients = new Set<http.ServerResponse>();

	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (req.method !== 'GET') {
				return send(res, 404, 'Not Found');
			}
			if (url.pathname === '/events') {
				res.writeHead(200, {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-store',
					'Connection': 'keep-alive',
				});
				res.write(':ok\n\n');
				clients.add(res);
				req.on('close', () => clients.delete(res));
				return;
			}
			if (url.pathname !== '/player') {
				return send(res, 404, 'Not Found');
			}
			const id = url.searchParams.get('v') ?? '';
			if (!VIDEO_ID_RE.test(id)) {
				return send(res, 400, 'Bad Request');
			}
			const autoplay = url.searchParams.get('autoplay') === '1' ? 1 : 0;
			send(res, 200, playerHtml(id, autoplay));
		});

		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				port,
				clientCount: () => clients.size,
				broadcast: cmd => {
					const data = `data: ${JSON.stringify(cmd)}\n\n`;
					for (const c of clients) {
						c.write(data);
					}
				},
				dispose: () => {
					for (const c of clients) {
						c.end();
					}
					clients.clear();
					server.close();
					server.closeAllConnections();
				},
			});
		});
	});
}
