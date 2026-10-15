# Change Log

## [0.0.2] - 2026-10-15

### 수정
- VS Code 창을 여러 개 열면 두 번째 창에서 "브라우저 연결이 끊어졌어요"가 뜨던 문제. 같은 브라우저 프로필을 쓰면 브라우저가 바로 종료되므로, 창마다 비어 있는 프로필을 찾아 씀

## [0.0.1] - 2026-10-15

첫 릴리스. 팀장님께는 비밀.

### 추가
- Explorer 사이드바 하단 **YouTube** 섹션
- headless Chrome/Edge로 youtube.com(PC 버전)을 열고 화면을 사이드바에 미러링, 클릭·휠·키보드(한글 IME, `Ctrl+V`) 입력 전달
- 영상 페이지에서 플레이어로 섹션 꽉 채우기 (`Esc`로 해제)
- 상단 버튼: 뒤로 / 홈 / 새로고침 / 검색·URL 열기 / 닫기
- 설정: `autoplay`, `autoFullscreen`, `restoreLastVideo`, `pageWidth`, `browserPath`
- "유료 광고 포함" 표시 숨김, VS Code 테마에 맞춘 다크/라이트
- 출력 패널 **VScodetube** 로그 채널

### 우회한 문제
- YouTube Error 153 (웹뷰에 Referer 없음)
- VS Code 웹뷰의 Opus 오디오 디코딩 불가 → 재생을 시스템 브라우저에 맡김
- headless 탐지로 인한 재생 중 에러 (Client Hints, `navigator.webdriver`)
