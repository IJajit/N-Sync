# Notion & Google 2-Way Sync Platform

A full-stack Next.js web application and sync engine providing bi-directional (two-way) synchronization between **Notion Tasks**, **Google Calendar**, and **Google Tasks**.

## Features

- **Bi-directional Synchronization**:
  - Notion Tasks DB $\leftrightarrow$ Google Calendar Events
  - Notion Tasks DB $\leftrightarrow$ Google Tasks
  - Google Calendar Events $\leftrightarrow$ Google Tasks
- **Loop Prevention & Deduplication**: Local mapping store (`sync_data.json`) prevents duplicate item creation.
- **Interactive Web Dashboard**: Live activity log stream, task mapping status, manual "Sync Now" button, and 15s auto-sync toggle.

---

## Setup & Configuration

### 1. Environment Variables

Create a `.env.local` file inside the `notion-sync` directory:

```env
# Notion Setup
NOTION_TOKEN=secret_your_notion_integration_token
NOTION_TASKS_DB_ID=368e6d69-8017-804e-80ff-cd271324212f

# Google Cloud OAuth Setup
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
GOOGLE_REFRESH_TOKEN=your_google_oauth_refresh_token
```

### 2. How to Run Locally

```bash
cd notion-sync
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser to access the sync dashboard.
