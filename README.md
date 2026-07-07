# 통합 관리 대시보드

두 업무 축(아사나 프로젝트 / 슬랙 Lists·멘션)을 한 화면에서 병렬로 보고 조작하는 개인용 컨트롤 타워. 순수 정적 SPA로, GitHub Pages에서 서빙됩니다.

## 구성

- [`dashboard/index.html`](dashboard/index.html) — 3분할 대시보드 (통합 우선순위 / 아사나 / 슬랙)
- [`dashboard/priority.js`](dashboard/priority.js) — 규칙 기반 우선순위 엔진 (마감·요청자·축·부하 가중치, KST 판정)
- [`dashboard/test-priority.html`](dashboard/test-priority.html) — 엔진 테스트 (브라우저에서 열면 자동 실행)

## 사용

1. 페이지를 열면 **데모 데이터 모드**로 시작합니다.
2. 우상단 **⚙ 설정**에서 백엔드(Supabase 읽기 / n8n 쓰기 프록시) 정보를 입력하면 실데이터로 전환 — 설정은 **해당 브라우저의 localStorage에만** 저장되며 저장소에는 어떤 키도 포함되지 않습니다.
3. 로컬 개발 시에는 `dashboard/config.example.js`를 `config.js`로 복사해 사용 (gitignore 처리됨).

> 시크릿이 브라우저에 저장되므로 공용 PC에서는 설정하지 마세요.

## 아키텍처

읽기는 Supabase REST(anon key, RLS 읽기 전용)를 직접 호출하고, 모든 쓰기는 인증된 n8n 프록시를 경유합니다. 프론트에 API 키를 두지 않는 것이 설계 원칙입니다. 동기화 워크플로(웹훅·폴링·알림)는 이 저장소에 포함되지 않습니다.
