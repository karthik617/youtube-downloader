const express = require('express');
const package = require('./package.json');
const app = express();
const cors = require('cors');
const PORT = 3001;
const router = require('./routes');

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'] }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Download-Id');
  next();
});

app.get('/', (req, res) => res.send('Hello from Backend!'));
app.get('/health', (req, res) => res.json({ status: 200, message: 'OK' }));
app.get('/version', (req, res) => res.json({ version: package.version }));

app.use('/api', router);

app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
