// 11자리 video ID 패턴
export const VIDEO_ID_RE = /^[\w-]{11}$/;

// URL 안의 video ID 추출용 패턴
const URL_RE = /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})(?![\w-])/;

/** YouTube URL 또는 11자리 video ID → video ID. 인식 실패 시 undefined */
export function parseVideoId(input: string): string | undefined {
	const s = input.trim();
	if (VIDEO_ID_RE.test(s)) {
		return s;
	}
	return URL_RE.exec(s)?.[1];
}
