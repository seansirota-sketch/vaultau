const crypto = require('crypto');
const admin = require('firebase-admin');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CLOCK_SKEW_SECONDS = 60;

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64').toString('utf8');
}

function parseAllowlist(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function timingSafeEqualString(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyJwtHs256(token, key) {
  if (!token || !key || typeof token !== 'string') {
    throw new Error('invalid_handoff_token');
  }

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('invalid_handoff_token');

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header;
  let payload;

  try {
    header = JSON.parse(base64UrlDecode(encodedHeader));
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    throw new Error('invalid_handoff_token');
  }

  if (header.alg !== 'HS256') throw new Error('unsupported_handoff_alg');

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = crypto
    .createHmac('sha256', key)
    .update(signingInput)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

  if (!timingSafeEqualString(expectedSignature, encodedSignature)) {
    throw new Error('invalid_handoff_signature');
  }

  return payload;
}

function normalizeRoles(rolesClaim) {
  if (Array.isArray(rolesClaim)) return rolesClaim.map(r => String(r));
  if (typeof rolesClaim === 'string') return [rolesClaim];
  return [];
}

function mapLtiRole(roles) {
  const raw = roles.join(' ').toLowerCase();
  if (raw.includes('administrator') || raw.includes('admin')) return 'admin';
  if (raw.includes('instructor') || raw.includes('teachingassistant') || raw.includes('teaching_assistant')) return 'instructor';
  return 'student';
}

function stableLtiUid(iss, sub) {
  const digest = crypto
    .createHash('sha256')
    .update(`${iss}|${sub}`)
    .digest('hex')
    .slice(0, 32);
  return `lti_${digest}`;
}

function getAdmin() {
  if (admin.apps.length) return admin;

  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) throw new Error('missing_firebase_service_account');

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(sa)),
  });

  return admin;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function parseBody(event) {
  try {
    return JSON.parse(event.body || '{}');
  } catch {
    return null;
  }
}

async function writeAudit(db, payload) {
  try {
    await db.collection('lti_launch_audit').add(payload);
  } catch (err) {
    console.error('lti_launch_audit write failed:', err.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ error: 'method_not_allowed' }),
    };
  }

  if (!parseBool(process.env.LTI_ENTRY_ENABLED, false)) {
    return {
      statusCode: 403,
      headers: CORS,
      body: JSON.stringify({ error: 'lti_entry_disabled' }),
    };
  }

  const verifyKey = process.env.LTI_HANDOFF_VERIFY_KEY;
  const expectedAudience = process.env.LTI_EXPECTED_AUDIENCE;
  const allowedIssuers = parseAllowlist(process.env.LTI_ALLOWED_ISSUERS);
  const requireCourseMap = parseBool(process.env.LTI_REQUIRE_COURSE_MAP, false);

  if (!verifyKey || !expectedAudience || !allowedIssuers.length) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'lti_env_misconfigured' }),
    };
  }

  const body = parseBody(event);
  if (!body || typeof body.handoffToken !== 'string') {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'invalid_request_body' }),
    };
  }

  let claims;
  try {
    claims = verifyJwtHs256(body.handoffToken, verifyKey);
  } catch (err) {
    return {
      statusCode: 401,
      headers: CORS,
      body: JSON.stringify({ error: err.message || 'invalid_handoff_token' }),
    };
  }

  const iss = String(claims.iss || '').trim();
  const sub = String(claims.sub || '').trim();
  const aud = claims.aud;
  const exp = Number(claims.exp || 0);
  const iat = Number(claims.iat || 0);
  const jti = String(claims.jti || '').trim();
  const contextId = String(claims.context_id || '').trim();
  const roles = normalizeRoles(claims.roles);
  const ltiRole = mapLtiRole(roles);

  const missingClaims = [];
  if (!iss) missingClaims.push('iss');
  if (!sub) missingClaims.push('sub');
  if (!Number.isFinite(exp) || exp <= 0) missingClaims.push('exp');
  if (!Number.isFinite(iat) || iat <= 0) missingClaims.push('iat');
  if (!jti) missingClaims.push('jti');

  if (missingClaims.length) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({
        error: 'missing_required_claims',
        missingClaims,
      }),
    };
  }

  const currentTs = nowSeconds();
  if (exp < currentTs - CLOCK_SKEW_SECONDS) {
    return {
      statusCode: 401,
      headers: CORS,
      body: JSON.stringify({ error: 'handoff_token_expired' }),
    };
  }

  if (iat > currentTs + CLOCK_SKEW_SECONDS) {
    return {
      statusCode: 401,
      headers: CORS,
      body: JSON.stringify({ error: 'handoff_token_iat_invalid' }),
    };
  }

  const audiences = Array.isArray(aud) ? aud.map(String) : [String(aud || '')];
  if (!audiences.includes(expectedAudience)) {
    return {
      statusCode: 401,
      headers: CORS,
      body: JSON.stringify({ error: 'handoff_audience_mismatch' }),
    };
  }

  if (!allowedIssuers.includes(iss)) {
    return {
      statusCode: 401,
      headers: CORS,
      body: JSON.stringify({ error: 'handoff_issuer_not_allowed' }),
    };
  }

  let firebaseAdmin;
  try {
    firebaseAdmin = getAdmin();
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message || 'firebase_admin_init_failed' }),
    };
  }

  const firestore = firebaseAdmin.firestore();
  const uid = stableLtiUid(iss, sub);
  const email = claims.email ? String(claims.email).toLowerCase().trim() : null;
  const displayName = String(claims.name || claims.given_name || email || 'LTI User').trim();

  let mappedCourse = null;
  try {
    if (contextId) {
      const mapDocId = stableLtiUid(iss, contextId);
      const mapRef = firestore.collection('lti_course_map').doc(mapDocId);
      const mapSnap = await mapRef.get();

      if (mapSnap.exists) {
        mappedCourse = mapSnap.data();
      }

      if (!mapSnap.exists && claims.vaultau_course_id) {
        mappedCourse = {
          platformIssuer: iss,
          contextId,
          vaultauCourseId: String(claims.vaultau_course_id),
          status: 'active',
          updatedAt: new Date().toISOString(),
        };
        await mapRef.set(mappedCourse, { merge: true });
      }

      if (requireCourseMap && (!mappedCourse || !mappedCourse.vaultauCourseId)) {
        await writeAudit(firestore, {
          timestamp: new Date().toISOString(),
          result: 'failed',
          errorCode: 'unknown_course_mapping',
          contextId,
          roleSummary: ltiRole,
          issuer: iss,
          subject: sub,
          jti,
        });
        return {
          statusCode: 403,
          headers: CORS,
          body: JSON.stringify({ error: 'unknown_course_mapping' }),
        };
      }
    }

    await firebaseAdmin.auth().createUser({
      uid,
      email: email || undefined,
      displayName,
      emailVerified: !!email,
      disabled: false,
    }).catch(async (err) => {
      if (err.code === 'auth/uid-already-exists') {
        await firebaseAdmin.auth().updateUser(uid, {
          email: email || undefined,
          displayName,
          emailVerified: !!email,
        });
        return;
      }
      throw err;
    });

    await firebaseAdmin.auth().setCustomUserClaims(uid, {
      lti: true,
      ltiIssuer: iss,
      ltiRole,
      ltiContextId: contextId || null,
      ltiCourseId: mappedCourse?.vaultauCourseId || null,
      ltiDeploymentId: claims.deployment_id || null,
      ltiClientId: claims.client_id || null,
    });

    await firestore.collection('users').doc(uid).set({
      uid,
      email,
      displayName,
      
      // Auth Origin Tracking
      authOrigin: 'lti',
      authMethods: admin.firestore.FieldValue.arrayUnion(['lti']),
      
      // LTI-specific fields
      ltiRole,
      ltiIssuer: iss,
      ltiSub: sub,
      ltiStableUid: stableLtiUid(iss, sub),
      ltiLinked: true,
      
      // Timestamps
      lastSignInAt: new Date(),
      lastSignInMethod: 'lti',
      currentCourseId: contextId || null,
      currentCourseContext: claims.context_label || null,
      
      updatedAt: new Date().toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await firestore.collection('lti_users').doc(uid).set({
      iss,
      sub,
      vaultauUid: uid,
      email,
      displayName,
      roleSummary: ltiRole,
      deploymentId: claims.deployment_id || null,
      clientId: claims.client_id || null,
      contextId,
      contextTitle: claims.context_title || null,
      lastLaunchAt: new Date().toISOString(),
      jti,
    }, { merge: true });

    await writeAudit(firestore, {
      timestamp: new Date().toISOString(),
      result: 'success',
      errorCode: null,
      contextId,
      roleSummary: ltiRole,
      issuer: iss,
      subject: sub,
      jti,
    });

    const customToken = await firebaseAdmin.auth().createCustomToken(uid, {
      lti: true,
      ltiRole,
      ltiIssuer: iss,
      ltiContextId: contextId || null,
      ltiCourseId: mappedCourse?.vaultauCourseId || null,
    });

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        customToken,
        user: {
          uid,
          email,
          displayName,
          ltiRole,
        },
        courseMapping: mappedCourse || null,
      }),
    };
  } catch (err) {
    console.error('lti-session-exchange failed:', err);

    await writeAudit(firestore, {
      timestamp: new Date().toISOString(),
      result: 'failed',
      errorCode: err.code || err.message || 'lti_exchange_error',
      contextId,
      roleSummary: ltiRole,
      issuer: iss,
      subject: sub,
      jti,
    });

    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'lti_exchange_error' }),
    };
  }
};
