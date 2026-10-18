/**
 * Configuration Template (Public GitHub)
 * Copy this file to `config.js` and provide your Google Apps Script Proxy URL, Auth Token, and Firebase Config.
 */
const CONFIG = {
  // Secured via Google Apps Script serverless proxy (API key stored in Google Cloud Script Properties)
  GEMINI_PROXY_URL: 'YOUR_GEMINI_PROXY_URL_HERE',
  PROXY_AUTH_TOKEN: 'YOUR_PROXY_AUTH_TOKEN_HERE',

  // Google Firebase & Cloud Firestore Web Configuration
  FIREBASE_CONFIG: {
    apiKey: "YOUR_FIREBASE_API_KEY",
    authDomain: "your-project-id.firebaseapp.com",
    projectId: "your-project-id",
    storageBucket: "your-project-id.firebasestorage.app",
    messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
    appId: "YOUR_FIREBASE_APP_ID"
  }
};

if (typeof window !== 'undefined') {
  window.CONFIG = CONFIG;
}
