# Inventify

## Gmail verification and password recovery

New accounts must verify their Gmail recovery address with a code before registration can finish. The deployed backend must send the email; setting variables in the browser or frontend hosting settings will not work. In your backend host's environment variables or secrets settings, add:

- `GMAIL_USER`: the Gmail address used to send recovery messages
- `GMAIL_APP_PASSWORD`: that account's Google App Password

Create the app password from the Google Account security settings after enabling 2-Step Verification. Use the generated App Password, not your normal Gmail password. Save the variables and restart or redeploy the backend for them to take effect. Check the backend startup logs for a warning that Gmail email is disabled if the variables are missing.

Keep the app password out of source control and never put it in frontend/public environment variables. Verification and recovery codes expire after 10 minutes and are limited to five attempts.

### Render deployment check

Open the backend Web Service's `/api/health` URL. It should return JSON with `"ok": true` and `"gmailConfigured": true`. If the site is deployed separately as a Render Static Site, set `window.INVENTIFY_API_BASE_URL` in [api-config.js](./api-config.js) to the backend Web Service's origin (for example, `https://your-service.onrender.com`, without `/api`), then redeploy the Static Site. Leave it empty when the frontend is served by the same Node Web Service. A non-JSON API response in the registration page means the frontend is reaching the wrong service.

If health reports Gmail configured but sending fails, check the backend logs. A Gmail authentication error usually means `GMAIL_USER` must be the full address (including `@gmail.com`) and `GMAIL_APP_PASSWORD` must be a Google App Password belonging to that account, not its normal password.
