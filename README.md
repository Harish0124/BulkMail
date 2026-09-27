# Postbird Bulk Mail

A local-first bulk email app built with React, Express, Nodemailer, and MongoDB. It supports plain-text campaigns, CSV and `.xlsx` recipient imports, private per-recipient delivery, and a MongoDB-backed campaign history.

## Requirements

- Node.js 20.19 or later
- MongoDB running locally or a MongoDB Atlas connection string
- An SMTP account and app password (Gmail app passwords require 2-Step Verification)

## Configure the backend

In a terminal:

```powershell
cd backend
Copy-Item .env.example .env
```

Edit `backend/.env` with your SMTP account details. MongoDB is optional for sending, but configure `MONGODB_URI` to save and view campaign history. For Gmail, use `smtp.gmail.com`, port `465`, and `SMTP_SECURE=true`. Keep `.env` private; it is ignored by Git.

Start the API:

```powershell
npm install
npm run dev
```

The API listens on `http://localhost:5000` by default.

## Run the frontend

Open a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open the Vite URL shown in the terminal, usually `http://localhost:5173`. The frontend connects to `https://bulkmail-mpsk.onrender.com` by default. Set `VITE_API_URL=http://localhost:5000` in `frontend/.env.local` to use a local backend instead. Configure `CLIENT_ORIGINS` on the backend deployment with the frontend's exact origin(s) so browser requests pass CORS.

## Use

Enter a subject, message, and up to 100 email addresses separated by commas or new lines, or import a CSV or `.xlsx` file up to 5 MB. Addresses are deduplicated and each receives a separate message addressed directly to them. Sent and failed campaign records appear in Sent history when MongoDB is connected. “SMTP accepted” means the mail server accepted the message; it cannot guarantee delivery to the inbox rather than spam or a later bounce.

The API provides `GET /api/health`, `POST /api/campaigns`, and `GET /api/campaigns`.

## Security

SMTP credentials must only be stored in `backend/.env`; never commit them or put them in frontend code. An SMTP app password was exposed in the original backend snippet; revoke it and create a new one before configuring this app. This version has no login or rate limiting, so keep it private and do not expose it to the public internet as-is.