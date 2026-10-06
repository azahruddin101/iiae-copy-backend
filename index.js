const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('./src/config/db');

// Load environment variables
dotenv.config();

// Connect to MongoDB Database & Auto-Seed admin
connectDB();

const app = express();

// Meta Lead Ads webhook - registered before the JSON body parser because signature verification needs the raw body
app.use('/api/webhooks/meta', require('./src/routes/metaWebhookRoutes'));

// Body parser middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Enable CORS
// app.use(
//   cors({
//     origin: true, // Allow all origins for local testing
//     methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
//     allowedHeaders: ['Content-Type', 'Authorization'],
//     credentials: true,
//   })
// );

app.use(cors());
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  index: false,
  dotfiles: 'deny',
  maxAge: '7d',
}));

// Logging middleware in development
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// Routes registration
app.use('/api/auth', require('./src/routes/authRoutes'));
app.use('/api/users', require('./src/routes/userRoutes'));
app.use('/api/leads', require('./src/routes/leadRoutes'));
app.use('/api/registrations', require('./src/routes/registrationRoutes'));
app.use('/api/courses', require('./src/routes/courseRoutes'));
app.use('/api/batches', require('./src/routes/batchRoutes'));
app.use('/api/exams', require('./src/routes/examRoutes'));
app.use('/api/payments', require('./src/routes/feeRoutes'));
app.use('/api/announcements', require('./src/routes/announcementRoutes'));
app.use('/api/dashboard', require('./src/routes/dashboardRoutes'));
app.use('/api/settings', require('./src/routes/settings'));
app.use('/api/newsletters', require('./src/routes/newsletters'));
app.use('/api/integrations/meta', require('./src/routes/metaRoutes'));

// Background worker that retrieves queued Meta leads (idle until Meta is set up on the Integrations page)
require('./src/workers/metaLeadWorker').startMetaLeadWorker();

// Root Status check
app.get('/', (req, res) => {
  res.send('Innovbit College CRM API is running successfully...');
});

// Error handling middleware for uncaught exceptions
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err.stack);
  res.status(500).json({
    message: err.message || 'An internal server error occurred',
  });
});

// macOS AirPlay Receiver uses 5000 by default; use 5001 for local API
const PORT = process.env.PORT || 5001;

app.listen(PORT, () => {
  console.log(`Innovbit CRM Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
});
