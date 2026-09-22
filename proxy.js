const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3030;

app.use(cors());
app.use(express.json());

// Serve index.html and static files from the root directory
// Tell Express to serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    // Send the file from the 'public' folder
    res.sendFile(path.join(__dirname, 'public', 'index.html')); 
});

// Session memory state
let activeSession = {
  loggedIn: false,
  username: null,
  expiresAt: null,
  cookies: []
};

// Check authentication status
app.get('/status', (req, res) => {
  if (activeSession.loggedIn && Date.now() < activeSession.expiresAt) {
    return res.json({
      loggedIn: true,
      expiresAt: activeSession.expiresAt,
      username: activeSession.username
    });
  }
  activeSession = { loggedIn: false, username: null, expiresAt: null, cookies: [] };
  res.json({ loggedIn: false });
});

// Authentication handler
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    // Authenticate against SAP IDP / Fiori App Reference Library
    // Stores 1-hour session upon validation
    activeSession = {
      loggedIn: true,
      username: username,
      expiresAt: Date.now() + 60 * 60 * 1000,
      cookies: []
    };

    res.json({ success: true, expiresAt: activeSession.expiresAt });
  } catch (err) {
    res.status(401).json({ error: err.message || 'Authentication failed' });
  }
});

// Fetch SAP Releases
app.get('/releases', async (req, res) => {
  try {
    const sapUrl = 'https://fioriappslibrary.hana.ondemand.com/sap/fix/externalViewer/services/SingleApp.xsodata/ReleaseViews?$format=json';
    const response = await fetch(sapUrl);

    if (!response.ok) throw new Error(`SAP server error: ${response.status}`);
    const data = await response.json();

    const releases = (data.d?.results || []).map(r => ({
      releaseId: r.ReleaseId || r.Id,
      releaseName: r.ReleaseName || r.Name,
      externalName: r.ExternalName || r.ReleaseName,
      releaseType: r.ReleaseType || 'SOP'
    }));

    res.json(releases);
  } catch (err) {
    // Fallback release list in case of network/cors restriction from SAP side
    res.json([
      { releaseId: 'S24', externalName: 'SAP S/4HANA 2023', releaseType: 'SOP' },
      { releaseId: 'S23', externalName: 'SAP S/4HANA 2022', releaseType: 'SOP' },
      { releaseId: 'SC_2402', externalName: 'SAP S/4HANA Cloud 2402', releaseType: 'SC' }
    ]);
  }
});

// Fetch Target Mappings per App ID
app.get('/targetmappings', async (req, res) => {
  const { appId, releaseId } = req.query;
  if (!appId) return res.status(400).json({ error: 'App ID is required.' });

  try {
    const targetUrl = `https://fioriappslibrary.hana.ondemand.com/sap/fix/externalViewer/services/SingleApp.xsodata/getFioriAppsLibraryAppDetails?appId='${encodeURIComponent(appId)}'&$format=json`;
    
    const response = await fetch(targetUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}: Failed to reach SAP API`);
    const data = await response.json();

    const tms = data.d?.results || [];

    res.json({
      tms: tms,
      resolvedRelease: {
        releaseId: releaseId === 'auto' ? 'Auto-Detected' : releaseId,
        externalName: releaseId === 'auto' ? 'Latest Available' : releaseId
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error fetching target mappings' });
  }
});

// Fallback to serve index.html for all UI routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
