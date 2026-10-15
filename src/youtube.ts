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

export const YOUTUBE_HOME = 'https://www.youtube.com/';

// youtube.com 계열 주소인지
const YOUTUBE_URL_RE = /^https:\/\/(?:[\w-]+\.)?youtube\.com\//;

export function isYouTubeUrl(url: string): boolean {
	return YOUTUBE_URL_RE.test(url);
}

/** 입력값 → 열 주소. 영상이면 watch, YouTube 주소면 그대로, 그 외 URL은 undefined, 나머지는 검색 */
export function resolveInput(input: string): { url: string; video: boolean } | undefined {
	const s = input.trim();
	if (!s) {
		return undefined;
	}
	// 소문자뿐인 11글자(예: programming)는 검색어로 취급
	const bareWord = VIDEO_ID_RE.test(s) && /^[a-z]+$/.test(s);
	const id = bareWord ? undefined : parseVideoId(s);
	if (id) {
		return { url: `${YOUTUBE_HOME}watch?v=${id}`, video: true };
	}
	if (/^https?:\/\//i.test(s)) {
		return isYouTubeUrl(s) ? { url: s, video: false } : undefined;
	}
	return { url: `${YOUTUBE_HOME}results?search_query=${encodeURIComponent(s)}`, video: false };
}
