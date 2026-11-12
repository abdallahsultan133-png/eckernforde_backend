import { afterEach, describe, expect, it, vi } from "vitest";

import { sendAdmissionEnquiryEmail } from "./email.js";

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("admissions enquiry email", () => {
    it("sends the visitor's message to an admin through Brevo with reply-to", async () => {
        vi.stubEnv("BREVO_API_KEY", "test-key");
        vi.stubEnv("BREVO_FROM_EMAIL", "noreply@school.example");
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
        vi.stubGlobal("fetch", fetchMock);

        const accepted = await sendAdmissionEnquiryEmail({
            to: "admin@school.example",
            fullName: "Visitor <Parent>",
            email: "visitor@example.com",
            phone: "+255123456789",
            childStage: "secondary",
            message: "Please contact me <soon>",
        });

        expect(accepted).toBe(true);
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, options] = fetchMock.mock.calls[0]!;
        expect(url).toBe("https://api.brevo.com/v3/smtp/email");
        expect(options.headers["api-key"]).toBe("test-key");
        const body = JSON.parse(options.body);
        expect(body.to).toEqual([{ email: "admin@school.example" }]);
        expect(body.replyTo).toEqual({ email: "visitor@example.com", name: "Visitor <Parent>" });
        expect(body.htmlContent).toContain("Visitor &lt;Parent&gt;");
        expect(body.htmlContent).toContain("Please contact me &lt;soon&gt;");
    });

    it("reports a rejected Brevo request without logging the visitor's message", async () => {
        vi.stubEnv("BREVO_API_KEY", "test-key");
        vi.stubEnv("BREVO_FROM_EMAIL", "noreply@school.example");
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const accepted = await sendAdmissionEnquiryEmail({
            to: "admin@school.example",
            fullName: "Visitor",
            email: "visitor@example.com",
            childStage: "primary",
            message: "Private family details",
        });

        expect(accepted).toBe(false);
        expect(warn).toHaveBeenCalledWith("[Email] Brevo rejected the message (status):", 401);
        expect(JSON.stringify(warn.mock.calls)).not.toContain("Private family details");
    });
});
