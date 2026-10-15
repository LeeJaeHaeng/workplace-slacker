# VScodetube

VS Code **Explorer 사이드바 하단**(Outline / Timeline 옆)에서 YouTube를 보면서 코딩하는 익스텐션.

## 기능

- Explorer 하단 "YouTube" 섹션에 16:9 플레이어 표시
- 다른 탭으로 이동하거나 섹션을 접어도 재생 유지
- 마지막으로 연 영상 복원

## 사용법

1. Explorer 하단 **YouTube** 섹션 제목의 `+` 버튼 클릭 (또는 명령 팔레트 `VScodetube: YouTube URL 열기`)
2. YouTube URL 또는 11자리 video ID 입력
   - `youtube.com/watch?v=…`, `youtu.be/…`, `/shorts/…`, `/embed/…`, `/live/…` 지원
3. `X` 버튼으로 플레이어 비우기

### 섹션을 우측 보조 사이드바로 옮기기

YouTube 섹션 제목을 드래그해 우측 보조 사이드바(`Ctrl+Alt+B`로 열기)나 하단 패널에 놓으면 됩니다.

## 설정

| 설정 | 기본값 | 설명 |
|---|---|---|
| `vscodetube.autoplay` | `true` | 영상을 열 때 자동 재생 |
| `vscodetube.restoreLastVideo` | `true` | VS Code를 다시 열었을 때 마지막 영상 복원 |

## 동작 방식

YouTube는 Referer 헤더가 없는 임베드 요청을 Error 153으로 막는데, VS Code 웹뷰(`vscode-webview://`)는 Referer를 보내지 않습니다.
그래서 익스텐션이 `127.0.0.1`의 임의 포트에 작은 HTTP 서버를 띄우고, 웹뷰 → `http://localhost:PORT/player` → YouTube iframe 순서의 이중 iframe으로 재생합니다.

## 알려진 제한

- 소유자가 임베드를 금지한 영상(Error 101/150)은 재생할 수 없습니다.
- 플레이어 주소는 `127.0.0.1` 대신 `localhost`를 씁니다. YouTube가 IP 주소 Referer를 일부 영상에서 거부하기 때문입니다.
- Extension Development Host(F5) 창에서는 재생이 실패할 수 있습니다. 설치형(`.vsix`)으로 확인하세요.
