# 할일 캡처

단체메일 공문이나 화면 일부를 캡처(Win+Shift+S)해서 위젯에 Ctrl+V 하면, 원격 MCP 서버(`extract_todos`)가 할일을 뽑아 위젯에 쌓아 줍니다. 이미지 파일을 끌어다 놓아도 됩니다.

## 설정

| 항목 | 환경변수 | `config.json` 키 |
| --- | --- | --- |
| MCP 엔드포인트 | `MCP_URL` (예: `http://127.0.0.1:8787/mcp`) | `mcp_url` |
| 인증 토큰 (`Authorization: Bearer …`) | `MCP_TOKEN` | `mcp_token` |

`config.json` 은 데이터 폴더에 두며 환경변수보다 우선합니다. 캡처마다 다시 읽으므로 앱을 재시작하지 않아도 됩니다. 데이터 폴더는 `CAPTURE_TODO_DATA` 로 바꿀 수 있고, 기본값은 Windows `%APPDATA%\capture-todo`, macOS `~/Library/Application Support/capture-todo` 입니다. 캡처 이미지(`images/`)와 `store.json` 이 여기에 저장됩니다.

## 웹 테스트 모드

같은 앱을 브라우저에서 띄웁니다.

```sh
pnpm install
pnpm build                                   # ui/dist 생성
cargo run -p core --example fake_mcp         # 선택: 가짜 MCP 서버 (127.0.0.1:8787, 토큰 devtoken)
MCP_URL=http://127.0.0.1:8787/mcp MCP_TOKEN=devtoken cargo run -p core --bin web
```

http://127.0.0.1:47321 을 열고 이미지를 붙여 넣습니다. UI를 고치면서 보려면 `pnpm dev` 로 http://localhost:5173 을 엽니다(`/api` 는 47321로 프록시).

## Windows 개발·빌드

Rust, Node.js, pnpm, [Tauri 2 사전 요구사항](https://v2.tauri.app/start/prerequisites/)(WebView2, MSVC 빌드 도구)이 필요합니다.

```powershell
pnpm install
$env:MCP_URL="https://…/mcp"; $env:MCP_TOKEN="…"
pnpm tauri dev      # 개발 실행
pnpm tauri build    # 설치 파일: target\release\bundle\
```

배포된 앱에는 환경변수 대신 `%APPDATA%\capture-todo\config.json` 을 둡니다.

```json
{ "mcp_url": "https://…/mcp", "mcp_token": "…" }
```

## 동작 메모

- 분석은 30~180초 걸리며 240초가 지나면 실패로 표시됩니다. 실패 칩을 누르면 재시도합니다.
- 같은 캡처를 재시도해도 제목이 같은 할일은 중복으로 추가되지 않습니다. 다른 캡처끼리는 중복을 거르지 않습니다.
- 앱이 분석 도중 종료되면 다음 실행 때 그 캡처는 "앱 재시작으로 중단" 실패로 바뀌고 재시도할 수 있습니다.
- 위젯은 항상 위, 테두리 없음, 작업표시줄 숨김입니다. 제목 줄을 끌어 옮기고 × 로 종료합니다.
