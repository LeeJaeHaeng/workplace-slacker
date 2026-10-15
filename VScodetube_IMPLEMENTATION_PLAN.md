# VScodetube — 구현 계획서 (Claude Code용)

> 이 문서는 Claude Code가 그대로 따라 구현할 수 있도록 작성된 상세 계획서다.
> 작업 디렉터리: `C:\Users\user\OneDrive\Desktop\VScodetube` (현재 비어 있음)

---

## 0. 한 줄 요약

VS Code **Explorer 사이드바 하단**(Outline / Timeline 옆)에 작은 **YouTube 플레이어 뷰**를 추가하는 VS Code 익스텐션.
코딩 화면을 그대로 둔 채 유튜브를 볼 수 있어야 한다. 뷰를 숨기거나 다른 탭으로 이동해도 재생이 끊기면 안 된다.

---

## 1. 배경 지식 (반드시 읽고 시작)

### 1-1. 아키텍처 선택 이유

- VS Code 사이드바에 임의 HTML을 그리는 공식 방법은 `WebviewViewProvider` + `contributes.views` (`"type": "webview"`)다.
- Explorer 컨테이너에 뷰를 기여하면 Outline/Timeline처럼 접었다 펼 수 있는 섹션으로 붙는다. 사용자는 이 섹션을 우측 보조 사이드바나 패널로 드래그해 옮길 수 있다.

### 1-2. ⚠️ YouTube Error 153 문제 (핵심 제약)

- 2025년 9월부터 YouTube는 임베드 플레이어 요청에 **HTTP `Referer` 헤더가 없으면 Error 153**(Video player configuration error)을 띄운다.
- 데스크톱 VS Code 웹뷰는 `vscode-webview://` 커스텀 스킴에서 실행된다. Chromium은 http/https가 아닌 스킴에서는 Referer를 보내지 않는다(크롬 확장 페이지와 동일한 현상). 따라서 **웹뷰 HTML에 YouTube iframe을 직접 넣으면 재생이 안 될 가능성이 매우 높다.**
- **해결 구조: 이중 iframe**
  1. 익스텐션(Node)이 `127.0.0.1`의 임의 포트에 작은 HTTP 서버를 띄운다.
  2. 그 서버가 YouTube iframe을 감싼 `player` 페이지를 제공한다.
  3. 웹뷰 iframe → `http://127.0.0.1:PORT/player?v=VIDEO_ID` → 그 페이지 안의 YouTube iframe.
  4. YouTube는 `Referer: http://127.0.0.1:PORT/`를 받으므로 정상 재생된다.
- `127.0.0.1`/`localhost`는 Chromium이 "potentially trustworthy"로 취급하므로 mixed content로 막히지 않는다.

### 1-3. 기타 제약

- 웹뷰 CSP에서 `frame-src`를 열지 않으면 iframe이 빈 화면이 된다.
- `registerWebviewViewProvider` 옵션에 `retainContextWhenHidden: true`가 없으면 뷰가 숨겨질 때 웹뷰가 파괴되어 재생이 끊긴다.
- 소유자가 임베드를 금지한 영상(Error 101/150)은 익스텐션에서 해결 불가 → 사용자 안내만.
- VS Code의 Electron은 H.264/AAC 독점 코덱이 빠져 있는 것으로 알려져 있다. YouTube는 보통 VP9/Opus를 제공하므로 대부분 재생되지만, 안 되는 영상이 있으면 이 원인을 의심한다.

---

## 2. 기술 스택

| 항목 | 선택 |
|---|---|
| 언어 | TypeScript |
| 번들러 | esbuild (`yo code` 기본 템플릿) |
| 런타임 | VS Code Extension Host (Node.js) — `http`, `net`, `crypto` 내장 모듈 사용 |
| 최소 VS Code | `yo code`가 생성한 `engines.vscode` 값 그대로 (1.90 이상이면 충분) |
| 외부 의존성 | **없음** (런타임 npm 패키지 추가 금지) |
| 테스트 | 수동 검증(F5 Extension Development Host) + 단위 테스트는 `parseVideoId`만 |

---

## 3. 최종 파일 구조

```
VScodetube/
├─ .vscode/
│  ├─ launch.json          # yo code 생성
│  └─ tasks.json
├─ src/
│  ├─ extension.ts         # activate/deactivate, 커맨드·프로바이더 등록
│  ├─ playerServer.ts      # 127.0.0.1 로컬 HTTP 서버 (player 페이지 제공)
│  ├─ playerViewProvider.ts# WebviewViewProvider 구현 + 웹뷰 HTML
│  ├─ youtube.ts           # parseVideoId 등 URL 파싱 유틸
│  └─ test/
│     └─ youtube.test.ts   # parseVideoId 단위 테스트
├─ esbuild.js              # yo code 생성
├─ package.json
├─ tsconfig.json
├─ README.md
└─ CHANGELOG.md
```

---

## 4. package.json 명세

```jsonc
{
  "name": "vscodetube",
  "displayName": "VScodetube",
  "description": "Explorer 사이드바 하단에서 YouTube를 보면서 코딩",
  "publisher": "leejaehaeng",
  "version": "0.0.1",
  "engines": { "vscode": "^1.90.0" },        // yo code가 넣은 값이 더 높으면 그 값 유지
  "categories": ["Other"],
  "activationEvents": [],                    // 뷰가 열리면 자동 활성화 (1.74+)
  "main": "./dist/extension.js",
  "contributes": {
    "views": {
      "explorer": [
        { "type": "webview", "id": "vscodetube.player", "name": "YouTube" }
      ]
    },
    "commands": [
      { "command": "vscodetube.open",  "title": "VScodetube: YouTube URL 열기", "icon": "$(add)" },
      { "command": "vscodetube.clear", "title": "VScodetube: 플레이어 비우기",   "icon": "$(close)" }
    ],
    "menus": {
      "view/title": [
        { "command": "vscodetube.open",  "when": "view == vscodetube.player", "group": "navigation@1" },
        { "command": "vscodetube.clear", "when": "view == vscodetube.player", "group": "navigation@2" }
      ]
    },
    "configuration": {
      "title": "VScodetube",
      "properties": {
        "vscodetube.autoplay": {
          "type": "boolean", "default": true,
          "description": "영상을 열 때 자동 재생"
        },
        "vscodetube.restoreLastVideo": {
          "type": "boolean", "default": true,
          "description": "VS Code를 다시 열었을 때 마지막 영상을 복원"
        }
      }
    }
  }
}
```

---

## 5. 모듈별 상세 사양

### 5-1. `src/youtube.ts`

```ts
/** YouTube URL 또는 11자리 video ID → video ID. 인식 실패 시 undefined */
export function parseVideoId(input: string): string | undefined
```

지원해야 하는 입력 형식 (모두 테스트 케이스로 작성):

| 입력 | 결과 |
|---|---|
| `dQw4w9WgXcQ` | `dQw4w9WgXcQ` |
| `https://www.youtube.com/watch?v=dQw4w9WgXcQ` | `dQw4w9WgXcQ` |
| `https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL...` | `dQw4w9WgXcQ` |
| `https://youtu.be/dQw4w9WgXcQ?si=abc` | `dQw4w9WgXcQ` |
| `https://www.youtube.com/shorts/dQw4w9WgXcQ` | `dQw4w9WgXcQ` |
| `https://www.youtube.com/embed/dQw4w9WgXcQ` | `dQw4w9WgXcQ` |
| `https://www.youtube.com/live/dQw4w9WgXcQ` | `dQw4w9WgXcQ` |
| `https://m.youtube.com/watch?v=dQw4w9WgXcQ` | `dQw4w9WgXcQ` |
| `  https://youtu.be/dQw4w9WgXcQ  ` (공백 포함) | `dQw4w9WgXcQ` |
| `https://google.com` | `undefined` |
| `abc` | `undefined` |
| `` (빈 문자열) | `undefined` |

- video ID 패턴: `/^[\w-]{11}$/`
- 구현은 정규식 하나로 충분: `/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/`

### 5-2. `src/playerServer.ts`

```ts
export interface PlayerServer { port: number; dispose(): void; }
export function startPlayerServer(): Promise<PlayerServer>
```

요구사항:

- `http.createServer` 사용, **`127.0.0.1`에만 바인드**, 포트는 `0`(OS가 할당). `listen` 콜백에서 `(server.address() as AddressInfo).port` 반환.
- 라우팅:
  - `GET /player?v=<id>` → `id`가 `/^[\w-]{11}$/`에 맞을 때만 200 + HTML. 아니면 400.
  - 그 외 경로 → 404. 어떤 경우에도 파일시스템을 읽지 않는다.
- 응답 헤더: `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`.
- `autoplay` 쿼리(`0`/`1`)도 받아 iframe URL의 `autoplay` 파라미터에 반영.
- 제공할 HTML (정확히 이 구조 유지):

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="referrer" content="strict-origin-when-cross-origin">
<style>html,body{margin:0;height:100%;background:#000}iframe{width:100%;height:100%;border:0}</style>
</head><body>
<iframe
  src="https://www.youtube-nocookie.com/embed/{VIDEO_ID}?autoplay={0|1}&enablejsapi=1&rel=0"
  referrerpolicy="strict-origin-when-cross-origin"
  allow="autoplay; encrypted-media; picture-in-picture"
  allowfullscreen></iframe>
</body></html>
```

- `dispose()`는 `server.close()`. `activate`에서 `context.subscriptions`에 등록해 종료 시 정리.
- 서버 시작 실패(`error` 이벤트) 시 Promise reject → `activate`에서 `showErrorMessage`로 안내.

### 5-3. `src/playerViewProvider.ts`

```ts
export class PlayerViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'vscodetube.player';
  constructor(context: vscode.ExtensionContext, port: number)
  resolveWebviewView(view: vscode.WebviewView): void
  play(input: string): Promise<void>
  clear(): Promise<void>
}
```

동작:

- 생성자: `restoreLastVideo` 설정이 true면 `context.globalState.get('lastVideo')`로 마지막 ID 로드.
- `resolveWebviewView`:
  - `view.webview.options = { enableScripts: true }`
  - `view.webview.html = this.getHtml()` — 현재 videoId가 있으면 iframe `src`를 미리 채워서 렌더.
- `play(input)`:
  1. `parseVideoId` 실패 → `showWarningMessage('YouTube URL을 인식하지 못했어요.')` 후 종료.
  2. `videoId` 저장, `globalState.update('lastVideo', id)`.
  3. 뷰가 이미 resolve됐으면 `view.show(true)` + `webview.postMessage({ type: 'play', src })`.
  4. 아직 resolve 안 됐으면 `vscode.commands.executeCommand('vscodetube.player.focus')` (VS Code가 뷰마다 자동 생성하는 `<viewId>.focus` 커맨드). resolve 시점에 저장된 videoId로 렌더되므로 별도 전송 불필요.
- `clear()`: videoId 제거, `globalState` 삭제, 웹뷰에 `{ type: 'clear' }` 전송 → iframe `src=''`.
- 플레이어 URL: `` `http://127.0.0.1:${port}/player?v=${id}&autoplay=${autoplay ? 1 : 0}` ``

웹뷰 HTML 요구사항:

- CSP: `default-src 'none'; frame-src http://127.0.0.1:${port}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`
  - nonce는 `crypto.randomBytes(16).toString('hex')`.
- 레이아웃: `body{margin:0;padding:4px}`, `iframe{width:100%;aspect-ratio:16/9;border:0;background:#000}`.
- iframe 속성: `id="yt"`, `allow="autoplay; encrypted-media; picture-in-picture"`.
- videoId가 없을 때는 iframe 대신 안내 문구 표시: "상단 + 버튼으로 YouTube URL을 열어보세요." (VS Code 테마 변수 `var(--vscode-descriptionForeground)` 사용). URL 설정 시 스크립트에서 안내 문구 숨기고 iframe 표시.
- 스크립트:

```js
const f = document.getElementById('yt');
const empty = document.getElementById('empty');
window.addEventListener('message', e => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'play')  { f.src = m.src; f.hidden = false; empty.hidden = true; }
  if (m.type === 'clear') { f.src = '';    f.hidden = true;  empty.hidden = false; }
});
```

### 5-4. `src/extension.ts`

```ts
export async function activate(context: vscode.ExtensionContext) {
  // 1) 서버 시작 (실패 시 에러 메시지 후 return)
  // 2) PlayerViewProvider 생성
  // 3) registerWebviewViewProvider(viewId, provider, { webviewOptions: { retainContextWhenHidden: true } })
  // 4) 커맨드 등록
  //    - vscodetube.open  : showInputBox({ prompt: 'YouTube URL 또는 video ID', ignoreFocusOut: true }) → provider.play
  //    - vscodetube.clear : provider.clear
  // 5) 모두 context.subscriptions에 push
}
export function deactivate() {}
```

- `activate`는 `async`이며 서버가 뜬 **뒤에** 프로바이더를 등록한다 (포트를 알아야 CSP/URL을 만들 수 있음).

---

## 6. 작업 순서 (Phase)

각 Phase 끝에 `npm run compile`(또는 esbuild 빌드)이 통과해야 다음으로 넘어간다. Phase마다 git 커밋 1개.

### Phase 0 — 스캐폴딩
1. `git init` (아직 안 되어 있으면).
2. `npx --package yo --package generator-code -- yo code` 실행 — 선택지:
   - New Extension (TypeScript)
   - name: `vscodetube`, identifier: `vscodetube`
   - bundler: **esbuild**, package manager: npm
   - git init: No (이미 했으므로)
   - **현재 디렉터리에 바로 생성**되도록 한다. 하위 폴더가 생기면 내용물을 루트로 옮긴다.
3. 템플릿이 만든 `helloWorld` 커맨드·샘플 코드는 삭제.
4. `npm install` 후 빌드 통과 확인.

### Phase 1 — `youtube.ts` + 단위 테스트
- `parseVideoId` 구현.
- `src/test/youtube.test.ts`에 5-1 표의 케이스 전부 작성 (`npm test` 또는 템플릿의 테스트 러너로 실행 가능해야 함).

### Phase 2 — `playerServer.ts`
- 5-2 사양대로 구현.
- 수동 확인: 임시로 `activate`에서 포트를 `console.log`한 뒤, 브라우저에서 `http://127.0.0.1:PORT/player?v=dQw4w9WgXcQ` 열어 재생되는지 확인. 확인 후 로그 제거.

### Phase 3 — `playerViewProvider.ts` + `package.json` contributes
- 5-3, 4장 사양대로 구현.
- F5 → Extension Development Host → Explorer 하단에 "YouTube" 섹션이 보여야 함.

### Phase 4 — `extension.ts` 통합 + 커맨드
- 5-4 사양대로 연결.
- 7장 검증 체크리스트 전부 통과.

### Phase 5 — 마무리
- `README.md`: 기능, 사용법(+ 버튼 → URL), 섹션을 우측 보조 사이드바로 옮기는 방법, 알려진 제한(임베드 금지 영상, 코덱).
- `CHANGELOG.md` 0.0.1 항목.
- `npx @vscode/vsce package`로 `.vsix` 생성이 되는지 확인 (publisher 없으면 `--allow-missing-repository` 등 필요한 플래그 사용).

---

## 7. 검증 체크리스트 (Phase 4 완료 조건)

- [ ] F5 실행 시 Explorer 하단에 "YouTube" 섹션이 표시된다.
- [ ] 섹션 타이틀의 `+` 버튼 → URL 입력 → 영상이 재생된다 (`youtube.com/watch`, `youtu.be`, `shorts` 각각 1회).
- [ ] **Error 153이 뜨지 않는다.** (뜨면 Referer 문제 → 이중 iframe 구조가 깨진 것)
- [ ] 다른 액티비티바 탭(검색 등)으로 이동했다가 돌아와도 재생이 끊기지 않는다.
- [ ] 섹션을 접었다 펴도 재생이 끊기지 않는다.
- [ ] 섹션 경계를 드래그하면 플레이어가 16:9를 유지하며 크기가 바뀐다.
- [ ] `X` 버튼으로 비우면 안내 문구가 다시 보인다.
- [ ] Extension Development Host를 닫고 다시 F5하면 마지막 영상이 복원된다 (`restoreLastVideo` true일 때).
- [ ] `vscodetube.autoplay`를 false로 바꾸면 자동 재생되지 않는다.
- [ ] 잘못된 URL 입력 시 경고 메시지가 뜨고 아무 일도 일어나지 않는다.
- [ ] 익스텐션 비활성화 시 로컬 서버가 닫힌다 (포트가 해제됨).
- [ ] `npm run lint`(있다면)와 빌드가 경고 없이 통과한다.

---

## 8. 하지 말아야 할 것

- 런타임 npm 의존성 추가 금지 (내장 `http`/`net`/`crypto`만).
- 로컬 서버를 `0.0.0.0`에 바인드하지 말 것. 고정 포트 사용 금지(포트 `0`).
- 로컬 서버에서 파일시스템을 읽거나 임의 경로를 서빙하지 말 것.
- 웹뷰 CSP에 `'unsafe-inline'` 스크립트나 `*` 와일드카드 넣지 말 것.
- YouTube Data API 키, 검색 기능, 재생목록 등 MVP 범위 밖 기능은 이번에 구현하지 말 것 (아래 "이후 확장"으로 남김).
- `retainContextWhenHidden` 제거 금지.

---

## 9. 이후 확장 아이디어 (이번 범위 아님, 구현 금지)

- 상태바 재생/일시정지 버튼: 익스텐션 → 웹뷰 → player 페이지 → YouTube iframe으로 `postMessage` 체인을 잇고, 마지막에 `{"event":"command","func":"pauseVideo","args":[]}` JSON 전송 (`enablejsapi=1` 플레이어가 반응).
- 재생 기록 / 즐겨찾기 (globalState).
- 별도 액티비티바 컨테이너(`viewsContainers`) 옵션.

---

## 10. 작업 방식 지시 (Claude Code에게)

- 이 문서의 사양이 애매할 때만 질문하고, 그 외에는 질문 없이 진행한다.
- Phase 순서를 지키고, 각 Phase가 끝날 때 무엇을 했고 어떻게 검증했는지 3줄 이내로 보고한다.
- F5 수동 검증이 필요한 항목(7장)은 사용자가 직접 확인해야 하므로, 그 시점에 "지금 F5로 확인해주세요 — 확인할 항목: …" 형태로 멈춰서 요청한다.
- 코드 주석은 한국어로, 짧게.

---

## 11. 구현 중 변경 사항 (2026-10-15, 사용자 승인)

검증 중 발견된 제약 때문에 1-2절 구조를 다음과 같이 바꿨다.

1. **플레이어 URL 호스트 `127.0.0.1` → `localhost`**
   크롬에서 비교한 결과 YouTube가 `127.0.0.1`(IP) Referer를 일부 영상에서 거부("이 동영상은 볼 수 없습니다")했고, `localhost`에서는 정상 재생됐다. 서버 바인드는 계속 `127.0.0.1`.
2. **재생 위치: 사이드바 웹뷰 → 외부 미니 창**
   VS Code 내장 Electron의 `ffmpeg.dll`에는 독점 코덱이 빠져 있다. 반면 `MediaSource.isTypeSupported`/`mediaCapabilities`는 지원한다고 보고한다. 그래서 YouTube가 해당 코덱을 고르고 재생이 멈춘다("An error occurred"). 순수 Electron 43에 VS Code의 `ffmpeg.dll`만 교체해 재현했다. 익스텐션에서는 해결할 수 없다.
   → 시스템 Edge/Chrome을 `--app` 모드 + 전용 `--user-data-dir`로 띄워 `http://localhost:PORT/player`를 재생한다. 이미 열린 창은 `/events`(SSE)로 영상만 교체한다. 사이드바 뷰는 썸네일·상태 표시와 창 다시 열기만 담당한다.
   - 새 설정: `vscodetube.browserPath` (비우면 Edge → Chrome 자동 탐색, 없으면 기본 브라우저 탭)
   - `restoreLastVideo`: 사이드바에 마지막 영상을 표시만 하고 창은 자동으로 띄우지 않는다.
