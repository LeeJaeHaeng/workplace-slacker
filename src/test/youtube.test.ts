import * as assert from 'assert';
import { parseVideoId } from '../youtube';

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
