import express from "express";
import crypto from "crypto";
import { requireAuth } from "../middleware/require-auth.js";

const router = express.Router();

const ALLOWED_FOLDERS = new Set([
    "uploads/avatars",
    "uploads/attachments",
    "uploads/banners",
]);
const ALLOWED_SIGNED_PARAMS = new Set([
    "context",
    "eager",
    "folder",
    "invalidate",
    "overwrite",
    "public_id",
    "resource_type",
    "source",
    "tags",
    "timestamp",
    "transformation",
    "type",
    "unique_filename",
    "upload_preset",
    "use_filename",
]);

// POST /api/uploads/sign — signs whatever params the Cloudinary upload widget
// sends (folder, timestamp, source, etc.) so the widget can do a *signed*
// upload instead of relying on an unsigned preset anyone could hit directly.
// Cloudinary's rule: sign exactly the params the widget will send, sorted by
// key, joined as "key=value&key=value", secret appended, SHA1 hashed.
router.post("/sign", requireAuth, (req, res) => {
    try {
        const { paramsToSign } = req.body as { paramsToSign?: Record<string, string | number> };
        if (!paramsToSign || typeof paramsToSign !== "object" || Array.isArray(paramsToSign)) {
            return res.status(400).json({ error: "paramsToSign is required" });
        }

        const keys = Object.keys(paramsToSign);
        const folder = paramsToSign.folder;
        const timestamp = Number(paramsToSign.timestamp);
        if (keys.some((key) => !ALLOWED_SIGNED_PARAMS.has(key))) {
            return res.status(400).json({ error: "Unsupported upload parameters." });
        }
        if (typeof folder !== "string" || !ALLOWED_FOLDERS.has(folder)) {
            return res.status(400).json({ error: "Uploads must use an approved folder." });
        }
        if (!Number.isInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 15 * 60) {
            return res.status(400).json({ error: "Upload timestamp is invalid or expired." });
        }

        const apiSecret = process.env.CLOUDINARY_API_SECRET;
        if (!apiSecret) {
            return res.status(500).json({ error: "Cloudinary is not configured on the server." });
        }

        const toSign = Object.keys(paramsToSign)
            .sort()
            .map((key) => `${key}=${paramsToSign[key]}`)
            .join("&");

        const signature = crypto.createHash("sha1").update(toSign + apiSecret).digest("hex");

        res.json({ signature });
    } catch (e) {
        console.error("POST /uploads/sign error:", e);
        res.status(500).json({ error: "Failed to sign upload" });
    }
});

export default router;
