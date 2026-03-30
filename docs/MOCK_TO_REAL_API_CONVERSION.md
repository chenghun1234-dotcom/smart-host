# Mock → SmartThings API 변환 가이드

## 📊 아키텍처 변경

### Before (Mock 모드)
```
호스트 스마트폰
    ↓ (SmartThings App)
SmartThings 클라우드
    ↓ (Webhook)
Render 백엔드 (Mock)
    ↓ (IOT_CONTROL)
로컬 에이전트 (Tuya/HA)
    ↓
스마트 플러그
```

### After (SmartThings API 통합)
```
호스트 스마트폰
    ↓ (OAuth 로그인)
Onyx AI 웹 사이트
    ↓ (SmartThings 기기 목록)
Render 백엔드
    ├── SmartThings API 호출 (기기 제어)
    └── 로컬 에이전트 (폴백: Tuya/HA)
```

---

## 🔄 핵심 변경 사항

### 1. SmartThings API 클라이언트 추가
**파일:** `kraken-backend/services/smartthingsService.js`

- `listDevices(accessToken)`: 호스트의 SmartThings 기기 목록 조회
- `executeDeviceCommand(accessToken, deviceId, powerOn)`: 기기에 제어 명령 실행
- `getMockDevices()`: Mock 테스트용 가짜 기기

### 2. 호스트 토큰 저장소
**파일:** `kraken-backend/server.js` (라인 85-100)

```javascript
const hostTokenStore = new Map();

function storeHostToken(hostId, accessToken, refreshToken) {
  hostTokenStore.set(hostId, { accessToken, refreshToken, storedAt: ... });
}

function getHostToken(hostId) {
  return hostTokenStore.get(hostId)?.accessToken ?? null;
}
```

- 호스트가 OAuth 로그인할 때마다 토큰 저장
- 실제 운영에서는 데이터베이스 권장

### 3. 새 REST 엔드포인트
**GET `/api/devices?hostId=default-host`**

```javascript
// 응답
{
  "success": true,
  "count": 2,
  "devices": [
    {
      "deviceId": "mock-device-001",
      "name": "Onyx 에어컨 컨트롤러",
      "label": "Onyx Smart Plug",
      "type": "SmartPlug",
      "status": "ONLINE",
      "components": [...]
    }
  ]
}
```

### 4. SmartThings Discovery 개선
**POST `/st/webhook` (discoveryRequest)**

이전:
```javascript
// 하드코딩된 기기 반환
endpoints: [{
  endpointId: 'onyx-plug-01',
  friendlyName: 'Onyx 에어컨 컨트롤러',
  ...
}]
```

지금:
```javascript
// Mock 테스트 기기 반환
const mockDevices = smartthingsService.getMockDevices();
const endpoints = mockDevices.map(d => ({...}));
```

### 5. SmartThings Command 실행 개선
**POST `/st/webhook` (commandRequest)**

이전:
```javascript
// 로컬 에이전트로만 전달
sendToAgent(agentId, { type: 'IOT_CONTROL', ... });
```

지금:
```javascript
if (isMockOauthEnabled()) {
  // Mock 모드: 로컬 에이전트 사용
  sendToAgent(agentId, { type: 'IOT_CONTROL', ... });
} else {
  // 실제 모드: SmartThings API 호출
  await smartthingsService.executeDeviceCommand(token, deviceId, powerOn);
}
```

---

## 🧪 로컬 테스트 (Mock 모드)

### 백엔드 시작
```bash
cd kraken-backend
npm install
OAUTH_MOCK_MODE=true MOCK_AGENT_ID=r1 npm start
```

### 로컬 에이전트 시작
```bash
cd smart-host-agent
npm install
SERVER_WS=ws://localhost:3001/ws AGENT_ID=r1 node index.js
```

### 기기 목록 조회
```bash
curl http://localhost:3001/api/devices?hostId=default-host
```

응답:
```json
{
  "success": true,
  "count": 1,
  "devices": [
    {
      "deviceId": "mock-device-001",
      "name": "Onyx 에어컨 컨트롤러",
      ...
    }
  ]
}
```

### SmartThings Discovery 테스트
```bash
curl -X POST http://localhost:3001/st/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "interactionType": "discoveryRequest",
      "requestId": "test-1"
    },
    "payload": {}
  }'
```

응답:
```json
{
  "headers": {
    "interactionType": "discoveryResponse",
    "requestId": "test-1"
  },
  "payload": {
    "endpoints": [
      {
        "endpointId": "mock-device-001",
        "friendlyName": "Onyx 에어컨 컨트롤러",
        ...
      }
    ]
  }
}
```

### SmartThings Command 테스트
```bash
curl -X POST http://localhost:3001/st/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "interactionType": "commandRequest",
      "requestId": "cmd-1"
    },
    "payload": {
      "commands": [{"command": "on"}],
      "externalDeviceId": "mock-device-001"
    }
  }'
```

기대하는 로컬 에이전트 로그:
```
[IOT_CONTROL] mock-device-001 SET_POWER true
[TUYA] mock-device-001 power=true
```

또는
```
[IOT_CONTROL] mock-device-001 SET_POWER true
[HA] switch.onyx_smart_plug_1 turned on
```

---

## 📋 실제 배포 (SmartThings API 통합)

### Render 환경변수 설정
```
OAUTH_MOCK_MODE=false                    # ← 실제 모드 활성화
OAUTH_CLIENT_ID=your_smartthings_app_id
OAUTH_CLIENT_SECRET=your_smartthings_secret
OAUTH_REDIRECT_URIS=https://yourwebsite.com/oauth/callback
```

### 호스트 로그인 플로우
1. 호스트가 "SmartThings로 연결" 클릭
2. SmartThings OAuth 화면으로 리다이렉트
3. 호스트 스마트폰에서 SmartThings 계정으로 로그인
4. `access_token`과 `refresh_token` 발급
5. 토큰이 `hostTokenStore`에 저장됨
6. 호스트의 기기 목록이 자동으로 조회됨

### 기기 제어 플로우
1. SmartThings 앱에서 "Onyx 에어컨 컨트롤러"의 on/off 클릭
2. SmartThings 클라우드가 Webhook으로 명령 전송
3. 백엔드에서 SmartThings API 호출 (실제 모드)
4. 또는 로컬 에이전트에 메시지 전송 (Mock 모드)
5. 로컬 에이전트가 Tuya 또는 HA를 통해 기기 제어

---

## 🔐 토큰 보안 고려사항

현재 구현 (프로토타입용):
- 메모리에 토큰 저장 (서버 재시작 시 손실)
- 호스트ID 간 토큰 분리 없음

프로덕션 권장:
- PostgreSQL에 암호화된 토큰 저장
- 호스트별 토큰 만료 시간 관리
- Refresh token으로 자동 갱신
- 토큰 로테이션 정책 구현

---

## 🚀 다음 단계

1. ✅ Mock API 구조 정리 완료
2. ⏳ Render 배포 및 엔드포인트 검증
3. ⏳ SmartThings 앱 등록 및 OAuth 설정
4. ⏳ 실제 기기로 E2E 테스트
5. ⏳ 데이터베이스 연동 (프로덕션)

---

## 📝 주의사항

- **로컬 테스트:** `OAUTH_MOCK_MODE=true` 필수
- **배포:** `OAUTH_MOCK_MODE=false` 또는 미설정
- **에이전트:** 로컬 에이전트는 여전히 Tuya/HA 폴백 역할
- **기기 맵핑:** SmartThings deviceId가 정확해야 함

---

## 💡 트러블슈팅

### /api/devices에서 401 반환
- 호스트 토큰이 저장되지 않음
- OAuth 로그인 플로우 완료 필요

### commandRequest에서 503 반환
- 로컬 에이전트 미연결 (Mock 모드)
- SmartThings API 호출 실패 (실제 모드)

### Mock 모드에서 기기가 안 보임
- `OAUTH_MOCK_MODE=true` 확인
- Discovery response의 `endpoints` 배열 확인

