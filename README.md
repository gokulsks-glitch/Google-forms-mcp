# Google Forms MCP Server

An MCP (Model Context Protocol) server that connects Claude to the Google Forms API, enabling form creation, editing, and response retrieval directly from conversations.

## Features / Tools

| Tool | Description |
|------|-------------|
| `create_form` | Create a new Google Form with title and description |
| `add_questions` | Add questions (text, multiple choice, checkbox, dropdown, scale, date, time) |
| `add_section` | Add page breaks / section headers for multi-page forms |
| `add_text_item` | Add non-question text blocks (consent statements, instructions, excerpts) |
| `get_form` | Retrieve full form structure |
| `get_responses` | Retrieve all submitted responses |
| `update_form_settings` | Update quiz mode and other settings |
| `delete_item` | Remove a question or section by index |
| `list_forms` | Search Google Forms in your Drive |

## Prerequisites

- Node.js 18+ 
- A Google Cloud project with the Google Forms API enabled
- OAuth2 credentials (Web Application type)

## Setup

### 1. Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or select an existing one)
3. Enable the **Google Forms API**:
   - Navigate to APIs & Services > Library
   - Search for "Google Forms API"
   - Click Enable
4. Also enable the **Google Drive API** (needed for listing forms):
   - Search for "Google Drive API"
   - Click Enable
5. Create OAuth2 credentials:
   - Go to APIs & Services > Credentials
   - Click "Create Credentials" > "OAuth client ID"
   - Application type: **Web Application**
   - Name: "Google Forms MCP"
   - Authorized redirect URIs: `http://localhost:3100/oauth/callback`
   - Copy the Client ID and Client Secret
6. Configure the OAuth consent screen:
   - Go to APIs & Services > OAuth consent screen
   - Choose "External" user type
   - Fill in the app name, support email
   - Add scopes: `forms.body`, `forms.responses.readonly`, `drive.file`
   - Add your Google account as a test user

### 2. Install & Configure

```bash
git clone <this-repo>
cd google-forms-mcp
npm install
cp env.example .env
# Edit .env with your Client ID and Client Secret
```

### 3. Build & Run

```bash
npm run build
npm start
```

### 4. Authenticate

Visit `http://localhost:3100/oauth/authorize` in your browser. Sign in with your Google account and grant permissions. You'll be redirected back with a success message.

### 5. Connect to Claude

For Claude.ai, add this as a custom MCP server with the URL:
```
http://localhost:3100/mcp
```

For remote deployment (Railway, Render, etc.), update the URL accordingly and ensure HTTPS.

## Deployment

For Claude.ai to reach your MCP server, it needs to be publicly accessible. Options:

- **ngrok** (quick testing): `ngrok http 3100`
- **Railway** / **Render** (free tier available): Push the repo, set env vars
- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:3100`

When deploying remotely, update `GOOGLE_REDIRECT_URI` in both your `.env` and Google Cloud Console to match your public URL.

## Accessibility Notes

This server was designed with screen reader users in mind:
- All tool responses are plain text / JSON (no visual-only content)
- Form creation is fully programmatic — no mouse interaction needed
- Error messages are descriptive and actionable

## License

MIT
