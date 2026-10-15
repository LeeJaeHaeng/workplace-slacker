import * as http from 'http';
import { AddressInfo } from 'net';
import { VIDEO_ID_RE } from './youtube';

export interface PlayerServer {
	port: number;
	dispose(): void;
}

// YouTube iframe을 감싼 player 페이지 (Referer를 보내기 위한 중간 계층)
function playerHtml(videoId: string, autoplay: 0 | 1): string {
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="referrer" content="strict-origin-when-cross-origin">
<style>html,body{margin:0;height:100%;background:#000}iframe{width:100%;height:100%;border:0}</style>
</head><body>
<iframe
  src="https://www.youtube-nocookie.com/embed/${videoId}?autoplay=${autoplay}&enablejsapi=1&rel=0"
  referrerpolicy="strict-origin-when-cross-origin"
  allow="autoplay; encrypted-media; picture-in-picture"
  allowfullscreen></iframe>
</body></html>`;
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
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (req.method !== 'GET' || url.pathname !== '/player') {
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
				dispose: () => {
					server.close();
					server.closeAllConnections();
				},
			});
		});
	});
}
