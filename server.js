const express = require('express');
const cors = require('cors');

const apiRoutes = require('./routes/apiRoutes');

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('Kraken backend is running. Try /api/v1/health');
});

app.use('/api/v1', apiRoutes);

app.listen(PORT, () => {
  console.log(
    `Kraken AI Host 백엔드 서버가 http://localhost:${PORT} 에서 실행 중입니다.`,
  );
});
