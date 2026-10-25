// Household passcode sign-in for the Vercel deployment.
// The passcode is checked once per phone; the phone then holds a signed cookie for 90 days.
// The signing key comes from the passcode itself, so changing the passcode signs every phone out.
import crypto from 'node:crypto';
import { send } from './http.js';

const COOKIE = 'meals_session';
const SESSION_DAYS = 90;

export function memberList(value) {
  return String(value || '').split(',').map(name => name.trim()).filter(Boolean).slice(0, 8)
    .map(name => ({ key: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'member', name }));
}

function readCookie(req, name) {
  const match = String(req.headers.cookie || '').split(/;\s*/).find(part => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

function clientKey(req) {
  const forwarded = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return `ip:${forwarded || req.socket?.remoteAddress || 'unknown'}`;
}

export function createPasscodeAuth({ passcode, members: memberText, core, now = () => Date.now(), secure = true }) {
  const members = memberList(memberText);
  const configured = typeof passcode === 'string' && passcode.length >= 8 && members.length > 0;
  const key = crypto.createHash('sha256').update(`meals-session-v1:${passcode || ''}`).digest();
  const sign = text => crypto.createHmac('sha256', key).update(text).digest('base64url');
  const sameText = (a, b) => {
    const left = crypto.createHash('sha256').update(String(a)).digest(), right = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(left, right);
  };
  const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const notReady = { status: 503, error: 'The household passcode is not set up yet (HOUSEHOLD_PASSCODE and HOUSEHOLD_MEMBERS).' };

  return {
    members: () => members,
    nameOf: memberKey => members.find(member => member.key === memberKey)?.name || memberKey,
    async identify(req) {
      if (!configured) return notReady;
      const [body, signature] = readCookie(req, COOKIE).split('.');
      if (body && signature && sameText(sign(body), signature)) {
        try {
          const session = JSON.parse(Buffer.from(body, 'base64url').toString());
          const member = members.find(entry => entry.key === session.m);
          if (member && session.exp > now()) return { member };
        } catch {}
      }
      return { status: 401, error: 'Enter the household passcode to sync this phone.', signIn: 'passcode' };
    },
    // Step 1: {passcode} → the names to pick from. Step 2: {passcode, member} → signed in.
    async login(req, res, input) {
      if (!configured) return send(res, notReady.status, { error: notReady.error });
      const who = clientKey(req);
      if (!(await core.loginAllowed(who))) return send(res, 429, { error: 'Too many wrong passcodes. Try again in 15 minutes.' });
      if (typeof input?.passcode !== 'string' || !sameText(input.passcode, passcode)) {
        await core.loginFailed(who);
        return send(res, 401, { error: "That passcode isn't right." });
      }
      await core.loginSucceeded(who);
      if (!input.member) return send(res, 200, { members: members.map(({ key: memberKey, name }) => ({ key: memberKey, name })) });
      const member = members.find(entry => entry.key === input.member);
      if (!member) return send(res, 400, { error: 'Pick one of the household names.' });
      const body = Buffer.from(JSON.stringify({ m: member.key, exp: now() + SESSION_DAYS * 86400_000 })).toString('base64url');
      return send(res, 200, { member: { name: member.name } }, { 'Set-Cookie': cookie(`${body}.${sign(body)}`, SESSION_DAYS * 86400) });
    },
    logout(req, res) { return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); },
  };
}
