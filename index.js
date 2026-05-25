const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Serve config.json with caching disabled for development
app.get('/config.json', (req, res) => {
  try {
    const configPath = path.join(__dirname, 'config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.json(JSON.parse(configData));
  } catch (error) {
    console.error('Error reading config.json:', error);
    res.status(500).json({ error: 'Failed to load configuration' });
  }
});

// API endpoint to get current stock
app.get('/api/stock', (req, res) => {
  try {
    const configPath = path.join(__dirname, 'config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    res.json({ 
      stock: config.stock || 3,
      price: config.price || 2,
      currency: config.currency || '₱'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stock' });
  }
});

// API endpoint to update stock (admin use or purchase simulation)
app.post('/api/update-stock', (req, res) => {
  try {
    const { quantity } = req.body;
    const configPath = path.join(__dirname, 'config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    
    let newStock = config.stock - (quantity || 1);
    if (newStock < 0) newStock = 0;
    
    config.stock = newStock;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    
    res.json({ 
      success: true, 
      stock: newStock,
      message: newStock === 0 ? 'Out of stock!' : `${newStock} remaining`
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update stock' });
  }
});

// API endpoint to get all product images
app.get('/api/images', (req, res) => {
  try {
    const configPath = path.join(__dirname, 'config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    res.json({ images: config.images || [] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch images' });
  }
});

// API endpoint to get account details
app.get('/api/account-details', (req, res) => {
  try {
    const configPath = path.join(__dirname, 'config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    res.json({ 
      accountDetails: config.accountDetails || {
        hoursOld: "~ 48-72 hours",
        emailAccess: "NO ACCESS",
        canChangeName: "YES"
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch account details' });
  }
});

// Health check endpoint for Vercel
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    shop: 'Buffalo\'s Shop',
    version: '1.0.0'
  });
});

// Serve index.html for root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handle 404 errors - serve custom 404 page
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Global error handler for 500 errors
app.use((err, req, res, next) => {
  console.error('Server Error:', err.stack);
  res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🦬 Buffalo's Shop is running!`);
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`💰 Price: ₱2 per Facebook account`);
  console.log(`📦 Stock: Check config.json`);
  console.log(`🌓 Dark/Light mode available`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});