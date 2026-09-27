require("dotenv").config()

const cors = require("cors")
const express = require("express")
const mongoose = require("mongoose")
const nodemailer = require("nodemailer")

const app = express()
const port = Number(process.env.PORT) || 5000
const maxRecipients = 100

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }))
app.use(express.json({ limit: "1mb" }))

const campaignSchema = new mongoose.Schema(
    {
        subject: { type: String, required: true, maxlength: 200 },
        body: { type: String, required: true, maxlength: 20000 },
        recipients: { type: [String], required: true },
        status: {
            type: String,
            enum: ["sending", "sent", "partial", "failed"],
            default: "sending",
        },
        deliveryResults: [{
            email: { type: String, required: true },
            status: { type: String, enum: ["sent", "failed"], required: true },
            error: { type: String, default: "" },
        }],
        error: { type: String, default: "" },
        sentAt: { type: Date, default: null },
    },
    { timestamps: true },
)

const Campaign = mongoose.model("Campaign", campaignSchema)
const senderAddress = process.env.SMTP_FROM || process.env.SMTP_USER
const missingSmtpSettings = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"]
    .filter((key) => !process.env[key]?.trim())
const smtpConfigured = missingSmtpSettings.length === 0 && Boolean(senderAddress)

const transporter = smtpConfigured
    ? nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT),
            secure: process.env.SMTP_SECURE === "true",
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        })
    : null

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

app.get("/api/health", (_req, res) => {
    res.json({
        api: "ok",
        database: mongoose.connection.readyState === 1,
        mailConfigured: smtpConfigured,
    })
})

app.get("/api/campaigns", async (req, res) => {
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ message: "MongoDB is not connected." })
    }

    const requestedLimit = Number.parseInt(req.query.limit, 10)
    const limit = Number.isNaN(requestedLimit)
        ? 25
        : Math.min(Math.max(requestedLimit, 1), 100)

    try {
        const campaigns = await Campaign.find()
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean()
        return res.json({ campaigns })
    } catch (error) {
        console.error("Unable to load campaign history:", error.name)
        return res.status(500).json({ message: "Could not load campaign history." })
    }
})

app.post("/api/campaigns", async (req, res) => {
    const payload = req.body && typeof req.body === "object" ? req.body : {}
    const subject = typeof payload.subject === "string" ? payload.subject.trim() : ""
    const body = typeof payload.body === "string" ? payload.body : ""
    const recipients = Array.isArray(payload.recipients)
        ? [...new Map(payload.recipients
                .map((email) => typeof email === "string" ? email.trim() : "")
                .filter(Boolean)
                .map((email) => [email.toLowerCase(), email])).values()]
        : []

    if (!subject || subject.length > 200) {
        return res.status(400).json({ message: "Enter a subject (up to 200 characters)." })
    }
    const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0
    if (!wordCount || wordCount > 30 || body.length > 20000) {
        return res.status(400).json({ message: "Enter a message containing 1 to 30 words." })
    }
    if (recipients.length === 0 || recipients.length > maxRecipients) {
        return res.status(400).json({
            message: `Add between 1 and ${maxRecipients} unique recipient emails.`,
        })
    }
    if (recipients.some((email) => !emailPattern.test(email))) {
        return res.status(400).json({ message: "One or more recipient emails are invalid." })
    }
    if (!transporter) {
        const message = missingSmtpSettings.length
            ? `SMTP is not configured. Add ${missingSmtpSettings.join(", ")} to backend/.env, then restart the backend.`
            : "SMTP settings are invalid. Check SMTP_PORT and SMTP_SECURE in backend/.env."
        return res.status(503).json({
            message,
        })
    }

    let campaign = null
    if (mongoose.connection.readyState === 1) {
        try {
            campaign = await Campaign.create({ subject, body, recipients })
        } catch (error) {
            console.error("Unable to create campaign history:", error.name)
        }
    }

    const deliveryResults = []
    for (const email of recipients) {
        try {
            await transporter.sendMail({ from: senderAddress, to: email, subject, text: body })
            deliveryResults.push({ email, status: "sent", error: "" })
        } catch (error) {
            deliveryResults.push({
                email,
                status: "failed",
                error: "Email delivery failed. Check SMTP settings.",
            })
            console.error("Email delivery failed:", error.code || error.name)
        }
    }

    const sentCount = deliveryResults.filter((result) => result.status === "sent").length
    const failedCount = recipients.length - sentCount
    const status = sentCount === recipients.length ? "sent" : sentCount > 0 ? "partial" : "failed"
    const message = failedCount === 0
        ? `SMTP accepted the email for all ${sentCount} recipient${sentCount === 1 ? "" : "s"}.`
        : sentCount === 0
            ? "SMTP could not accept the email for any recipient. Check the SMTP settings."
            : `SMTP accepted the email for ${sentCount} of ${recipients.length} recipients; ${failedCount} failed.`

    let historySaved = false
    if (campaign) {
        campaign.status = status
        campaign.deliveryResults = deliveryResults
        campaign.error = failedCount ? `${failedCount} recipient${failedCount === 1 ? "" : "s"} failed.` : ""
        campaign.sentAt = sentCount ? new Date() : null
        try {
            await campaign.save()
            historySaved = true
        } catch (error) {
            console.error("Unable to update campaign history:", error.name)
        }
    }

    return res.status(sentCount === 0 ? 502 : failedCount > 0 ? 207 : 201).json({
        message,
        status,
        historySaved,
        sentCount,
        failedCount,
        deliveryResults,
    })
})

app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && "body" in error) {
        return res.status(400).json({ message: "Request body must contain valid JSON." })
    }
    console.error("Request failed:", error.name)
    return res.status(500).json({ message: "Unexpected server error." })
})

if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI).catch((error) => {
        console.warn(`MongoDB unavailable (${error.name}); campaign history is disabled. Start MongoDB or update MONGODB_URI.`)
    })
} else {
    console.warn("MongoDB is not configured; campaign history is disabled. Set MONGODB_URI to enable history.")
}

app.listen(port, () => {
    console.log(`Bulk Mail API listening on port ${port}`)
})
