const express = require('express');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const {
  createUser,
  getUserByEmail,
  getUserById,
  getPasswordReset,
  savePasswordReset,
  incrementPasswordResetAttempts,
  clearPasswordReset,
  updatePasswordAndClearReset,
  getSignupEmailVerification,
  saveSignupEmailVerification,
  incrementSignupEmailVerificationAttempts,
  markSignupEmailVerified,
  consumeSignupEmailVerification,
  clearSignupEmailVerification,
  listUsers,
  getWorkspace,
  saveWorkspace,
  initializeDatabase
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const JWT_SECRET = process.env.JWT_SECRET || 'inventify-dev-secret-key';
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const gmailMailer = GMAIL_USER && GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD.replace(/\s/g, '')
    }
  })
  : null;
const PASSWORD_RESET_TTL_MS = 10 * 60 * 1000;
const PASSWORD_RESET_REQUEST_INTERVAL_MS = 60 * 1000;
const PASSWORD_RESET_MAX_ATTEMPTS = 5;
const SIGNUP_VERIFICATION_TTL_MS = 10 * 60 * 1000;
const SIGNUP_VERIFICATION_MAX_ATTEMPTS = 5;

function hashEmailCode(code) {
  return crypto.createHmac('sha256', JWT_SECRET).update(code).digest('hex');
}

function hashPassword(password) {
  return crypto
    .pbkdf2Sync(password, 'inventify-salt', 100000, 64, 'sha512')
    .toString('hex');
}

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      businessName: user.businessName,
      fullName: user.fullName
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Session expired or invalid token.' });
  }
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(ROOT_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'test.html'));
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'inventify-api',
    gmailConfigured: Boolean(gmailMailer)
  });
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await getUserById(req.user.id);

  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  return res.json({
    user: {
      id: user.id,
      businessName: user.businessName,
      fullName: user.fullName,
      email: user.email
    }
  });
});

app.get('/api/workspace', authMiddleware, async (req, res) => {
  try {
    const workspace = await getWorkspace(req.user.id);
    return res.json({ workspace });
  } catch (error) {
    console.error('Unable to load workspace:', error);
    return res.status(500).json({ message: 'Unable to load workspace.' });
  }
});

app.put('/api/workspace', authMiddleware, async (req, res) => {
  const workspace = req.body;
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    return res.status(400).json({ message: 'Workspace data must be a JSON object.' });
  }

  try {
    await saveWorkspace(req.user.id, workspace);
    return res.json({ success: true });
  } catch (error) {
    console.error('Unable to save workspace:', error);
    return res.status(500).json({ message: 'Unable to save workspace.' });
  }
});

app.get('/api/users', authMiddleware, async (req, res) => {
  const users = await listUsers();
  res.json({ users });
});

app.post('/api/signup/email-verification/request', async (req, res) => {
  const recoveryEmail = String(req.body?.recoveryEmail || '').trim().toLowerCase();

  if (!/^[^\s@]+@(?:gmail\.com|googlemail\.com)$/i.test(recoveryEmail)) {
    return res.status(400).json({ message: 'Enter a valid Gmail address to verify.' });
  }

  if (!gmailMailer) {
    console.error('Gmail verification is unavailable: set GMAIL_USER and GMAIL_APP_PASSWORD in the server environment.');
    return res.status(503).json({
      message: 'Email is not configured on the server. Add GMAIL_USER and GMAIL_APP_PASSWORD to your deployment environment, then restart or redeploy the server.'
    });
  }

  try {
    const previousVerification = await getSignupEmailVerification(recoveryEmail);
    if (previousVerification &&
        Date.now() - Date.parse(previousVerification.requestedAt) < PASSWORD_RESET_REQUEST_INTERVAL_MS) {
      return res.status(429).json({ message: 'Wait one minute before requesting another verification code.' });
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const requestedAt = new Date();
    const expiresAt = new Date(requestedAt.getTime() + SIGNUP_VERIFICATION_TTL_MS);
    const verificationId = crypto.randomUUID();
    await saveSignupEmailVerification({
      id: verificationId,
      recoveryEmail,
      codeHash: hashEmailCode(code),
      expiresAt: expiresAt.toISOString(),
      requestedAt: requestedAt.toISOString()
    });

    try {
      await gmailMailer.sendMail({
        from: GMAIL_USER,
        to: recoveryEmail,
        subject: 'Verify your Inventify registration',
        text: `Your Inventify Gmail verification code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
        html: `<p>Your Inventify Gmail verification code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>`
      });
    } catch (error) {
      await clearSignupEmailVerification(verificationId);
      console.error('Unable to send signup verification email:', error);
      if (error.code === 'EAUTH' || error.responseCode === 535) {
        return res.status(503).json({
          message: 'Gmail rejected the sender credentials. Set GMAIL_USER to the full Gmail address and GMAIL_APP_PASSWORD to an App Password for that account, then redeploy.'
        });
      }
      return res.status(503).json({ message: 'Unable to send the verification email right now. Please try again later.' });
    }

    return res.json({ success: true, message: 'Verification code sent. Check your Gmail inbox.' });
  } catch (error) {
    console.error('Unable to request signup email verification:', error);
    return res.status(500).json({ message: 'Unable to request Gmail verification.' });
  }
});

app.post('/api/signup/email-verification/confirm', async (req, res) => {
  const recoveryEmail = String(req.body?.recoveryEmail || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();

  if (!/^[^\s@]+@(?:gmail\.com|googlemail\.com)$/i.test(recoveryEmail) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ message: 'Enter a valid Gmail address and the six-digit verification code.' });
  }

  try {
    const verification = await getSignupEmailVerification(recoveryEmail);
    if (!verification || verification.usedAt || Date.now() > Date.parse(verification.expiresAt)) {
      return res.status(400).json({ message: 'The verification code is invalid or expired. Request a new code.' });
    }

    if (verification.attempts >= SIGNUP_VERIFICATION_MAX_ATTEMPTS) {
      return res.status(429).json({ message: 'Too many attempts. Request a new verification code.' });
    }

    const attempts = await incrementSignupEmailVerificationAttempts(verification.id);
    const expectedHash = Buffer.from(verification.codeHash, 'hex');
    const actualHash = Buffer.from(hashEmailCode(code), 'hex');
    if (expectedHash.length !== actualHash.length || !crypto.timingSafeEqual(expectedHash, actualHash)) {
      return res.status(400).json({
        message: attempts >= SIGNUP_VERIFICATION_MAX_ATTEMPTS
          ? 'Too many attempts. Request a new verification code.'
          : 'The verification code is incorrect.'
      });
    }

    const verified = await markSignupEmailVerified(verification.id, recoveryEmail);
    if (!verified) {
      return res.status(400).json({ message: 'The verification code is no longer valid. Request a new code.' });
    }

    const verificationToken = jwt.sign(
      { purpose: 'signup-email-verification', challengeId: verification.id, recoveryEmail },
      JWT_SECRET,
      { expiresIn: '10m' }
    );
    return res.json({ success: true, verificationToken, message: 'Gmail address verified.' });
  } catch (error) {
    console.error('Unable to confirm signup email verification:', error);
    return res.status(500).json({ message: 'Unable to verify the Gmail address.' });
  }
});

app.post('/api/signup', async (req, res) => {
  const { businessName, fullName, email, recoveryEmail, password, verificationToken } = req.body || {};

  if (!businessName || !fullName || !email || !recoveryEmail || !password || !verificationToken) {
    return res.status(400).json({ message: 'Please complete all signup fields.' });
  }

  if (!/^\S+@\S+\.\S+$/.test(String(email))) {
    return res.status(400).json({ message: 'Use a valid email address.' });
  }

  if (!/^[^\s@]+@(?:gmail\.com|googlemail\.com)$/i.test(String(recoveryEmail).trim())) {
    return res.status(400).json({ message: 'Use a valid Gmail address for password recovery.' });
  }

  if (String(password).length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedRecoveryEmail = String(recoveryEmail).trim().toLowerCase();
  let verificationProof;
  try {
    verificationProof = jwt.verify(verificationToken, JWT_SECRET);
  } catch (error) {
    return res.status(403).json({ message: 'Verify your Gmail address before creating an account.' });
  }

  if (verificationProof.purpose !== 'signup-email-verification' ||
      verificationProof.recoveryEmail !== normalizedRecoveryEmail ||
      typeof verificationProof.challengeId !== 'string') {
    return res.status(403).json({ message: 'Verify your Gmail address before creating an account.' });
  }

  const existingUser = await getUserByEmail(normalizedEmail);

  if (existingUser) {
    return res.status(409).json({ message: 'An account with that email already exists.' });
  }

  const verificationConsumed = await consumeSignupEmailVerification(
    verificationProof.challengeId,
    normalizedRecoveryEmail
  );
  if (!verificationConsumed) {
    return res.status(403).json({ message: 'Gmail verification expired or already used. Verify your address again.' });
  }

  const newUser = {
    id: `user-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    businessName: String(businessName).trim(),
    fullName: String(fullName).trim(),
    email: normalizedEmail,
    recoveryEmail: normalizedRecoveryEmail,
    passwordHash: hashPassword(String(password))
  };

  await createUser(newUser);
  const token = createToken(newUser);

  return res.status(201).json({
    success: true,
    token,
    user: {
      id: newUser.id,
      businessName: newUser.businessName,
      fullName: newUser.fullName,
      email: newUser.email
    }
  });
});

app.post('/api/password-reset/request', async (req, res) => {
  const { email, recoveryEmail } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedRecoveryEmail = String(recoveryEmail || '').trim().toLowerCase();

  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail) ||
      !/^[^\s@]+@(?:gmail\.com|googlemail\.com)$/i.test(normalizedRecoveryEmail)) {
    return res.status(400).json({ message: 'Enter your account email and recovery Gmail address.' });
  }

  if (!gmailMailer) {
    return res.status(503).json({ message: 'Password recovery email is not configured on this server.' });
  }

  try {
    const user = await getUserByEmail(normalizedEmail);
    if (!user || String(user.recoveryEmail || '').toLowerCase() !== normalizedRecoveryEmail) {
      return res.json({
        success: true,
        message: 'If the account details match, a recovery code will be sent to the Gmail address.'
      });
    }

    const previousReset = await getPasswordReset(user.id);
    if (previousReset && Date.now() - Date.parse(previousReset.requestedAt) < PASSWORD_RESET_REQUEST_INTERVAL_MS) {
      return res.json({
        success: true,
        message: 'If the account details match, a recovery code will be sent to the Gmail address.'
      });
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const requestedAt = new Date();
    const expiresAt = new Date(requestedAt.getTime() + PASSWORD_RESET_TTL_MS);
    await savePasswordReset(user.id, hashEmailCode(code), expiresAt.toISOString(), requestedAt.toISOString());

    try {
      await gmailMailer.sendMail({
        from: GMAIL_USER,
        to: user.recoveryEmail,
        subject: 'Your Inventify password recovery code',
        text: `Your Inventify password recovery code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
        html: `<p>Your Inventify password recovery code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>`
      });
    } catch (error) {
      await clearPasswordReset(user.id);
      console.error('Unable to send password recovery email:', error);
      if (error.code === 'EAUTH' || error.responseCode === 535) {
        return res.status(503).json({
          message: 'Gmail rejected the sender credentials. Set GMAIL_USER to the full Gmail address and GMAIL_APP_PASSWORD to an App Password for that account, then redeploy.'
        });
      }
      return res.status(503).json({ message: 'Unable to send the recovery email right now. Please try again later.' });
    }

    return res.json({
      success: true,
      message: 'If the account details match, a recovery code will be sent to the Gmail address.'
    });
  } catch (error) {
    console.error('Unable to request password recovery:', error);
    return res.status(500).json({ message: 'Unable to request password recovery.' });
  }
});

app.post('/api/password-reset/confirm', async (req, res) => {
  const { email, recoveryEmail, code, newPassword } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedRecoveryEmail = String(recoveryEmail || '').trim().toLowerCase();
  const submittedCode = String(code || '').trim();

  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail) ||
      !/^[^\s@]+@(?:gmail\.com|googlemail\.com)$/i.test(normalizedRecoveryEmail) ||
      !/^\d{6}$/.test(submittedCode) ||
      typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({
      message: 'Enter the account email, recovery Gmail, six-digit code, and a password of at least 6 characters.'
    });
  }

  try {
    const user = await getUserByEmail(normalizedEmail);
    if (!user || String(user.recoveryEmail || '').toLowerCase() !== normalizedRecoveryEmail) {
      return res.status(400).json({ message: 'The recovery code is invalid or expired.' });
    }

    const reset = await getPasswordReset(user.id);
    if (!reset) {
      return res.status(400).json({ message: 'The recovery code is invalid or expired.' });
    }

    if (Date.now() > Date.parse(reset.expiresAt)) {
      await clearPasswordReset(user.id);
      return res.status(400).json({ message: 'The recovery code is invalid or expired.' });
    }

    if (reset.attempts >= PASSWORD_RESET_MAX_ATTEMPTS) {
      await clearPasswordReset(user.id);
      return res.status(400).json({ message: 'Too many attempts. Request a new recovery code.' });
    }

    const attempts = await incrementPasswordResetAttempts(user.id);
    const expectedHash = Buffer.from(reset.codeHash, 'hex');
    const actualHash = Buffer.from(hashEmailCode(submittedCode), 'hex');
    if (expectedHash.length !== actualHash.length || !crypto.timingSafeEqual(expectedHash, actualHash)) {
      if (attempts >= PASSWORD_RESET_MAX_ATTEMPTS) {
        await clearPasswordReset(user.id);
      }
      return res.status(400).json({
        message: attempts >= PASSWORD_RESET_MAX_ATTEMPTS
          ? 'Too many attempts. Request a new recovery code.'
          : 'The recovery code is invalid or expired.'
      });
    }

    await updatePasswordAndClearReset(user.id, hashPassword(newPassword));
    return res.json({ success: true, message: 'Password updated. You can now sign in.' });
  } catch (error) {
    console.error('Unable to reset password:', error);
    return res.status(500).json({ message: 'Unable to reset password.' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ message: 'Enter your email and password to sign in.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = await getUserByEmail(normalizedEmail);

  if (!user || user.passwordHash !== hashPassword(String(password))) {
    return res.status(401).json({
      message: 'No matching account found. Create a new account or check your password.'
    });
  }

  const token = createToken(user);

  return res.json({
    success: true,
    token,
    user: {
      id: user.id,
      businessName: user.businessName,
      fullName: user.fullName,
      email: user.email
    }
  });
});

async function startServer() {
  await initializeDatabase();

  if (!gmailMailer) {
    console.warn('Gmail email is disabled. Set GMAIL_USER and GMAIL_APP_PASSWORD to enable registration verification and password recovery.');
  }

  app.listen(PORT, () => {
    console.log(`Inventify backend running at http://localhost:${PORT}`);
  });
}

startServer();
