const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

// Serve config.json
app.get('/config.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'config.json'));
});

// Error handling
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Buffalo's Shop running on http://localhost:${PORT}`);
});