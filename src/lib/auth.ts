import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/index.js";
import * as schema from '../db/schema/auth.js'
import { sendWelcomeEmail, sendPasswordResetEmail } from "./email.js";
import { eq } from "drizzle-orm";
import { systemSettings } from "../db/schema/app.js";

// Only register the Google provider once real credentials are present —
// betterAuth() throws at startup if a social provider is configured with an
// empty clientId/clientSecret, so this keeps the server booting cleanly
// before the user adds GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET to .env.
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const isProduction = process.env.NODE_ENV === "production";

export const auth = betterAuth({
    baseURL: process.env.BETTER_AUTH_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    trustedOrigins: [process.env.FRONTEND_URL!],

    // Frontend (Netlify) and backend (Railway) are separate domains, so the
    // session cookie must be SameSite=None to be sent on cross-site fetch
    // requests — the default "lax" is only sent on top-level navigations.
    advanced: {
        defaultCookieAttributes: {
            sameSite: isProduction ? "none" : "lax",
            secure: isProduction,
        },
    },
    database: drizzleAdapter(db, {
        provider: "pg",
        schema,
    }),

    emailAndPassword: {
        enabled: true,
        // Forgot-password flow. `url` is Better Auth's own reset link — clicking
        // it verifies the token server-side, then redirects the browser to
        // `${FRONTEND_URL}/reset-password?token=...` (the `redirectTo` the
        // frontend passes to forgetPassword). If RESEND_API_KEY isn't set the
        // email silently no-ops (see lib/email.ts).
        resetPasswordTokenExpiresIn: 60 * 60, // 1 hour
        sendResetPassword: async ({ user, url }) => {
            await sendPasswordResetEmail({ to: user.email, name: user.name, resetUrl: url });
        },
    },

    account: {
        accountLinking: {
            enabled: true,
            // This app has no email-verification flow, so every existing
            // email/password account has emailVerified: false. Better Auth's
            // default (require the local account to already be verified
            // before trusting the IdP's email as proof of ownership) would
            // make Google sign-in permanently unable to link to any existing
            // account. Since sign-up here isn't open to untrusted strangers
            // (accounts are provisioned/managed by school staff), we accept
            // that tradeoff rather than leave linking broken.
            requireLocalEmailVerified: false,
        },
    },

    ...(googleClientId && googleClientSecret
        ? {
              socialProviders: {
                  google: {
                      clientId: googleClientId,
                      clientSecret: googleClientSecret,
                  },
              },
          }
        : {}),

    session: {
        cookieCache: {
            enabled: true,
        },
    },

    databaseHooks: {
        session: {
            create: {
                // Enforce role login switches at session creation as well as
                // on API requests, so disabled role groups cannot establish a
                // new authenticated portal session.
                before: async (session) => {
                    const [account] = await db.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, session.userId));
                    if (account?.role === "super_admin") return true;
                    const [settings] = await db.select({
                        enabled: systemSettings.enabled,
                        teachersEnabled: systemSettings.teachersEnabled,
                        studentsParentsEnabled: systemSettings.studentsParentsEnabled,
                    }).from(systemSettings).where(eq(systemSettings.id, 1));
                    if (settings?.enabled === false) throw new APIError("FORBIDDEN", { message: "The school system is temporarily offline.", code: "SYSTEM_OFFLINE" });
                    if (account?.role === "teacher" && settings?.teachersEnabled === false) throw new APIError("FORBIDDEN", { message: "Teacher login is temporarily disabled.", code: "TEACHER_LOGIN_DISABLED" });
                    if ((account?.role === "student" || account?.role === "parent") && settings?.studentsParentsEnabled === false) throw new APIError("FORBIDDEN", { message: "Student and parent login is temporarily disabled.", code: "STUDENT_PARENT_LOGIN_DISABLED" });
                    return true;
                },
            },
        },
        user: {
            create: {
                after: async (newUser) => {
                    void sendWelcomeEmail({
                        to: newUser.email,
                        name: newUser.name,
                        frontendUrl: process.env.FRONTEND_URL!,
                    });
                },
            },
        },
    },

    user: {
        additionalFields: {
            // input: false — role must never be settable by the client at sign-up.
            // Without this, anyone could POST { role: "admin" } to /sign-up/email and
            // self-promote to admin. New accounts always start as "student"; promoting
            // someone to teacher/admin/etc. must go through PATCH /api/users/:id/role.
            role: {
                type: 'string', required: true, defaultValue: 'student', input: false,
            },
            imageCldPubId: {
                type: 'string', required: false, input: true,
            },
        }
    }
});
