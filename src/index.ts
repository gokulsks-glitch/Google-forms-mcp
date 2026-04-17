import "dotenv/config";
import express, { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { google } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3100;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth/callback`;
const TOKEN_FILE = process.env.TOKEN_FILE || join(process.cwd(), ".tokens.json");

const SCOPES = [
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/forms.responses.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.readonly",
];

// ─── OAuth Client & Token Persistence ────────────────────────────────────────

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

function saveTokens(tokens: any) {
  try {
    writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    console.error("[OAuth] Tokens saved to disk");
  } catch (err: any) {
    console.error("[OAuth] Failed to save tokens:", err.message);
  }
}

function loadTokens() {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    const raw = readFileSync(TOKEN_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err: any) {
    console.error("[OAuth] Failed to load tokens:", err.message);
    return null;
  }
}

// Load persisted tokens on startup
const persisted = loadTokens();
if (persisted) {
  oauth2Client.setCredentials(persisted);
  console.error("[OAuth] Loaded persisted tokens from disk");
}

// Auto-save refreshed tokens
oauth2Client.on("tokens", (tokens) => {
  const current = oauth2Client.credentials;
  const merged = { ...current, ...tokens };
  saveTokens(merged);
  console.error("[OAuth] Tokens refreshed and persisted");
});

function isAuthenticated(): boolean {
  const creds = oauth2Client.credentials;
  return !!(creds && (creds.access_token || creds.refresh_token));
}

// ─── Google API Clients (lazily fetched per call) ────────────────────────────

function forms() {
  return google.forms({ version: "v1", auth: oauth2Client });
}

function drive() {
  return google.drive({ version: "v3", auth: oauth2Client });
}

// ─── Tool Registration ───────────────────────────────────────────────────────

function registerTools(server: McpServer) {
  // ── create_form ──
  server.tool(
    "create_form",
    "Create a new Google Form with a title and optional description.",
    {
      title: z.string().describe("The form title"),
      description: z.string().optional().describe("Optional form description"),
    },
    async ({ title, description }) => {
      if (!isAuthenticated()) {
        return { content: [{ type: "text", text: "Not authenticated. Visit /oauth/authorize to sign in." }], isError: true };
      }
      try {
        const res = await forms().forms.create({ requestBody: { info: { title, documentTitle: title } } });
        const formId = res.data.formId!;
        if (description) {
          await forms().forms.batchUpdate({
            formId,
            requestBody: {
              requests: [{ updateFormInfo: { info: { description }, updateMask: "description" } }],
            },
          });
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              formId,
              title,
              responderUri: res.data.responderUri,
              editUri: `https://docs.google.com/forms/d/${formId}/edit`,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── add_questions ──
  server.tool(
    "add_questions",
    "Add one or more questions to an existing Google Form.",
    {
      formId: z.string().describe("The form ID"),
      questions: z.array(z.object({
        title: z.string(),
        type: z.enum(["short_text", "paragraph", "multiple_choice", "checkbox", "dropdown", "scale", "date", "time"]),
        required: z.boolean().optional(),
        options: z.array(z.string()).optional().describe("For multiple_choice, checkbox, dropdown"),
        scaleLow: z.number().optional(),
        scaleHigh: z.number().optional(),
        scaleLowLabel: z.string().optional(),
        scaleHighLabel: z.string().optional(),
      })).describe("Array of questions to add"),
      insertAt: z.number().optional().describe("Insert index (default: append)"),
    },
    async ({ formId, questions, insertAt }) => {
      if (!isAuthenticated()) {
        return { content: [{ type: "text", text: "Not authenticated." }], isError: true };
      }
      try {
        const form = await forms().forms.get({ formId });
        const startIndex = insertAt ?? (form.data.items?.length ?? 0);

        const requests = questions.map((q, i) => {
          let questionObj: any = { required: q.required ?? false };
          if (q.type === "short_text") questionObj.textQuestion = { paragraph: false };
          else if (q.type === "paragraph") questionObj.textQuestion = { paragraph: true };
          else if (q.type === "date") questionObj.dateQuestion = {};
          else if (q.type === "time") questionObj.timeQuestion = {};
          else if (q.type === "scale") {
            questionObj.scaleQuestion = {
              low: q.scaleLow ?? 1,
              high: q.scaleHigh ?? 5,
              lowLabel: q.scaleLowLabel,
              highLabel: q.scaleHighLabel,
            };
          } else {
            const typeMap: Record<string, string> = { multiple_choice: "RADIO", checkbox: "CHECKBOX", dropdown: "DROP_DOWN" };
            questionObj.choiceQuestion = {
              type: typeMap[q.type],
              options: (q.options ?? []).map((v) => ({ value: v })),
            };
          }
          return {
            createItem: {
              item: { title: q.title, questionItem: { question: questionObj } },
              location: { index: startIndex + i },
            },
          };
        });

        await forms().forms.batchUpdate({ formId, requestBody: { requests } });
        return { content: [{ type: "text", text: `Added ${questions.length} question(s) to form ${formId}.` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── add_section ──
  server.tool(
    "add_section",
    "Add a page break / section header to a form.",
    {
      formId: z.string(),
      title: z.string(),
      description: z.string().optional(),
      insertAt: z.number().optional(),
    },
    async ({ formId, title, description, insertAt }) => {
      if (!isAuthenticated()) return { content: [{ type: "text", text: "Not authenticated." }], isError: true };
      try {
        const form = await forms().forms.get({ formId });
        const index = insertAt ?? (form.data.items?.length ?? 0);
        await forms().forms.batchUpdate({
          formId,
          requestBody: {
            requests: [{ createItem: { item: { title, description, pageBreakItem: {} }, location: { index } } }],
          },
        });
        return { content: [{ type: "text", text: `Section "${title}" added at index ${index}.` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── add_text_item ──
  server.tool(
    "add_text_item",
    "Add a text block (no question) to the form.",
    {
      formId: z.string(),
      title: z.string(),
      description: z.string().optional(),
      insertAt: z.number().optional(),
    },
    async ({ formId, title, description, insertAt }) => {
      if (!isAuthenticated()) return { content: [{ type: "text", text: "Not authenticated." }], isError: true };
      try {
        const form = await forms().forms.get({ formId });
        const index = insertAt ?? (form.data.items?.length ?? 0);
        await forms().forms.batchUpdate({
          formId,
          requestBody: {
            requests: [{ createItem: { item: { title, description, textItem: {} }, location: { index } } }],
          },
        });
        return { content: [{ type: "text", text: `Text item added at index ${index}.` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── get_form ──
  server.tool(
    "get_form",
    "Retrieve the full structure of a Google Form.",
    { formId: z.string() },
    async ({ formId }) => {
      if (!isAuthenticated()) return { content: [{ type: "text", text: "Not authenticated." }], isError: true };
      try {
        const res = await forms().forms.get({ formId });
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── get_responses ──
  server.tool(
    "get_responses",
    "Retrieve all responses submitted to a Google Form.",
    { formId: z.string() },
    async ({ formId }) => {
      if (!isAuthenticated()) return { content: [{ type: "text", text: "Not authenticated." }], isError: true };
      try {
        const res = await forms().forms.responses.list({ formId });
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── update_form_settings ──
  server.tool(
    "update_form_settings",
    "Update form settings (quiz mode currently supported).",
    {
      formId: z.string(),
      isQuiz: z.boolean().optional(),
    },
    async ({ formId, isQuiz }) => {
      if (!isAuthenticated()) return { content: [{ type: "text", text: "Not authenticated." }], isError: true };
      try {
        const requests: any[] = [];
        if (typeof isQuiz === "boolean") {
          requests.push({
            updateSettings: {
              settings: { quizSettings: { isQuiz } },
              updateMask: "quizSettings.isQuiz",
            },
          });
        }
        if (requests.length === 0) {
          return { content: [{ type: "text", text: "No settings provided to update." }] };
        }
        await forms().forms.batchUpdate({ formId, requestBody: { requests } });
        return { content: [{ type: "text", text: "Settings updated." }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── delete_item ──
  server.tool(
    "delete_item",
    "Delete an item (question/section/text) from the form by its index.",
    {
      formId: z.string(),
      index: z.number().describe("Zero-based index of the item to delete"),
    },
    async ({ formId, index }) => {
      if (!isAuthenticated()) return { content: [{ type: "text", text: "Not authenticated." }], isError: true };
      try {
        await forms().forms.batchUpdate({
          formId,
          requestBody: { requests: [{ deleteItem: { location: { index } } }] },
        });
        return { content: [{ type: "text", text: `Deleted item at index ${index}.` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── list_forms ──
  server.tool(
    "list_forms",
    "List Google Forms in the authenticated user's Drive.",
    {
      query: z.string().optional().describe("Optional name filter"),
      pageSize: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ query, pageSize }) => {
      if (!isAuthenticated()) return { content: [{ type: "text", text: "Not authenticated." }], isError: true };
      try {
        const q = [`mimeType = 'application/vnd.google-apps.form'`, `trashed = false`];
        if (query) q.push(`name contains '${query.replace(/'/g, "\\'")}'`);
        const res = await drive().files.list({
          q: q.join(" and "),
          pageSize: pageSize ?? 20,
          fields: "files(id, name, createdTime, modifiedTime, webViewLink)",
          orderBy: "modifiedTime desc",
        });
        return { content: [{ type: "text", text: JSON.stringify(res.data.files ?? [], null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/oauth/authorize", (_req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code as string;
  if (!code) return res.status(400).send("Missing authorization code.");
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    saveTokens(tokens);
    res.send(
      `<h1>Authenticated!</h1><p>You may close this window.</p><p>Session time: ${new Date().toISOString()}</p>`
    );
    console.error("[OAuth] Authentication successful");
  } catch (err: any) {
    res.status(500).send(`Authentication failed: ${err.message}`);
  }
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    authenticated: isAuthenticated(),
    server: "google-forms-mcp",
    version: "1.1.0",
    activeSessions: sessions.size,
  });
});

// ─── MCP Endpoint: fresh server per session ──────────────────────────────────

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
}

const sessions = new Map<string, Session>();

// Evict sessions idle for >30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > 30 * 60 * 1000) {
      s.server.close().catch(() => {});
      sessions.delete(id);
      console.error(`[MCP] Evicted idle session: ${id}`);
    }
  }
}, 5 * 60 * 1000);

async function createSession(): Promise<{ session: Session; sessionId: string }> {
  const server = new McpServer({ name: "google-forms", version: "1.1.0" });
  registerTools(server);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);
  const sessionId = transport.sessionId!;
  const session: Session = { transport, server, lastSeen: Date.now() };
  sessions.set(sessionId, session);
  console.error(`[MCP] New session: ${sessionId} (total: ${sessions.size})`);
  return { session, sessionId };
}

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const headerSessionId = req.headers["mcp-session-id"] as string | undefined;
    let session = headerSessionId ? sessions.get(headerSessionId) : undefined;

    if (!session) {
      const result = await createSession();
      session = result.session;
    }
    session.lastSeen = Date.now();
    await session.transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error("[MCP] POST error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: err.message } });
    }
  }
});

app.get("/mcp", async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(400).json({ error: "No active session. POST /mcp first." });
      return;
    }
    session.lastSeen = Date.now();
    await session.transport.handleRequest(req, res);
  } catch (err: any) {
    console.error("[MCP] GET error:", err);
    if (!res.headersSent) res.status(500).end();
  }
});

app.delete("/mcp", async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (session) {
      await session.transport.handleRequest(req, res);
      await session.server.close().catch(() => {});
      sessions.delete(sessionId!);
      console.error(`[MCP] Session closed: ${sessionId}`);
    } else {
      res.status(204).end();
    }
  } catch (err: any) {
    console.error("[MCP] DELETE error:", err);
    if (!res.headersSent) res.status(500).end();
  }
});

// ─── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.error(`
╔══════════════════════════════════════════════════════╗
║         Google Forms MCP Server v1.1.0               ║
╠══════════════════════════════════════════════════════╣
║  MCP Endpoint:  http://localhost:${PORT}/mcp
║  OAuth:         http://localhost:${PORT}/oauth/authorize
║  Health Check:  http://localhost:${PORT}/health
╚══════════════════════════════════════════════════════╝
  `);
});
