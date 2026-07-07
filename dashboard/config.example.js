// config.example.js → 이 파일을 config.js로 복사해 값 채우기 (config.js는 gitignore됨)
// 값이 비어 있으면 대시보드는 데모 데이터 모드로 동작
window.DASH_CONFIG = {
  SUPABASE_URL: '',        // https://YOUR-PROJECT.supabase.co
  SUPABASE_ANON_KEY: '',   // anon key (읽기 전용 — RLS로 쓰기 차단됨)
  N8N_PROXY_URL: '',       // https://<인스턴스>.app.n8n.cloud/webhook/proxy
  N8N_PROXY_SECRET: '',    // WF4 Header Auth credential 값과 동일
  LLM_COMMENTS: true,      // 상위 3건 Claude 코멘트 (n8n에 Anthropic credential 필요 — 없으면 자동 숨김. false=끄기)
  // 아사나 태스크 생성 폼의 프로젝트 선택지
  ASANA_PROJECTS: [
    // { gid: '120xxxxxxxxxxxxx', name: '프로젝트 이름' }
  ]
};
