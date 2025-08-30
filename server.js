const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from public folder

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        website VARCHAR(255),
        video_url VARCHAR(500),
        logo_url VARCHAR(500),
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create new votes table with constraints built-in
    await pool.query(`
      CREATE TABLE IF NOT EXISTS votes_new (
        id SERIAL PRIMARY KEY,
        voter_name VARCHAR(255) NOT NULL,
        voter_email VARCHAR(255) NOT NULL UNIQUE,
        voter_phone VARCHAR(20) NOT NULL UNIQUE,
        company_id INTEGER REFERENCES companies(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // If the old votes table exists, we'll use the new one instead
    try {
      await pool.query(`DROP TABLE IF EXISTS votes_old`);
      await pool.query(`ALTER TABLE votes RENAME TO votes_old`);
      await pool.query(`ALTER TABLE votes_new RENAME TO votes`);
      console.log('Created new votes table with unique constraints');
    } catch (error) {
      // If renaming fails, the new table is already named 'votes'
      console.log('Votes table setup completed');
    }

    // Insert default companies if they don't exist
    await pool.query(`
      INSERT INTO companies (name, website, logo_url) 
      VALUES 
        ('Apple', 'https://apple.com', 'https://logo.clearbit.com/apple.com'),
        ('Google', 'https://google.com', 'https://logo.clearbit.com/google.com')
      ON CONFLICT (name) DO NOTHING
    `);

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
};

// Routes

// Serve voting form at root and /voting
app.get('/voting', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'leaderboard.html'));
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    message: 'Inbound Voting System API', 
    status: 'running',
    pages: {
      voting: '/voting or /index.html',
      leaderboard: '/leaderboard or /leaderboard.html', 
      admin: '/admin or /admin.html'
    },
    endpoints: {
      companies: 'GET /api/companies',
      vote: 'POST /api/vote',
      leaderboard: 'GET /api/leaderboard',
      admin: {
        companies: 'POST /api/admin/companies (add), DELETE /api/admin/companies/:id',
        votes: 'GET /api/admin/votes'
      }
    }
  });
});

// Get all active companies for the dropdown
app.get('/api/companies', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name FROM companies WHERE active = true ORDER BY name'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// Function to send vote data to Google Sheets
async function sendToGoogleSheets(voteData) {
  const GOOGLE_APPS_SCRIPT_URL = process.env.GOOGLE_SHEETS_WEBHOOK_URL || 'YOUR_APPS_SCRIPT_URL_HERE';
  
  if (GOOGLE_APPS_SCRIPT_URL === 'YOUR_APPS_SCRIPT_URL_HERE') {
    console.log('Google Sheets webhook URL not configured');
    return;
  }

  try {
    const response = await fetch(GOOGLE_APPS_SCRIPT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(voteData)
    });

    if (response.ok) {
      console.log('Successfully sent vote to Google Sheets');
    } else {
      console.error('Failed to send to Google Sheets:', response.status);
    }
  } catch (error) {
    console.error('Error sending to Google Sheets:', error);
  }
}

// Submit a vote - Simple version with database constraints + Google Sheets
app.post('/api/vote', async (req, res) => {
  const { voterName, voterEmail, voterPhone, companyVote } = req.body;

  // Basic validation
  if (!voterName || !voterEmail || !voterPhone || !companyVote) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  // Email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(voterEmail)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  const cleanEmail = voterEmail.toLowerCase().trim();
  const cleanPhone = voterPhone.trim();

  try {
    // Verify company exists and is active
    const company = await pool.query(
      'SELECT id, name, website FROM companies WHERE id = $1 AND active = true',
      [companyVote]
    );

    if (company.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid company selection' });
    }

    const selectedCompany = company.rows[0];

    // Try to insert - database constraints will prevent duplicates
    const result = await pool.query(
      'INSERT INTO votes (voter_name, voter_email, voter_phone, company_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [voterName.trim(), cleanEmail, cleanPhone, companyVote]
    );

    const voteId = result.rows[0].id;

    // Send to Google Sheets (don't wait for response)
    sendToGoogleSheets({
      voterName: voterName.trim(),
      voterEmail: cleanEmail,
      voterPhone: cleanPhone,
      companyName: selectedCompany.name,
      companyWebsite: selectedCompany.website,
      voteId: voteId
    }).catch(error => {
      console.error('Failed to send to Google Sheets:', error);
    });

    res.status(201).json({ 
      message: 'Vote submitted successfully',
      voteId: voteId 
    });

  } catch (error) {
    console.error('Vote submission error:', error);
    
    // Check for duplicate constraint violations
    if (error.code === '23505') { // PostgreSQL unique constraint violation
      if (error.constraint === 'unique_email') {
        return res.status(400).json({ error: 'This email address has already been used to vote' });
      } else if (error.constraint === 'unique_phone') {
        return res.status(400).json({ error: 'This phone number has already been used to vote' });
      } else {
        return res.status(400).json({ error: 'You have already voted' });
      }
    }
    
    res.status(500).json({ error: 'Failed to submit vote' });
  }
});

// Get leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.id,
        c.name,
        c.website,
        COUNT(v.id) as vote_count,
        ROUND(
          (COUNT(v.id) * 100.0 / NULLIF((SELECT COUNT(*) FROM votes), 0)), 
          1
        ) as percentage
      FROM companies c
      LEFT JOIN votes v ON c.id = v.company_id
      WHERE c.active = true
      GROUP BY c.id, c.name, c.website
      ORDER BY vote_count DESC, c.name
    `);

    const leaderboard = result.rows.map((row, index) => ({
      rank: index + 1,
      id: row.id,
      name: row.name,
      website: row.website,
      votes: parseInt(row.vote_count),
      percentage: parseFloat(row.percentage) || 0
    }));

    res.json({
      leaderboard,
      totalVotes: leaderboard.reduce((sum, item) => sum + item.votes, 0),
      lastUpdated: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// Admin Routes

// Add a new company - simple version
app.post('/api/admin/companies', async (req, res) => {
  const { name, website } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'Company name is required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO companies (name, website) VALUES ($1, $2) RETURNING *',
      [name.trim(), website?.trim() || null]
    );

    res.status(201).json({ 
      message: 'Company added successfully',
      company: result.rows[0]
    });

  } catch (error) {
    if (error.code === '23505') { // Unique constraint violation
      return res.status(400).json({ error: 'Company already exists' });
    }
    console.error('Error adding company:', error);
    res.status(500).json({ error: 'Failed to add company' });
  }
});

// Deactivate a company (soft delete)
app.delete('/api/admin/companies/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      'UPDATE companies SET active = false WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json({ 
      message: 'Company deactivated successfully',
      company: result.rows[0]
    });

  } catch (error) {
    console.error('Error deactivating company:', error);
    res.status(500).json({ error: 'Failed to deactivate company' });
  }
});

// Get all companies (including inactive) - Admin view
app.get('/api/admin/companies', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.*,
        COUNT(v.id) as vote_count
      FROM companies c
      LEFT JOIN votes v ON c.id = v.company_id
      GROUP BY c.id
      ORDER BY c.active DESC, c.name
    `);

    res.json(result.rows.map(row => ({
      ...row,
      vote_count: parseInt(row.vote_count)
    })));

  } catch (error) {
    console.error('Error fetching admin companies:', error);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// Get all votes - Admin view
app.get('/api/admin/votes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        v.*,
        c.name as company_name
      FROM votes v
      JOIN companies c ON v.company_id = c.id
      ORDER BY v.created_at DESC
    `);

    res.json(result.rows);

  } catch (error) {
    console.error('Error fetching votes:', error);
    res.status(500).json({ error: 'Failed to fetch votes' });
  }
});

// Reactivate a company
app.patch('/api/admin/companies/:id/activate', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      'UPDATE companies SET active = true WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json({ 
      message: 'Company reactivated successfully',
      company: result.rows[0]
    });

  } catch (error) {
    console.error('Error reactivating company:', error);
    res.status(500).json({ error: 'Failed to reactivate company' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
const startServer = async () => {
  await initDB();
  
  app.listen(PORT, () => {
    console.log(`🚀 Voting System API running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  });
};

startServer().catch(console.error);
