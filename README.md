# Kraken Backend (MVP)

## 실행

```bash
cd kraken-backend
npm install
npm start
```

기본 포트는 `3000`이며, `PORT` 환경변수로 변경할 수 있습니다.

## API

- `GET /api/v1/health`
- `GET /api/v1/rooms`
- `POST /api/v1/devices/:id/toggle`
  - body: `{ "isPowerOn": true | false }`
- `POST /api/v1/sync/:id`

