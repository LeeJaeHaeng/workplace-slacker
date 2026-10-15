import * as assert from 'assert';
import { parseVideoId, resolveInput } from '../youtube';

suite('parseVideoId', () => {
	const ID = 'dQw4w9WgXcQ';
	const cases: [string, string | undefined][] = [
		[ID, ID],
		[`https://www.youtube.com/watch?v=${ID}`, ID],
		[`https://www.youtube.com/watch?v=${ID}&t=42s&list=PL...`, ID],
		[`https://youtu.be/${ID}?si=abc`, ID],
		[`https://www.youtube.com/shorts/${ID}`, ID],
		[`https://www.youtube.com/embed/${ID}`, ID],
		[`https://www.youtube.com/live/${ID}`, ID],
		[`https://m.youtube.com/watch?v=${ID}`, ID],
		[`  https://youtu.be/${ID}  `, ID],
		['https://google.com', undefined],
		['abc', undefined],
		['', undefined],
	];

	for (const [input, expected] of cases) {
		test(JSON.stringify(input), () => {
			assert.strictEqual(parseVideoId(input), expected);
		});
	}
});

suite('resolveInput', () => {
	test('영상 URL → watch', () => {
		assert.deepStrictEqual(resolveInput('https://youtu.be/dQw4w9WgXcQ'), { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', video: true });
	});
	test('검색어 → results', () => {
		assert.deepStrictEqual(resolveInput(' lofi 음악 '), { url: 'https://www.youtube.com/results?search_query=lofi%20%EC%9D%8C%EC%95%85', video: false });
	});
	test('11글자 소문자 단어는 검색', () => {
		assert.deepStrictEqual(resolveInput('programming'), { url: 'https://www.youtube.com/results?search_query=programming', video: false });
	});
	test('YouTube 채널 주소는 그대로', () => {
		assert.deepStrictEqual(resolveInput('https://www.youtube.com/@LofiGirl'), { url: 'https://www.youtube.com/@LofiGirl', video: false });
	});
	test('다른 사이트 URL / 빈 값 → undefined', () => {
		assert.strictEqual(resolveInput('https://google.com'), undefined);
		assert.strictEqual(resolveInput('   '), undefined);
	});
});
