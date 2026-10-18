/**
 * Configuration Template (Public GitHub)
 * Copy this file to `config.js` and provide your Google Apps Script Proxy URL and Auth Token.
 */
const CONFIG = {
  // Secured via Google Apps Script serverless proxy (API key stored in Google Cloud Script Properties)
  GEMINI_PROXY_URL: 'YOUR_GEMINI_PROXY_URL_HERE',
  PROXY_AUTH_TOKEN: 'YOUR_PROXY_AUTH_TOKEN_HERE'
};

if (typeof window !== 'undefined') {
  window.CONFIG = CONFIG;
}
