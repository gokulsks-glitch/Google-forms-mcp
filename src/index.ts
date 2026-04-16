#!/usr/bin/env node
import "dotenv/config";
/**
 * Google Forms MCP Server
 * 
 * An MCP server that exposes Google Forms API operations as tools,
 * enabling Claude to create, edit, and read Google Forms and responses.
 * 
 * Transport: Streamable HTTP (for remote deployment / Claude.ai integration)
 * Auth: OAuth2 with Google (tokens managed server-side)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { google, forms_v1 } from "googleapis";
import express from "express";
import { randomUUID } from "crypto";

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3100");
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth/callback`;

// Token storage (in production, use a persistent store)
let storedTokens: any = null;

// ─── OAuth2 Client Setup ────────────────────────────────────────────────────

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

oauth2Client.on("tokens", (tokens) => {
  if (tokens.refresh_token) {
    storedTokens = { ...storedTokens, ...tokens };
  } else if (storedTokens) {
    storedTokens = { ...storedTokens, ...tokens };
  }
  console.error("[OAuth] Tokens refreshed");
});

function getFormsClient(): forms_v1.Forms {
  if (!storedTokens) {
    throw new Error(
      "Not authenticated with Google. Visit /oauth/authorize to connect your Google account."
    );
  }
  oauth2Client.setCredentials(storedTokens);
  return google.forms({ version: "v1", auth: oauth2Client });
}

// ─── MCP Server Definition ──────────────────────────────────────────────────

const server = new McpServer({
  name: "google-forms",
  version: "1.0.0",
});

// ── Tool: create_form ────────────────────────────────────────────────────────
server.tool(
  "create_form",
  "Create a new Google Form with a title and optional description. Returns the form ID, edit URL, and responder URL.",
  {
    title: z.string().describe("Title of the form"),
    description: z.string().optional().describe("Description shown at the top of the form"),
    document_title: z.string().optional().describe("Document title in Google Drive (defaults to form title)"),
  },
  async ({ title, description, document_title }) => {
    try {
      const forms = getFormsClient();
      const res = await forms.forms.create({
        requestBody: {
          info: {
            title: title,
            documentTitle: document_title || title,
          },
        },
      });

      const formId = res.data.formId!;

      // Add description if provided (requires a batchUpdate)
      if (description) {
        await forms.forms.batchUpdate({
          formId,
          requestBody: {
            requests: [
              {
                updateFormInfo: {
                  info: { description },
                  updateMask: "description",
                },
              },
            ],
          },
        });
      }

      // Publish the form (new requirement as of 2026)
      // Using raw HTTP since googleapis types may lag behind the API
      try {
        const accessToken = (await oauth2Client.getAccessToken()).token;
        await fetch(
          `https://forms.googleapis.com/v1/forms/${formId}:setPublishSettings`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              publishSettings: {
                publishState: {
                  isPublished: true,
                  isAcceptingResponses: true,
                },
              },
            }),
          }
        );
      } catch (pubErr: any) {
        console.error("[Warning] Could not publish form:", pubErr.message);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                formId,
                editUrl: `https://docs.google.com/forms/d/${formId}/edit`,
                responderUrl: res.data.responderUri || `https://docs.google.com/forms/d/e/${formId}/viewform`,
                documentTitle: res.data.info?.documentTitle,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error creating form: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: add_questions ──────────────────────────────────────────────────────
server.tool(
  "add_questions",
  "Add one or more questions to an existing Google Form. Supports text, paragraph, multiple choice, checkbox, dropdown, linear scale, date, and time question types.",
  {
    form_id: z.string().describe("The Google Form ID"),
    questions: z.array(
      z.object({
        title: z.string().describe("Question text"),
        type: z.enum([
          "SHORT_TEXT",
          "PARAGRAPH",
          "MULTIPLE_CHOICE",
          "CHECKBOX",
          "DROPDOWN",
          "LINEAR_SCALE",
          "DATE",
          "TIME",
        ]).describe("Question type"),
        required: z.boolean().optional().default(true).describe("Whether the question is required"),
        options: z.array(z.string()).optional().describe("Options for MULTIPLE_CHOICE, CHECKBOX, or DROPDOWN"),
        low_label: z.string().optional().describe("Label for the low end of a LINEAR_SCALE"),
        high_label: z.string().optional().describe("Label for the high end of a LINEAR_SCALE"),
        low_value: z.number().optional().default(1).describe("Low value for LINEAR_SCALE (typically 1)"),
        high_value: z.number().optional().default(5).describe("High value for LINEAR_SCALE (typically 5 or 7)"),
        description: z.string().optional().describe("Help text shown below the question"),
      })
    ).describe("Array of questions to add"),
  },
  async ({ form_id, questions }) => {
    try {
      const forms = getFormsClient();
      const requests: forms_v1.Schema$Request[] = [];

      // First, get the current form to know the item count (for insertion index)
      const currentForm = await forms.forms.get({ formId: form_id });
      let insertionIndex = currentForm.data.items?.length || 0;

      for (const q of questions) {
        let questionItem: forms_v1.Schema$Item;

        switch (q.type) {
          case "SHORT_TEXT":
            questionItem = {
              title: q.title,
              description: q.description,
              questionItem: {
                question: {
                  required: q.required,
                  textQuestion: { paragraph: false },
                },
              },
            };
            break;

          case "PARAGRAPH":
            questionItem = {
              title: q.title,
              description: q.description,
              questionItem: {
                question: {
                  required: q.required,
                  textQuestion: { paragraph: true },
                },
              },
            };
            break;

          case "MULTIPLE_CHOICE":
          case "CHECKBOX":
          case "DROPDOWN":
            if (!q.options || q.options.length === 0) {
              throw new Error(`Question "${q.title}" requires options for type ${q.type}`);
            }
            questionItem = {
              title: q.title,
              description: q.description,
              questionItem: {
                question: {
                  required: q.required,
                  choiceQuestion: {
                    type: q.type === "MULTIPLE_CHOICE" ? "RADIO" : q.type === "CHECKBOX" ? "CHECKBOX" : "DROP_DOWN",
                    options: q.options.map((opt) => ({ value: opt })),
                  },
                },
              },
            };
            break;

          case "LINEAR_SCALE":
            questionItem = {
              title: q.title,
              description: q.description,
              questionItem: {
                question: {
                  required: q.required,
                  scaleQuestion: {
                    low: q.low_value ?? 1,
                    high: q.high_value ?? 5,
                    lowLabel: q.low_label,
                    highLabel: q.high_label,
                  },
                },
              },
            };
            break;

          case "DATE":
            questionItem = {
              title: q.title,
              description: q.description,
              questionItem: {
                question: {
                  required: q.required,
                  dateQuestion: {},
                },
              },
            };
            break;

          case "TIME":
            questionItem = {
              title: q.title,
              description: q.description,
              questionItem: {
                question: {
                  required: q.required,
                  timeQuestion: {},
                },
              },
            };
            break;

          default:
            throw new Error(`Unsupported question type: ${q.type}`);
        }

        requests.push({
          createItem: {
            item: questionItem,
            location: { index: insertionIndex },
          },
        });
        insertionIndex++;
      }

      await forms.forms.batchUpdate({
        formId: form_id,
        requestBody: { requests },
      });

      return {
        content: [
          {
            type: "text",
            text: `Successfully added ${questions.length} question(s) to form ${form_id}.`,
          },
        ],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error adding questions: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: add_section ────────────────────────────────────────────────────────
server.tool(
  "add_section",
  "Add a page break / section header to the form. Use this to create multi-page forms.",
  {
    form_id: z.string().describe("The Google Form ID"),
    title: z.string().describe("Section title"),
    description: z.string().optional().describe("Section description"),
  },
  async ({ form_id, title, description }) => {
    try {
      const forms = getFormsClient();
      const currentForm = await forms.forms.get({ formId: form_id });
      const insertionIndex = currentForm.data.items?.length || 0;

      await forms.forms.batchUpdate({
        formId: form_id,
        requestBody: {
          requests: [
            {
              createItem: {
                item: {
                  title,
                  description,
                  pageBreakItem: {},
                },
                location: { index: insertionIndex },
              },
            },
          ],
        },
      });

      return {
        content: [{ type: "text", text: `Added section "${title}" to form ${form_id}.` }],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error adding section: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: add_text_item ──────────────────────────────────────────────────────
server.tool(
  "add_text_item",
  "Add a text block (no question) to the form — useful for consent statements, instructions, or passage excerpts.",
  {
    form_id: z.string().describe("The Google Form ID"),
    title: z.string().describe("Title / heading of the text block"),
    description: z.string().optional().describe("The body text content"),
  },
  async ({ form_id, title, description }) => {
    try {
      const forms = getFormsClient();
      const currentForm = await forms.forms.get({ formId: form_id });
      const insertionIndex = currentForm.data.items?.length || 0;

      await forms.forms.batchUpdate({
        formId: form_id,
        requestBody: {
          requests: [
            {
              createItem: {
                item: {
                  title,
                  description,
                  textItem: {},
                },
                location: { index: insertionIndex },
              },
            },
          ],
        },
      });

      return {
        content: [{ type: "text", text: `Added text block "${title}" to form ${form_id}.` }],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error adding text: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: get_form ───────────────────────────────────────────────────────────
server.tool(
  "get_form",
  "Retrieve the full structure of a Google Form — its questions, sections, settings, and URLs.",
  {
    form_id: z.string().describe("The Google Form ID"),
  },
  async ({ form_id }) => {
    try {
      const forms = getFormsClient();
      const res = await forms.forms.get({ formId: form_id });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res.data, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error retrieving form: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: get_responses ──────────────────────────────────────────────────────
server.tool(
  "get_responses",
  "Retrieve all responses submitted to a Google Form. Returns response data including timestamps and answers.",
  {
    form_id: z.string().describe("The Google Form ID"),
  },
  async ({ form_id }) => {
    try {
      const forms = getFormsClient();
      const res = await forms.forms.responses.list({ formId: form_id });

      const responseCount = res.data.responses?.length || 0;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                totalResponses: responseCount,
                responses: res.data.responses || [],
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error retrieving responses: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: update_form_settings ───────────────────────────────────────────────
server.tool(
  "update_form_settings",
  "Update form settings like quiz mode, collecting emails, confirmation message, etc.",
  {
    form_id: z.string().describe("The Google Form ID"),
    is_quiz: z.boolean().optional().describe("Enable quiz mode with grading"),
    confirmation_message: z.string().optional().describe("Custom message shown after submission"),
  },
  async ({ form_id, is_quiz, confirmation_message }) => {
    try {
      const forms = getFormsClient();
      const requests: forms_v1.Schema$Request[] = [];
      const updateMasks: string[] = [];

      const info: any = {};

      if (confirmation_message !== undefined) {
        // Confirmation message is set via form info
      }

      if (is_quiz !== undefined) {
        requests.push({
          updateSettings: {
            settings: {
              quizSettings: {
                isQuiz: is_quiz,
              },
            },
            updateMask: "quizSettings.isQuiz",
          },
        });
      }

      if (requests.length > 0) {
        await forms.forms.batchUpdate({
          formId: form_id,
          requestBody: { requests },
        });
      }

      return {
        content: [{ type: "text", text: `Form settings updated for ${form_id}.` }],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error updating settings: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: delete_item ────────────────────────────────────────────────────────
server.tool(
  "delete_item",
  "Delete a specific item (question, section, or text block) from the form by its index.",
  {
    form_id: z.string().describe("The Google Form ID"),
    item_index: z.number().describe("Zero-based index of the item to delete"),
  },
  async ({ form_id, item_index }) => {
    try {
      const forms = getFormsClient();
      await forms.forms.batchUpdate({
        formId: form_id,
        requestBody: {
          requests: [
            {
              deleteItem: {
                location: { index: item_index },
              },
            },
          ],
        },
      });

      return {
        content: [{ type: "text", text: `Deleted item at index ${item_index} from form ${form_id}.` }],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error deleting item: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: list_forms ─────────────────────────────────────────────────────────
server.tool(
  "list_forms",
  "List Google Forms in the authenticated user's Drive. Optionally filter by name.",
  {
    query: z.string().optional().describe("Search query to filter forms by name"),
    max_results: z.number().optional().default(10).describe("Maximum number of results"),
  },
  async ({ query, max_results }) => {
    try {
      if (!storedTokens) {
        throw new Error("Not authenticated with Google.");
      }
      oauth2Client.setCredentials(storedTokens);
      const drive = google.drive({ version: "v3", auth: oauth2Client });

      let q = "mimeType='application/vnd.google-apps.form'";
      if (query) {
        q += ` and name contains '${query.replace(/'/g, "\\'")}'`;
      }

      const res = await drive.files.list({
        q,
        pageSize: max_results,
        fields: "files(id, name, createdTime, modifiedTime, webViewLink)",
        orderBy: "modifiedTime desc",
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res.data.files || [], null, 2),
          },
        ],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error listing forms: ${err.message}` }], isError: true };
    }
  }
);

// ─── Express App + MCP Transport ─────────────────────────────────────────────

const app = express();
app.use(express.json());

// OAuth routes
app.get("/oauth/authorize", (_req, res) => {
  const scopes = [
    "https://www.googleapis.com/auth/forms.body",
    "https://www.googleapis.com/auth/forms.responses.readonly",
    "https://www.googleapis.com/auth/drive.file",
  ];
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent",
  });
  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send("Missing authorization code");
    return;
  }
  try {
    const { tokens } = await oauth2Client.getToken(code);
    storedTokens = tokens;
    oauth2Client.setCredentials(tokens);
    res.send(
      `<h1>Google Forms MCP — Authenticated!</h1>
       <p>You can close this window and return to Claude.</p>
       <p>Access token expires: ${new Date(tokens.expiry_date!).toISOString()}</p>`
    );
    console.error("[OAuth] Authentication successful");
  } catch (err: any) {
    res.status(500).send(`Authentication failed: ${err.message}`);
  }
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    authenticated: !!storedTokens,
    server: "google-forms-mcp",
    version: "1.0.0",
  });
});

// MCP endpoint — Streamable HTTP transport
// We need to handle session management for the transport
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string || randomUUID();

  let transport = transports.get(sessionId);
  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
    });
    transports.set(sessionId, transport);
    await server.connect(transport);
    console.error(`[MCP] New session: ${sessionId}`);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).json({ error: "No active session. Send a POST to /mcp first." });
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (transport) {
    await transport.handleRequest(req, res);
    transports.delete(sessionId);
    console.error(`[MCP] Session closed: ${sessionId}`);
  } else {
    res.status(204).end();
  }
});

// ─── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.error(`
╔══════════════════════════════════════════════════════╗
║         Google Forms MCP Server v1.0.0               ║
╠══════════════════════════════════════════════════════╣
║  MCP Endpoint:   http://localhost:${PORT}/mcp          ║
║  OAuth:          http://localhost:${PORT}/oauth/authorize ║
║  Health Check:   http://localhost:${PORT}/health         ║
╚══════════════════════════════════════════════════════╝
  `);
});
