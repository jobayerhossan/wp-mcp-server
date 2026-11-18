import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { callWordPress, getSite, publicSites, diagnoseSiteTransport, networkCode } from "./sites.js";
import { canWrite } from "./oauth.js";
import { auditFrontend, compareFrontend, verifyFrontend } from "./frontend-qa.js";

const VERSION = "0.1.0";
function result(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data && typeof data === "object" ? data : { result: data } };
}
function failure(error) {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error?.message ?? String(error), details: error?.details ?? null }, null, 2) }] };
}

const siteSchema = z.string().min(1);
const idSchema = z.number().int().positive();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const changeSchema = z.string().min(1);
const jsonObjectSchema = z.record(z.string(), z.any());
const elementsSchema = z.array(jsonObjectSchema);
const openAIFileSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});
const readAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

function buildMcp() {
  const server = new McpServer(
    { name: "wp-mcp-server", version: VERSION },
    { instructions: "Use read tools to inspect WordPress before changes. For code and Elementor edits, read first and use the returned revision hash/SHA. Prefer targeted Elementor element edits over replacing a full document. Prefer draft status for test content. Use upload_media for attached images and elementor_import_json for attached Elementor JSON files. Rollback tools are available for connector-created changes." },
  );

  function addTool(name, title, description, inputSchema, handler, annotations = readAnnotations, meta = undefined) {
    const descriptor = { title, description, inputSchema, annotations };
    if (meta) descriptor._meta = meta;
    server.registerTool(name, descriptor, async (args) => {
      try { return await handler(args); } catch (error) { return failure(error); }
    });
  }

  addTool("list_sites", "List WordPress sites", "List configured WordPress site aliases without exposing credentials.", z.object({}), async () => result({ sites: await publicSites() }));
  addTool("site_info", "Inspect WordPress site", "Inspect WordPress, PHP, active theme, plugins, and connector capabilities for a configured site.", z.object({ site: siteSchema }), async ({ site }) => {
    try {
      return result(await callWordPress(site, "GET", "/site", undefined));
    } catch (error) {
      if (error?.details?.kind === "network") {
        try { error.details.transport_diagnostics = await diagnoseSiteTransport(await getSite(site)); }
        catch (diagnosticError) { error.details.transport_diagnostics = { error_code: networkCode(diagnosticError) }; }
      }
      throw error;
    }
  });
  addTool("search_code", "Search WordPress code", "Search theme or plugin source before editing it.", z.object({ site: siteSchema, query: z.string().min(1), root: z.enum(["themes", "plugins"]).optional(), path_prefix: z.string().optional() }), async ({ site, query, root, path_prefix }) => result(await callWordPress(site, "POST", "/files/search", { query, root: root ?? "themes", path_prefix: path_prefix ?? "" })));
  addTool("read_file", "Read WordPress file", "Read a theme or plugin source file and return its SHA-256 revision hash.", z.object({ site: siteSchema, path: z.string().min(1), start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional() }), async ({ site, path, start_line, end_line }) => result(await callWordPress(site, "POST", "/files/read", { path, start_line: start_line ?? 1, ...(end_line ? { end_line } : {}) })));
  addTool("patch_file", "Patch WordPress file", "Replace one exact source-code occurrence. The WordPress agent creates a backup and validates PHP when applicable.", z.object({ site: siteSchema, path: z.string().min(1), expected_sha256: hashSchema, old_text: z.string().min(1), new_text: z.string(), occurrence: z.number().int().positive().optional() }), async ({ site, ...payload }) => { if (!canWrite()) throw new Error("patch_file is disabled until writes are enabled"); return result(await callWordPress(site, "POST", "/files/patch", { ...payload, occurrence: payload.occurrence ?? 1 })); }, writeAnnotations);
  addTool("rollback_change", "Rollback code change", "Restore a file backup by connector change ID.", z.object({ site: siteSchema, change_id: changeSchema }), async ({ site, change_id }) => { if (!canWrite()) throw new Error("rollback_change is disabled until writes are enabled"); return result(await callWordPress(site, "POST", "/rollback", { change_id })); }, writeAnnotations);
  addTool("search_content", "Search WordPress content", "Search posts, pages, and visible custom post types.", z.object({ site: siteSchema, query: z.string().optional(), post_type: z.string().optional(), status: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }), async ({ site, query, post_type, status, limit }) => result(await callWordPress(site, "POST", "/content/search", { query: query ?? "", post_type: post_type ?? "any", status: status ?? "any", limit: limit ?? 20 })));
  addTool("get_content", "Read WordPress content", "Read a post, page, or visible custom post type item with Rank Math SEO fields and revision hash.", z.object({ site: siteSchema, id: idSchema }), async ({ site, id }) => result(await callWordPress(site, "POST", "/content/get", { id })));

  const contentFields = z.object({ title: z.string().optional(), slug: z.string().optional(), excerpt: z.string().optional(), content: z.string().optional(), status: z.enum(["draft", "pending", "private", "publish", "future"]).optional() }).optional();
  const rankMathFields = z.object({ title: z.string().optional(), description: z.string().optional(), focus_keyword: z.string().optional(), canonical_url: z.string().optional(), robots: z.string().optional() }).optional();

  addTool("create_content", "Create WordPress content", "Create a post, page, or visible custom post type item. Use draft status for tests unless the user explicitly asks to publish.", z.object({ site: siteSchema, post_type: z.string().optional(), author_id: idSchema.optional(), fields: contentFields, rank_math: rankMathFields }), async ({ site, post_type, author_id, fields, rank_math }) => { if (!canWrite()) throw new Error("create_content is disabled until writes are enabled"); return result(await callWordPress(site, "POST", "/content/create", { post_type: post_type ?? "post", fields: fields ?? {}, rank_math: rank_math ?? {}, ...(author_id ? { author_id } : {}) })); }, writeAnnotations);
  addTool("update_content", "Update WordPress content", "Update post/page content or Rank Math SEO fields using revision protection.", z.object({ site: siteSchema, id: idSchema, expected_revision_hash: hashSchema, fields: contentFields, rank_math: rankMathFields }), async ({ site, ...payload }) => { if (!canWrite()) throw new Error("update_content is disabled until writes are enabled"); return result(await callWordPress(site, "POST", "/content/update", { ...payload, fields: payload.fields ?? {}, rank_math: payload.rank_math ?? {} })); }, writeAnnotations);
  addTool("rollback_content", "Rollback content update", "Rollback a content or SEO snapshot using its change ID and current revision hash.", z.object({ site: siteSchema, change_id: changeSchema, expected_revision_hash: hashSchema }), async ({ site, change_id, expected_revision_hash }) => { if (!canWrite()) throw new Error("rollback_content is disabled until writes are enabled"); return result(await callWordPress(site, "POST", "/content/rollback", { change_id, expected_revision_hash })); }, writeAnnotations);
  addTool("rollback_created_content", "Remove connector-created content", "Move connector-created content to Trash if it has not changed since creation.", z.object({ site: siteSchema, change_id: changeSchema, expected_revision_hash: hashSchema }), async ({ site, change_id, expected_revision_hash }) => { if (!canWrite()) throw new Error("rollback_created_content is disabled until writes are enabled"); return result(await callWordPress(site, "POST", "/content/create/rollback", { change_id, expected_revision_hash })); }, writeAnnotations);
  addTool(
    "upload_media",
    "Upload image to WordPress Media Library",
    "Upload a user-provided image to the WordPress Media Library. Use this when the user attaches or selects an image they want stored on a connected WordPress site. WordPress downloads the temporary ChatGPT file URL and validates the file as JPEG, PNG, WebP, or GIF before creating the attachment.",
    z.object({
      site: siteSchema,
      file: openAIFileSchema,
      title: z.string().optional(),
      alt_text: z.string().optional(),
      caption: z.string().optional(),
      description: z.string().optional(),
      post_id: idSchema.optional(),
      set_featured: z.boolean().optional(),
    }),
    async ({ site, file, title, alt_text, caption, description, post_id, set_featured }) => {
      if (!canWrite()) throw new Error("upload_media is disabled until writes are enabled");
      return result(await callWordPress(site, "POST", "/media/upload", {
        source_url: file.download_url,
        filename: file.file_name ?? "",
        title: title ?? "",
        alt_text: alt_text ?? "",
        caption: caption ?? "",
        description: description ?? "",
        ...(post_id ? { post_id } : {}),
        set_featured: Boolean(set_featured),
      }));
    },
    writeAnnotations,
    { "openai/fileParams": ["file"] },
  );

  addTool("elementor_get_document", "Read Elementor document", "Read an Elementor page/template with page settings, full element tree, element count, and revision hash. Read this before editing.", z.object({ site: siteSchema, id: idSchema }), async ({ site, id }) => result(await callWordPress(site, "POST", "/elementor/document/get", { id })));
  addTool("elementor_create_document", "Create Elementor document", "Create a page, post, supported custom post type, or Elementor library template using native Elementor elements.", z.object({ site: siteSchema, title: z.string().optional(), slug: z.string().optional(), status: z.enum(["draft", "pending", "private", "publish"]).optional(), post_type: z.string().optional(), template_type: z.string().optional(), author_id: idSchema.optional(), elements: elementsSchema.optional(), page_settings: jsonObjectSchema.optional() }), async ({ site, ...payload }) => { if (!canWrite()) throw new Error("elementor_create_document is disabled until writes are enabled"); return result(await callWordPress(site, "POST", "/elementor/document/create", { ...payload, status: payload.status ?? "draft", post_type: payload.post_type ?? "page", elements: payload.elements ?? [], page_settings: payload.page_settings ?? {} })); }, writeAnnotations);
  addTool("elementor_update_document", "Replace Elementor document", "Replace a full Elementor element tree using revision protection. Prefer targeted element tools for small revisions.", z.object({ site: siteSchema, id: idSchema, expected_revision_hash: hashSchema, elements: elementsSchema, page_settings: jsonObjectSchema.optional() }), async ({ site, ...payload }) => { if (!canWrite()) throw new Error("elementor_update_document is disabled until writes are enabled"); return result(await callWordPress(site, "POST", "/elementor/document/update", payload)); }, writeAnnotations);
  addTool("elementor_get_element", "Read Elementor element", "Find one Elementor widget/container by its element ID and return it with the document revision hash.", z.object({ site: siteSchema, id: idSchema, element_id: z.string().min(1) }), async ({ site, id, element_id }) => result(await callWordPress(site, "POST", "/elementor/element/get", { id, element_id })));
  addTool("elementor_update_element", "Update Elementor element", "Update one widget/container settings without replacing the rest of the Elementor page. Merge is the default settings mode.", z.object({ site: siteSchema, id: idSchema, expected_revision_hash: hashSchema, element_id: z.string().min(1), settings: jsonObjectSchema.optional(), settings_mode: z.enum(["merge", "replace"]).optional(), widget_type: z.string().optional() }), async ({ site, ...payload }) => { if (!canWrite()) throw new Error("elementor_update_element is disabled until writes are enabled"); return result(await callWordPress(site, "POST", "/elementor/element/update", { ...payload, settings_mode: payload.settings_mode ?? "merge" })); }, writeAnnotations);
  addTool("elementor_add_element", "Add Elementor element", "Add a native Elementor widget/container at the document root or inside a parent element. Missing element IDs are generated by WordPress.", z.object({ site: siteSchema, id: idSchema, expected_revision_hash: hashSchema, parent_id: z.string().optional(), position: z.number().int().min(0).optional(), element: jsonObjectSchema }), async ({ site, ...payload }) => { if (!canWrite()) throw new Error("elementor_add_element is disabled until writes are enabled"); return result(await callWordPress(site, "POST", "/elementor/element/add", payload)); }, writeAnnotations);
  addTool("elementor_delete_element", "Delete Elementor element", "Delete one Elementor widget/container and its children using revision protection.", z.object({ site: siteSchema, id: idSchema, expected_revision_hash: hashSchema, element_id: z.string().min(1) }), async ({ site, ...payload }) => { if (!canWrite()) throw new Error("elementor_delete_element is disabled until writes are enabled"); return result(await callWordPress(site, "POST", "/elementor/element/delete", payload)); }, writeAnnotations);
  addTool("elementor_move_element", "Move Elementor element", "Move an Elementor widget/container to a new parent or root position without changing its settings.", z.object({ site: siteSchema, id: idSchema, expected_revision_hash: hashSchema, element_id: z.string().min(1), new_parent_id: z.string().optional(), position: z.number().int().min(0).optional() }), async ({ site, ...payload }) => { if (!canWrite()) throw new Error("elementor_move_element is disabled until writes are enabled"); return result(await callWordPress(site, "POST", "/elementor/element/move", payload)); }, writeAnnotations);
  addTool("elementor_validate_json", "Validate Elementor JSON", "Validate Elementor template JSON before import. Accepts pasted JSON or an attached JSON file.", z.object({ site: siteSchema, template_json: z.string().optional(), file: openAIFileSchema.optional() }), async ({ site, template_json, file }) => { if (!template_json && !file) throw new Error("Provide template_json or file"); return result(await callWordPress(site, "POST", "/elementor/json/validate", { json: template_json ?? "", ...(file ? { source_url: file.download_url } : {}) })); }, readAnnotations, { "openai/fileParams": ["file"] });
  addTool("elementor_import_json", "Import Elementor JSON", "Import Elementor JSON into an existing document or create a new Elementor document. For an existing document, read it first and pass its revision hash.", z.object({ site: siteSchema, template_json: z.string().optional(), file: openAIFileSchema.optional(), post_id: idSchema.optional(), expected_revision_hash: hashSchema.optional(), title: z.string().optional(), slug: z.string().optional(), status: z.enum(["draft", "pending", "private", "publish"]).optional(), post_type: z.string().optional(), template_type: z.string().optional() }), async ({ site, template_json, file, post_id, expected_revision_hash, ...rest }) => { if (!canWrite()) throw new Error("elementor_import_json is disabled until writes are enabled"); if (!template_json && !file) throw new Error("Provide template_json or file"); if (post_id && !expected_revision_hash) throw new Error("expected_revision_hash is required when importing into an existing document"); return result(await callWordPress(site, "POST", "/elementor/json/import", { json: template_json ?? "", ...(file ? { source_url: file.download_url } : {}), ...(post_id ? { post_id } : {}), ...(expected_revision_hash ? { expected_revision_hash } : {}), ...rest, status: rest.status ?? "draft", post_type: rest.post_type ?? "page" })); }, writeAnnotations, { "openai/fileParams": ["file"] });
  addTool("elementor_export_json", "Export Elementor JSON", "Export an Elementor document as reusable Elementor template JSON.", z.object({ site: siteSchema, id: idSchema }), async ({ site, id }) => result(await callWordPress(site, "POST", "/elementor/json/export", { id })));
  addTool("elementor_regenerate_css", "Regenerate Elementor CSS", "Regenerate the CSS file for one Elementor document after edits or when styles appear stale.", z.object({ site: siteSchema, id: idSchema }), async ({ site, id }) => { if (!canWrite()) throw new Error("elementor_regenerate_css is disabled until writes are enabled"); return result(await callWordPress(site, "POST", "/elementor/css/regenerate", { id })); }, writeAnnotations);
  addTool("elementor_rollback", "Rollback Elementor change", "Rollback a connector-created Elementor change using its change ID and the document's current revision hash. Created documents are moved to Trash.", z.object({ site: siteSchema, change_id: changeSchema, expected_revision_hash: hashSchema }), async ({ site, change_id, expected_revision_hash }) => { if (!canWrite()) throw new Error("elementor_rollback is disabled until writes are enabled"); return result(await callWordPress(site, "POST", "/elementor/rollback", { change_id, expected_revision_hash })); }, writeAnnotations);

  addTool("check_url", "Check WordPress URL", "Check a same-site URL after a change.", z.object({ site: siteSchema, path: z.string().optional(), method: z.enum(["GET", "HEAD"]).optional() }), async ({ site, path, method }) => result(await callWordPress(site, "POST", "/runtime/url/check", { path: path ?? "/", method: method ?? "GET" })));
  const frontendReportSchema = z.object({ schema: z.literal("wpmcp.frontend.v1"), url: z.string().max(2048), viewport: jsonObjectSchema, elements: z.array(jsonObjectSchema).max(400), problems: z.array(jsonObjectSchema).max(100).optional() }).passthrough();
  const designRuleSchema = z.object({ id: z.string().optional(), className: z.string().optional(), property: z.string().min(1), expected: z.union([z.string(), z.number()]), tolerance: z.number().min(0).max(100).optional() });
  addTool("frontend_inspect", "Get browser-based frontend inspector", "Return free browser-console inspector JavaScript. Run only in your own browser on an authorized page, then paste the resulting JSON into frontend_audit. No Chromium on Hostinger.", z.object({}), async () => result({ instructions: "Open the page in your browser, press F12, run this script in the Console, then paste the copied JSON report into frontend_audit. Inspect desktop and mobile by resizing the viewport and running it again.", javascript: readFileSync(new URL("./frontend-qa-browser.js", import.meta.url),"utf8") }));
  addTool("frontend_audit", "Audit measured frontend", "Inspect browser-produced DOM geometry, computed styles, image loads and horizontal overflow. This does not replace screenshot visual review.", z.object({ report: frontendReportSchema }), async ({report}) => result(auditFrontend(report)));
  addTool("frontend_compare", "Compare frontend with design spec", "Compare measured element properties with explicit design specs; does not infer specifications from screenshots.", z.object({report:frontendReportSchema,expectations:z.array(designRuleSchema).max(100)}), async ({report,expectations}) => result(compareFrontend(report,expectations)));
  addTool("frontend_verify", "Verify frontend revisions", "Compare before/after measurement reports for the same URL and evaluate explicit design specifications after Elementor changes.", z.object({previous:frontendReportSchema,current:frontendReportSchema,expectations:z.array(designRuleSchema).max(100).optional()}), async ({previous,current,expectations}) => result(verifyFrontend(previous,current,expectations??[])));
  return server;
}

export { buildMcp };
