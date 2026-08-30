# Skylark Intelligence — BI Agent for Skylark Drones

A conversational AI business intelligence agent that answers founder-level queries by dynamically reading live data from Monday.com boards.

## Architecture Overview

```
Next.js App (Frontend + Backend)
├── app/
│   ├── page.tsx              # Premium dark-mode chat UI
│   ├── globals.css           # Glassmorphism design system
│   ├── layout.tsx            # Root layout + metadata
│   └── api/chat/route.ts     # Streaming chat API endpoint
├── lib/
│   ├── monday.ts             # Monday.com GraphQL client
│   ├── dataClean.ts          # Data normalization layer
│   └── agent.ts              # AI agent orchestration (Gemini)
├── DECISION_LOG.md           # Key decisions and trade-offs
└── .env.local                # API keys (not committed)
```

**Data Flow:**
1. User types a natural-language question
2. API route classifies the query (Work Orders / Deals / Both)
3. Live data is fetched from Monday.com via GraphQL
4. Data is cleaned and normalized (dates, currencies, sectors)
5. Cleaned data + query is sent to Gemini Flash with streaming
6. Response streams back to the UI in real time

## Monday.com Setup Instructions

### Step 1: Create your Monday.com account
Go to [monday.com](https://monday.com) and sign up for free.

### Step 2: Import the Work Orders board
1. Click **+ Add workspace** or use an existing one
2. Click **+ New** → **Import data** → **Excel / CSV**
3. Upload `Work_Order_Tracker Data.xlsx`
4. Set appropriate column types:
   - `Status` → Status column
   - `Contract Value` → Numbers column
   - `Start Date`, `End Date` → Date columns
   - All other text fields → Text column
5. Click the board in the URL bar — note the number: `monday.com/boards/`**`123456789`**

### Step 3: Import the Deals board
1. Create another new board
2. Import `Deal funnel Data.xlsx`
3. Set column types similarly
4. Note the board ID from the URL

### Step 4: Get your Monday.com API key
1. Click your avatar (top-right) → **Developers**
2. Go to **My Access Tokens**
3. Copy your personal API token

## Setup Instructions

### 1. Clone / Download the project

### 2. Install dependencies
```bash
npm install
```

### 3. Configure environment variables
Copy `.env.example` to `.env.local` and fill in:
```env
GEMINI_API_KEY=AIza...          # From https://aistudio.google.com
MONDAY_API_KEY=eyJ...           # From Monday.com Developers page
WORK_ORDERS_BOARD_ID=123456789  # From board URL
DEALS_BOARD_ID=987654321        # From board URL
```

### 4. Run locally
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000)

## Deployment to Vercel

1. Push code to a GitHub repository
2. Go to [vercel.com](https://vercel.com) → **New Project** → Import your repo
3. Add all environment variables in Vercel's settings panel
4. Click **Deploy** — your app will be live in ~2 minutes!

## Sample Queries

- *"How's our pipeline looking for the energy sector this quarter?"*
- *"Give me a leadership update summary"*
- *"What's our total revenue from completed work orders?"*
- *"Which deals are at risk of being lost?"*
- *"Show me win rate and average deal size"*
- *"What's our operational performance across all sectors?"*

## Tech Stack

| Layer | Technology | Reason |
|---|---|---|
| Framework | Next.js 15 (App Router) | Full-stack, Vercel-native |
| LLM | Google Gemini 1.5 Flash | Free tier, long context |
| Data Source | Monday.com GraphQL API | Read-only, stable |
| UI | Vanilla CSS + ReactMarkdown | Premium control, no bloat |
| Deployment | Vercel | One-click, free |
