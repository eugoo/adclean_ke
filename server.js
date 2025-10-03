const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// ✅ ADD THIS CODE TO SERVE FRONTEND FILES
const path = require('path');
app.use(express.static(path.join(__dirname, '../frontend')));

// Serve frontend pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('/setup-instructions', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/setup-instructions.html'));
});
// ✅ END OF ADDED CODE

// Your existing database connection and other code continues...


// Database connection
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'freemymind',
  database: process.env.DB_NAME || 'adclean_ke',
  connectionLimit: 10,
  acquireTimeout: 60000,
  timeout: 60000,
  reconnect: true
};

// Create connection pool
const pool = mysql.createPool(dbConfig);

// M-Pesa credentials
const MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  shortcode: process.env.MPESA_SHORTCODE,
  passkey: process.env.MPESA_PASSKEY,
  callbackURL: process.env.MPESA_CALLBACK_URL || `${process.env.BASE_URL}/api/mpesa-callback`
};

// Email configuration
const emailConfig = {
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
};

const transporter = nodemailer.createTransporter(emailConfig);

// Initialize database
async function initializeDatabase() {
  try {
    const connection = await pool.getConnection();
    
    // Create customers table
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS customers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        phone VARCHAR(20) NOT NULL,
        plan ENUM('trial', 'basic', 'gamer', 'venue') NOT NULL,
        status ENUM('active', 'inactive', 'trial', 'expired') DEFAULT 'trial',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NULL,
        INDEX idx_email (email),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    
    // Create payments table
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        customer_id INT,
        transaction_id VARCHAR(255) UNIQUE,
        amount DECIMAL(10,2) NOT NULL,
        payment_method ENUM('mpesa', 'paypal') NOT NULL,
        status ENUM('pending', 'completed', 'failed', 'cancelled') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
        INDEX idx_transaction (transaction_id),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    
    // Create subscriptions table
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        customer_id INT,
        plan ENUM('trial', 'basic', 'gamer', 'venue') NOT NULL,
        status ENUM('active', 'inactive', 'cancelled') DEFAULT 'active',
        start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        end_date TIMESTAMP NULL,
        auto_renew BOOLEAN DEFAULT TRUE,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
        INDEX idx_customer (customer_id),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    
    console.log('✅ Database initialized successfully');
    connection.release();
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

// M-Pesa authentication
async function getMpesaAccessToken() {
  try {
    const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
    
    const response = await axios.get(
      process.env.NODE_ENV === 'production' 
        ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
        : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${auth}`
        },
        timeout: 10000
      }
    );
    
    return response.data.access_token;
  } catch (error) {
    console.error('❌ M-Pesa authentication error:', error.response?.data || error.message);
    throw new Error('M-Pesa service unavailable');
  }
}

// Initiate M-Pesa STK Push
app.post('/api/initiate-mpesa', async (req, res) => {
  let connection;
  try {
    const { name, email, phone, plan, amount } = req.body;
    
    // Validate input
    if (!name || !email || !phone || !plan || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }
    
    connection = await pool.getConnection();
    
    // Check if customer exists
    const [existingCustomers] = await connection.execute(
      'SELECT id FROM customers WHERE email = ? OR phone = ?',
      [email, phone]
    );
    
    let customerId;
    if (existingCustomers.length > 0) {
      customerId = existingCustomers[0].id;
      // Update existing customer
      await connection.execute(
        'UPDATE customers SET name = ?, plan = ?, status = "trial" WHERE id = ?',
        [name, plan, customerId]
      );
    } else {
      // Create new customer
      const [customerResult] = await connection.execute(
        'INSERT INTO customers (name, email, phone, plan, status) VALUES (?, ?, ?, ?, "trial")',
        [name, email, phone, plan]
      );
      customerId = customerResult.insertId;
    }
    
    // Generate transaction ID
    const transaction_id = `ADC${Date.now()}${Math.random().toString(36).substr(2, 5)}`.toUpperCase();
    
    // Save payment record
    await connection.execute(
      'INSERT INTO payments (customer_id, transaction_id, amount, payment_method, status) VALUES (?, ?, ?, "mpesa", "pending")',
      [customerId, transaction_id, amount]
    );
    
    // Get M-Pesa access token
    const accessToken = await getMpesaAccessToken();
    
    // Generate timestamp
    const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, -3);
    const password = Buffer.from(`${MPESA_CONFIG.shortcode}${MPESA_CONFIG.passkey}${timestamp}`).toString('base64');
    
    // STK Push request
    const stkPayload = {
      BusinessShortCode: MPESA_CONFIG.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: MPESA_CONFIG.shortcode,
      PhoneNumber: phone,
      CallBackURL: MPESA_CONFIG.callbackURL,
      AccountReference: `ADCLEAN${plan.toUpperCase()}`,
      TransactionDesc: `AdClean KE ${plan} Plan`
    };
    
    const stkResponse = await axios.post(
      process.env.NODE_ENV === 'production'
        ? 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
        : 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      stkPayload,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    
    if (stkResponse.data.ResponseCode === '0') {
      // Update payment with checkout request ID
      await connection.execute(
        'UPDATE payments SET transaction_id = ? WHERE transaction_id = ?',
        [stkResponse.data.CheckoutRequestID, transaction_id]
      );
      
      connection.release();
      
      res.json({
        success: true,
        transaction_id: stkResponse.data.CheckoutRequestID,
        message: 'M-Pesa prompt sent to your phone'
      });
    } else {
      throw new Error(stkResponse.data.ResponseDescription || 'STK Push failed');
    }
    
  } catch (error) {
    if (connection) connection.release();
    console.error('❌ M-Pesa initiation error:', error.response?.data || error.message);
    
    res.status(500).json({
      success: false,
      error: 'Failed to initiate M-Pesa payment',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// M-Pesa callback
app.post('/api/mpesa-callback', async (req, res) => {
  let connection;
  try {
    const callbackData = req.body;
    
    if (callbackData.Body.stkCallback.ResultCode === 0) {
      // Payment successful
      const checkoutRequestID = callbackData.Body.stkCallback.CheckoutRequestID;
      const mpesaReceiptNumber = callbackData.Body.stkCallback.CallbackMetadata.Item.find(item => item.Name === 'MpsesaReceiptNumber')?.Value;
      const amount = callbackData.Body.stkCallback.CallbackMetadata.Item.find(item => item.Name === 'Amount')?.Value;
      const phone = callbackData.Body.stkCallback.CallbackMetadata.Item.find(item => item.Name === 'PhoneNumber')?.Value;
      
      if (!mpesaReceiptNumber) {
        throw new Error('M-Pesa receipt number not found in callback');
      }
      
      connection = await pool.getConnection();
      
      // Update payment status
      const [updateResult] = await connection.execute(
        'UPDATE payments SET status = "completed", transaction_id = ? WHERE transaction_id = ? AND status = "pending"',
        [mpesaReceiptNumber, checkoutRequestID]
      );
      
      if (updateResult.affectedRows === 0) {
        console.warn('⚠️ Payment update affected 0 rows for transaction:', checkoutRequestID);
      }
      
      // Get customer ID from payment
      const [paymentRows] = await connection.execute(
        'SELECT customer_id FROM payments WHERE transaction_id = ?',
        [mpesaReceiptNumber]
      );
      
      if (paymentRows.length > 0) {
        const customerId = paymentRows[0].customer_id;
        
        // Calculate expiry date (1 month from now)
        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + 1);
        
        // Update customer status
        await connection.execute(
          'UPDATE customers SET status = "active", expires_at = ? WHERE id = ?',
          [expiresAt, customerId]
        );
        
        // Create or update subscription
        const [customerRows] = await connection.execute(
          'SELECT email, plan FROM customers WHERE id = ?',
          [customerId]
        );
        
        if (customerRows.length > 0) {
          const customer = customerRows[0];
          
          // Create subscription
          await connection.execute(
            'INSERT INTO subscriptions (customer_id, plan, status, end_date) VALUES (?, ?, "active", ?) ON DUPLICATE KEY UPDATE plan = ?, status = "active", end_date = ?',
            [customerId, customer.plan, expiresAt, customer.plan, expiresAt]
          );
          
          // Send confirmation email
          await sendConfirmationEmail(customer.email, customer.plan, mpesaReceiptNumber, amount);
        }
      }
      
      connection.release();
      console.log('✅ M-Pesa payment completed:', mpesaReceiptNumber);
    } else {
      // Payment failed
      const checkoutRequestID = callbackData.Body.stkCallback.CheckoutRequestID;
      const errorMessage = callbackData.Body.stkCallback.ResultDesc;
      
      connection = await pool.getConnection();
      await connection.execute(
        'UPDATE payments SET status = "failed" WHERE transaction_id = ?',
        [checkoutRequestID]
      );
      connection.release();
      
      console.error('❌ M-Pesa payment failed:', checkoutRequestID, errorMessage);
    }
    
    res.status(200).send('OK');
  } catch (error) {
    if (connection) connection.release();
    console.error('❌ M-Pesa callback error:', error);
    res.status(500).send('Error processing callback');
  }
});

// Process PayPal payment
app.post('/api/process-payment', async (req, res) => {
  let connection;
  try {
    const { name, email, phone, plan, payment_method, payment_id, amount } = req.body;
    
    // Validate input
    if (!name || !email || !phone || !plan || !payment_id || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }
    
    connection = await pool.getConnection();
    
    // Check if customer exists
    const [existingCustomers] = await connection.execute(
      'SELECT id FROM customers WHERE email = ?',
      [email]
    );
    
    let customerId;
    if (existingCustomers.length > 0) {
      customerId = existingCustomers[0].id;
      // Update existing customer
      await connection.execute(
        'UPDATE customers SET name = ?, phone = ?, plan = ?, status = "active" WHERE id = ?',
        [name, phone, plan, customerId]
      );
    } else {
      // Create new customer
      const [customerResult] = await connection.execute(
        'INSERT INTO customers (name, email, phone, plan, status) VALUES (?, ?, ?, ?, "active")',
        [name, email, phone, plan]
      );
      customerId = customerResult.insertId;
    }
    
    // Save payment
    await connection.execute(
      'INSERT INTO payments (customer_id, transaction_id, amount, payment_method, status) VALUES (?, ?, ?, ?, "completed")',
      [customerId, payment_id, amount, payment_method]
    );
    
    // Calculate expiry date
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 1);
    
    // Update customer expiry
    await connection.execute(
      'UPDATE customers SET expires_at = ? WHERE id = ?',
      [expiresAt, customerId]
    );
    
    // Create or update subscription
    await connection.execute(
      'INSERT INTO subscriptions (customer_id, plan, status, end_date) VALUES (?, ?, "active", ?) ON DUPLICATE KEY UPDATE plan = ?, status = "active", end_date = ?',
      [customerId, plan, expiresAt, plan, expiresAt]
    );
    
    connection.release();
    
    // Send confirmation email
    await sendConfirmationEmail(email, plan, payment_id, amount);
    
    res.json({
      success: true,
      customer: { email, plan },
      transaction_id: payment_id
    });
    
  } catch (error) {
    if (connection) connection.release();
    console.error('❌ Payment processing error:', error);
    res.status(500).json({
      success: false,
      error: 'Payment processing failed'
    });
  }
});

// Check payment status
app.get('/api/payment-status/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    
    const connection = await pool.getConnection();
    const [rows] = await connection.execute(
      'SELECT status FROM payments WHERE transaction_id = ?',
      [transactionId]
    );
    
    connection.release();
    
    if (rows.length > 0) {
      res.json({ status: rows[0].status });
    } else {
      res.status(404).json({ error: 'Transaction not found' });
    }
  } catch (error) {
    console.error('❌ Payment status check error:', error);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// Start free trial
app.post('/api/trial', async (req, res) => {
  let connection;
  try {
    const { name, email, plan } = req.body;
    
    if (!name || !email) {
      return res.status(400).json({
        success: false,
        error: 'Name and email are required'
      });
    }
    
    connection = await pool.getConnection();
    
    // Calculate trial expiry (7 days from now)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    
    // Check if customer exists
    const [existingCustomers] = await connection.execute(
      'SELECT id FROM customers WHERE email = ?',
      [email]
    );
    
    if (existingCustomers.length > 0) {
      // Update existing customer
      await connection.execute(
        'UPDATE customers SET name = ?, plan = ?, status = "trial", expires_at = ? WHERE email = ?',
        [name, plan, expiresAt, email]
      );
    } else {
      // Create new customer
      await connection.execute(
        'INSERT INTO customers (name, email, phone, plan, status, expires_at) VALUES (?, ?, "0000000000", ?, "trial", ?)',
        [name, email, plan, expiresAt]
      );
    }
    
    connection.release();
    
    // Send trial instructions email
    await sendTrialEmail(email, name);
    
    res.json({ 
      success: true, 
      message: 'Trial started successfully',
      expires: expiresAt.toISOString()
    });
  } catch (error) {
    if (connection) connection.release();
    console.error('❌ Trial registration error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to start trial' 
    });
  }
});

// Send confirmation email
app.post('/api/send-confirmation', async (req, res) => {
  try {
    const { email, plan, transaction_id } = req.body;
    
    await sendConfirmationEmail(email, plan, transaction_id);
    
    res.json({ success: true, message: 'Confirmation email sent' });
  } catch (error) {
    console.error('❌ Email sending error:', error);
    res.status(500).json({ success: false, error: 'Failed to send email' });
  }
});

// Get customer dashboard
app.get('/api/customer/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
    const connection = await pool.getConnection();
    const [customers] = await connection.execute(
      `SELECT c.*, s.status as subscription_status, s.end_date as subscription_end 
       FROM customers c 
       LEFT JOIN subscriptions s ON c.id = s.customer_id 
       WHERE c.email = ? 
       ORDER BY s.end_date DESC 
       LIMIT 1`,
      [email]
    );
    
    connection.release();
    
    if (customers.length > 0) {
      res.json({ success: true, customer: customers[0] });
    } else {
      res.status(404).json({ success: false, error: 'Customer not found' });
    }
  } catch (error) {
    console.error('❌ Customer fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch customer data' });
  }
});

// Email functions
async function sendConfirmationEmail(email, plan, transactionId, amount = null) {
  try {
    const planNames = {
      trial: 'Free Trial',
      basic: 'Basic Plan',
      gamer: 'Gamer Plan',
      venue: 'Business Plan'
    };
    
    const planName = planNames[plan] || plan;
    
    const mailOptions = {
      from: process.env.EMAIL_FROM || 'noreply@adclean.co.ke',
      to: email,
      subject: `AdClean KE - ${planName} Activated`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a73e8;">Welcome to AdClean KE! 🎉</h2>
          <p>Your ${planName} has been successfully activated.</p>
          
          ${amount ? `<p><strong>Amount Paid:</strong> KSh ${amount}</p>` : ''}
          <p><strong>Transaction ID:</strong> ${transactionId}</p>
          <p><strong>Plan:</strong> ${planName}</p>
          
          <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #1a73e8; margin-top: 0;">Setup Instructions</h3>
            <p>To start using AdClean KE, follow these steps:</p>
            <ol>
              <li>Go to your device's network settings</li>
              <li>Configure DNS to use: <strong>dns.adclean.co.ke</strong></li>
              <li>Save settings and restart your browser</li>
            </ol>
            <p>For detailed device-specific instructions, visit: 
              <a href="${process.env.BASE_URL}/setup-instructions.html">Setup Guide</a>
            </p>
          </div>
          
          <p>If you need assistance, contact our support team:</p>
          <ul>
            <li>Email: support@adclean.co.ke</li>
            <li>WhatsApp: +254 794 242 155</li>
          </ul>
          
          <p>Thank you for choosing AdClean KE!</p>
          <p><strong>The AdClean KE Team</strong></p>
        </div>
      `
    };
    
    await transporter.sendMail(mailOptions);
    console.log('✅ Confirmation email sent to:', email);
    return true;
  } catch (error) {
    console.error('❌ Error sending confirmation email:', error);
    return false;
  }
}

async function sendTrialEmail(email, name) {
  try {
    const mailOptions = {
      from: process.env.EMAIL_FROM || 'noreply@adclean.co.ke',
      to: email,
      subject: 'AdClean KE - Free Trial Started',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a73e8;">Your AdClean KE Free Trial is Ready! 🚀</h2>
          <p>Hi ${name},</p>
          <p>Your 7-day free trial of AdClean KE has been activated.</p>
          
          <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #1a73e8; margin-top: 0;">Setup Instructions</h3>
            <p>To start using AdClean KE, follow these steps:</p>
            <ol>
              <li>Go to your device's network settings</li>
              <li>Configure DNS to use: <strong>dns.adclean.co.ke</strong></li>
              <li>Save settings and restart your browser</li>
            </ol>
            <p>For detailed device-specific instructions, visit: 
              <a href="${process.env.BASE_URL}/setup-instructions.html">Setup Guide</a>
            </p>
          </div>
          
          <p><strong>What's included in your trial:</strong></p>
          <ul>
            <li>Ad and tracker blocking</li>
            <li>Malware protection</li>
            <li>Data saving features</li>
            <li>One device support</li>
          </ul>
          
          <p>If you need assistance, contact our support team:</p>
          <ul>
            <li>Email: support@adclean.co.ke</li>
            <li>WhatsApp: +254 794 242 155</li>
          </ul>
          
          <p>Enjoy your ad-free browsing experience!</p>
          <p><strong>The AdClean KE Team</strong></p>
        </div>
      `
    };
    
    await transporter.sendMail(mailOptions);
    console.log('✅ Trial email sent to:', email);
    return true;
  } catch (error) {
    console.error('❌ Error sending trial email:', error);
    return false;
  }
}

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await connection.execute('SELECT 1');
    connection.release();
    
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'ERROR', 
      error: 'Database connection failed',
      timestamp: new Date().toISOString()
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { details: error.message })
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 AdClean KE server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  
  await initializeDatabase();
  
  // Schedule cleanup job for expired trials
  setInterval(async () => {
    try {
      const connection = await pool.getConnection();
      const [result] = await connection.execute(
        'UPDATE customers SET status = "expired" WHERE status = "trial" AND expires_at < NOW()'
      );
      connection.release();
      
      if (result.affectedRows > 0) {
        console.log(`🔄 Cleaned up ${result.affectedRows} expired trials`);
      }
    } catch (error) {
      console.error('❌ Cleanup job error:', error);
    }
  }, 24 * 60 * 60 * 1000); // Run daily
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

module.exports = app;