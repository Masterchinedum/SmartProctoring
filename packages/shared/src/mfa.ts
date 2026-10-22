import { z } from 'zod';
import type { StaffRole } from './api';

/**
 * Two-step sign-in for staff (TOTP authenticator apps + single-use recovery codes). An organisation can require it
 * for administrators (owners and admins) or for everyone; staff who must use it and have not set it up can only
 * set it up until they do.
 */

export const MFA_REQUIREMENTS = ['off', 'admins', 'everyone'] as const;
export type MfaRequirement = (typeof MFA_REQUIREMENTS)[number];

export const MFA_REQUIREMENT_LABEL: Record<MfaRequirement, string> = {
  off: 'Optional for everyone',
  admins: 'Required for owners and administrators',
  everyone: 'Required for everyone',
};

export function mfaRequiredFor(requirement: MfaRequirement | undefined, role: StaffRole): boolean {
  if (requirement === 'everyone') return true;
  if (requirement === 'admins') return role === 'owner' || role === 'admin';
  return false;
}

/** The signed-in user's two-step sign-in state (GET /api/auth/me → security). */
export interface StaffSecurityDTO {
  mfaEnabled: boolean;
  mfaEnabledAt: number | null;
  /** Unused recovery codes (null without two-step sign-in). */
  recoveryCodesLeft: number | null;
  /** The organisation requires two-step sign-in for this user's role. */
  mfaRequired: boolean;
  /** Required but not set up: the staff API answers 403 mfa_enrollment_required until it is. */
  enrollmentRequired: boolean;
  /**
   * How this session was signed in. After single sign-on the organisation's identity provider is responsible for the
   * second factor: SmartProctoring's own two-step sign-in is neither asked nor required (enrollmentRequired false).
   */
  signInMethod?: 'password' | 'sso';
  /** The organisation requires single sign-on for this user's role (everyone except owners). */
  ssoRequired?: boolean;
}

/** POST /api/auth/login when the account uses two-step sign-in: no session yet (an httpOnly challenge cookie). */
export interface MfaChallengeResponse {
  mfaRequired: true;
  methods: ('totp' | 'recovery_code')[];
}

/** POST /api/auth/login/mfa — one of the two. */
export const mfaLoginSchema = z
  .object({ code: z.string().trim().max(20).optional(), recoveryCode: z.string().trim().max(40).optional() })
  .refine((b) => !!b.code !== !!b.recoveryCode, { message: 'Enter either the code from your authenticator app or a recovery code' });

/** POST /api/auth/mfa/totp/setup → a new secret to add to an authenticator app (not active until confirmed). */
export interface TotpSetupDTO {
  /** Base32, for typing into the app by hand. */
  secret: string;
  /** otpauth:// URI (shown as a QR code). */
  otpauthUri: string;
  issuer: string;
  account: string;
  /** The pending secret must be confirmed before this time (epoch ms). */
  expiresAt: number;
}

/**
 * POST /api/auth/mfa/totp/confirm — the code from the new app; when two-step sign-in is already on (replacing the
 * authenticator), also the current one: a code from the old app or a recovery code.
 */
export const totpConfirmSchema = z.object({ code: z.string().trim().min(6).max(20), currentCode: z.string().trim().max(40).optional() });

/** Recovery codes, shown once (setup and regeneration). */
export interface RecoveryCodesDTO {
  codes: string[];
}

/** POST /api/auth/mfa/recovery-codes — a current authenticator code is required. */
export const recoveryCodesRegenerateSchema = z.object({ code: z.string().trim().min(6).max(20) });

/** POST /api/auth/mfa/disable — password and a code (authenticator or recovery). */
export const mfaDisableSchema = z.object({ password: z.string().min(1), code: z.string().trim().min(6).max(40) });
